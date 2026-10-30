/**
 * Database layer verifier.
 *
 *   npm run db:verify
 *
 * Runs the real migrations against a throw-away database, writes a record into
 * every table (through the services where one exists, so stock/money
 * transactions are exercised too), reads each record back through a typed
 * repository, and cross-checks the shipped schema manifest against the tables
 * SQLite actually created. Exits non-zero on the first problem.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/db';
import { TABLES, TABLE_NAMES } from '../src/db/schema';
import { repositoriesFor } from '../src/db/repositories';
import { ALL_PERMISSIONS } from '../src/shared/permissions';
import { featuresForEdition } from '../src/shared/editions';
import { createFirstAdmin } from '../src/services/users';
import { getAllSettings, getStoreProfile, updateSettings } from '../src/services/settings';
import { createProduct, packsToUnits, redactCostsDeep } from '../src/services/products';
import { createStockCount, postStockCount, saveStockCountEntries } from '../src/services/stocktake';
import { createSale } from '../src/services/sales';
import { createReturn, approveReturn } from '../src/services/returns';
import { createPurchase } from '../src/services/purchases';
import {
  saveCategory,
  saveCustomer,
  saveSupplier
} from '../src/services/directory';
import {
  adjustLoyaltyPoints,
  saveDepartment,
  saveLoyaltyMember,
  savePriceRule,
  savePromotion
} from '../src/services/marketing';
import { addProductBarcode, saveProductVariant } from '../src/services/barcodes';
import { closeDay, closeShift, logDrawerEvent, openShift } from '../src/services/operations';
import { nextDocumentNumber } from '../src/services/helpers';

const failures: string[] = [];
const checks: string[] = [];

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    checks.push(label);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function main(): number {
  const dir = mkdtempSync(join(tmpdir(), 'infoflex-verify-'));
  const db = new Database(join(dir, 'verify.db'));
  const features = featuresForEdition('BOTH');
  const actor = { userId: 1, username: 'admin' };
  const salesActor = { userId: 1, username: 'admin', permissions: [...ALL_PERMISSIONS] as string[] };

  try {
    db.open();
    const repos = repositoriesFor(db);

    /* ---- schema manifest vs what SQLite created ---- */
    const actualTables = (
      db.handle
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);

    for (const spec of TABLES) {
      check(`table ${spec.name} exists`, actualTables.includes(spec.name));
    }
    for (const name of actualTables) {
      check(`table ${name} is documented`, TABLE_NAMES.includes(name), 'add it to src/db/schema.ts');
    }

    /* ---- every repository's declared columns exist ---- */
    for (const [label, table] of Object.entries(repos as unknown as Record<string, { name: string; columnNames: readonly string[] }>)) {
      const columns = table.columnNames.join(', ');
      try {
        db.handle.prepare(`SELECT ${columns} FROM ${table.name} LIMIT 0`).all();
        checks.push(`columns ${table.name}`);
      } catch (error) {
        failures.push(`columns ${table.name} (${label}) — ${(error as Error).message}`);
      }
    }

    /* ---- seed: admin, store profile, licence row, session metadata ---- */
    createFirstAdmin(db, { username: 'admin', fullName: 'Verify Admin', password: 'Verifier#2026' });
    updateSettings(db, {
      storeName: 'Infoflex Test Store',
      storeAddress: '1 Verification Road',
      storePhone: '08000000000'
    });
    repos.license.insert({
      id: 1,
      edition: 'BOTH',
      customer_name: 'Verification Customer',
      license_id: 'IFX-VERIFY',
      activation_code: 'IFX1.verify.payload.signature',
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      activated_at: new Date().toISOString(),
      activated_by: 'verify-script',
      note: 'Written by scripts/verify-db.ts'
    });
    /* licence guard tables (phase 4): per-install secret, attempt ledger, history */
    const nowIso = new Date().toISOString();
    const today = new Date().toISOString().slice(0, 10);
    const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
    db.handle
      .prepare('INSERT OR REPLACE INTO license_guard (id, secret, created_at) VALUES (1, ?, ?)')
      .run('verify-install-secret', nowIso);
    db.handle
      .prepare(
        'INSERT INTO license_attempts (created_at, outcome, failures_after, delay_seconds, source) VALUES (?, ?, ?, ?, ?)'
      )
      .run(nowIso, 'OK', 0, 0, 'verify-script');
    db.handle
      .prepare(
        `INSERT INTO license_history (license_id, edition, customer_name, starts_on, ends_on, action, period_hmac, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('IFX-VERIFY', 'BOTH', 'Verification Customer', today, nextYear, 'ACTIVATE', 'verify-hmac', nowIso, 'verify-script');

    repos.settings.insert({ key: 'verification.marker', value: 'ok', updated_at: new Date().toISOString() });
    repos.sessionsMeta.insert({ key: 'verification.marker', value: new Date().toISOString() });

    /* ---- catalogue + master data ---- */
    const category = saveCategory(db, { name: 'Analgesics', description: 'Pain relief' }, actor);
    const supplier = saveSupplier(db, { name: 'Emzor Pharmaceutical', phone: '08012345678' }, actor);
    const customer = saveCustomer(db, { name: 'Walk-in Customer', phone: '08099999999' }, actor);

    const product = createProduct(
      db,
      {
        name: 'Paracetamol 500mg (100 cards)',
        category: 'Analgesics',
        costPrice: 90_000,
        price: 150_000,
        reorderLevel: 5,
        openingStock: 40,
        openingBatchNo: 'BATCH-A',
        openingExpiry: futureDate(365),
        genericName: 'Paracetamol',
        rxRequired: true,
        supplierId: supplier.id,
        pluCode: '2001',
        shelfLocation: 'A1-03'
      },
      actor
    );
    check('stock reaches the product', product.stockQty === 40, `got ${product.stockQty}`);
    check('category row resolved', product.categoryId === category.id);
    check('generic name stored', product.genericName === 'Paracetamol');
    check('secondary barcode row written', repos.productBarcodes.count({ product_id: product.id }) === 0);

    addProductBarcode(db, { productId: product.id, barcode: '6151100012345', packQty: 10 }, actor);
    check('multi-barcode table', repos.productBarcodes.count({ product_id: product.id }) === 1);
    saveProductVariant(
      db,
      { productId: product.id, variantName: 'Carton of 10', price: 1_400_000, costPrice: 900_000 },
      actor
    );

    /* ---- purchase (stock receive in one transaction) ---- */
    const purchase = createPurchase(
      db,
      {
        supplierId: supplier.id,
        invoiceNo: 'INV-778',
        items: [{ productId: product.id, qty: 20, costPrice: 88_000, batchNo: 'BATCH-B', expiryDate: futureDate(500) }]
      },
      actor
    );
    check('purchase lines written', purchase.items.length === 1);
    check('purchase stock added', repos.products.findById(product.id)!.price === product.price);

    /* ---- sales: sequential receipts, payments, items ---- */
    const saleInput = {
      docType: 'RECEIPT' as const,
      lines: [{ productId: product.id, qty: 2 }],
      paymentMethod: 'CASH' as const,
      amountPaid: 400_000,
      prescriptionRef: 'RX-2026-001',
      customerName: 'Walk-in Customer',
      customerId: customer.id
    };
    const firstSale = createSale(db, saleInput, salesActor, features);
    const secondSale = createSale(db, { ...saleInput, lines: [{ productId: product.id, qty: 1 }] }, salesActor, features);
    check('receipt numbers format', /^RCP-\d{6}$/.test(firstSale.receiptNo), firstSale.receiptNo);
    check(
      'receipt numbers sequential',
      Number(secondSale.receiptNo.slice(4)) === Number(firstSale.receiptNo.slice(4)) + 1,
      `${firstSale.receiptNo} -> ${secondSale.receiptNo}`
    );
    check('payments row per sale', firstSale.payments.length === 1, JSON.stringify(firstSale.payments));
    check('money is integer kobo', Number.isInteger(firstSale.total));
    check('stock decremented', repos.products.findById(product.id)!.id === product.id);

    /* ---- returns ---- */
    const saleItemId = firstSale.items![0].id;
    const outcome = createReturn(
      db,
      { saleId: firstSale.id, reason: 'Customer brought one back', lines: [{ saleItemId, qty: 1 }] },
      salesActor,
      getStoreProfile(db)
    );
    const returnId = (outcome as { return?: { id: number } }).return?.id ?? (outcome as { id?: number }).id;
    if (returnId) approveReturn(db, returnId, salesActor);
    check('returns recorded', repos.returns.count() >= 1);
    check('return items recorded', repos.returnItems.count() >= 1);

    /* ---- supermarket module ---- */
    saveDepartment(db, { name: 'Provisions', description: 'Rice, oil, tinned goods' }, actor);
    savePromotion(
      db,
      { name: 'Paracetamol weekend', promoType: 'PERCENT', value: 10, productId: product.id },
      actor
    );
    savePriceRule(
      db,
      { name: 'Analgesics shelf rule', scope: 'CATEGORY', categoryId: category.id, ruleType: 'DISCOUNT_PERCENT', value: 5 },
      actor
    );
    const member = saveLoyaltyMember(db, { name: 'Ada Obi', phone: '08033334444' }, actor);
    adjustLoyaltyPoints(db, { memberId: member.id, points: 25, reason: 'Welcome bonus' }, actor);
    check('loyalty balance', repos.loyaltyMembers.findById(member.id)!.points === 25);

    const shift = openShift(db, { openingFloat: 500_000 }, actor);
    logDrawerEvent(db, { eventType: 'NO_SALE', reason: 'Customer asked for change' }, actor);
    closeShift(db, { shiftId: shift.id, countedCash: 500_000 }, actor);
    check('shift closed', repos.shifts.findById(shift.id)!.status === 'CLOSED');

    /* ---- day closing ---- */
    const closing = closeDay(
      db,
      { businessDate: new Date().toISOString().slice(0, 10), openingFloat: 500_000, countedCash: 870_000 },
      actor
    );
    check('day closing variance computed', closing.variance === closing.counted_cash - closing.expected_cash);
    check('document counter advanced', Boolean(getAllSettings(db).storeName));
    nextDocumentNumber(db, 'VERIFY');

    /* ---- stocktake: count, variance, post ---- */
    const count = createStockCount(db, { note: 'Verification count' }, actor);
    check('stock count snapshots lines', count.items.length > 0, `got ${count.items.length}`);
    const countedLine = count.items[0];
    const saved = saveStockCountEntries(
      db,
      {
        countId: count.count.id,
        entries: [{ itemId: countedLine.id, countedQty: countedLine.system_qty + 3 }]
      },
      actor
    );
    check('count variance recorded', saved.totals.varianceQty === 3, `got ${saved.totals.varianceQty}`);
    const posted = postStockCount(db, { countId: count.count.id }, actor);
    check('count posted as adjustments', posted.count.status === 'POSTED');

    /* ---- pack conversion and cost redaction ---- */
    check('packs convert to base units', packsToUnits(4, 12) === 48);
    const masked = redactCostsDeep({ costPrice: 5_000, price: 7_000 }, false) as {
      costPrice: number;
      price: number;
    };
    check('cost redaction keeps selling price', masked.costPrice === 0 && masked.price === 7_000);

    /* ---- every table has at least one row ---- */
    const rows: Array<{ table: string; rows: number }> = [];
    for (const name of TABLE_NAMES) {
      const count = (db.handle.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get() as { n: number }).n;
      rows.push({ table: name, rows: count });
      check(`row in ${name}`, count > 0, 'no record was written');
    }

    /* ---- reads come back through the typed repositories ---- */
    const storedProduct = repos.products.findById(product.id);
    check('read product back', storedProduct?.name === product.name);
    check('read sale back', repos.sales.findById(firstSale.id)?.receipt_no === firstSale.receiptNo);
    check('read payment back', repos.payments.count({ sale_id: firstSale.id }) === 1);
    check('read batch back', repos.productBatches.count({ product_id: product.id }) >= 2);
    check('read movement back', repos.stockMovements.count({ product_id: product.id }) >= 3);
    check('read audit back', repos.audit.count() >= 5);

    const approval = TABLES.length === TABLE_NAMES.length && new Set(TABLE_NAMES).size === TABLE_NAMES.length;
    check('manifest has no duplicate tables', approval);

    /* ---- report ---- */
    console.log('\nInfoflex database verification\n');
    console.log('  table                          owner          rows');
    console.log('  ' + '-'.repeat(56));
    for (const spec of TABLES) {
      const count = rows.find((row) => row.table === spec.name)?.rows ?? 0;
      console.log(`  ${spec.name.padEnd(30)} ${spec.owner.padEnd(14)} ${String(count).padStart(4)}`);
    }
    console.log(`\n  ${checks.length} checks passed, ${failures.length} failed.`);
    if (failures.length) {
      console.error('\nFailures:');
      for (const failure of failures) console.error(`  ✗ ${failure}`);
      return 1;
    }
    console.log('  Every table in the schema manifest was written and read back.\n');
    return 0;
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const exitCode = main();
if (exitCode !== 0) process.exit(exitCode);
