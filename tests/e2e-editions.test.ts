/**
 * Phase 10 — end-to-end journeys, once per edition.
 *
 * Each journey drives the real IPC handlers (the same ones the renderer calls)
 * against a fresh database: activate, first-run setup, sign in as each role,
 * sell, print, return, report, lock, renew. Nothing is stubbed, so a failure
 * here is a failure a shop would see.
 */
import { describe, expect, it } from 'vitest';
import type {
  Edition,
  Product,
  ReportResult,
  Sale,
  SaleReturn,
  SessionInfo
} from '../src/shared/types';
import {
  callErr,
  callOk,
  controllableClock,
  createHarness,
  requireMasterPassword,
  type Harness
} from './helpers';

const MASTER = () => requireMasterPassword();

const EDITIONS: Edition[] = ['PHARMACY', 'SUPERMARKET'];

interface Shop {
  h: Harness;
  clock: ReturnType<typeof controllableClock>;
  admin: SessionInfo;
  storeName: string;
}

interface Activated {
  h: Harness;
  clock: ReturnType<typeof controllableClock>;
  storeName: string;
  admin?: SessionInfo;
}

const STORE: Record<Edition, string> = {
  PHARMACY: 'Grace Pharmacy Ikeja',
  SUPERMARKET: 'Sunmart Lekki',
  BOTH: 'Grace Mart Ikeja'
};

/** Activation only: the shop has a licence but no store profile yet. */
async function activateShop(edition: Edition, days = 365): Promise<Activated> {
  const clock = controllableClock();
  const h = createHarness({ now: clock.now });
  await callOk(h, 'license.activate', {
    masterPassword: MASTER(),
    edition,
    customerName: 'Infoflex Test Customer',
    expiresAt: new Date(clock.current().getTime() + days * 86_400_000).toISOString()
  });
  return { h, clock, storeName: STORE[edition] };
}

/** First-run setup: the store name and the first administrator. */
async function setupShop(shop: Activated): Promise<Shop> {
  await callOk(shop.h, 'setup.complete', {
    storeName: shop.storeName,
    storeAddress: '12 Allen Avenue, Ikeja, Lagos',
    storePhone: '0803 000 0000',
    adminUsername: 'admin',
    adminFullName: 'Ada Admin',
    adminPassword: 'adminpass123'
  });
  const admin = await callOk<SessionInfo>(shop.h, 'auth.login', { username: 'admin', password: 'adminpass123' });
  return { ...shop, admin };
}

async function openShop(edition: Edition, days = 365): Promise<Shop> {
  return setupShop(await activateShop(edition, days));
}

async function makeProduct(shop: Shop, edition: Edition): Promise<Product> {
  const base = {
    name: edition === 'SUPERMARKET' ? 'Golden Penny Semovita 1kg' : 'Paracetamol 500mg (100)',
    category: edition === 'SUPERMARKET' ? 'Flour & Grains' : 'Analgesics',
    costPrice: 95_000,
    price: 135_000,
    wholesalePrice: 120_000,
    wholesaleMinQty: 10,
    reorderLevel: 5,
    openingStock: 40,
    openingBatchNo: 'E2E-1',
    openingExpiry: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10)
  };
  const payload =
    edition === 'SUPERMARKET'
      ? { ...base, unit: 'bag', departmentId: null }
      : { ...base, unit: 'pack', genericName: 'Paracetamol' };
  return callOk<Product>(shop.h, 'products.create', payload, shop.admin.token);
}

describe.each(EDITIONS)('%s — activation, setup, sale, return, reports', (edition) => {
  it('walks the whole first day end to end', async () => {
    const activated = await activateShop(edition);
    const { h } = activated;

    /* ---- activation ---- */
    const status = await callOk<{ state: string; edition: Edition; usable: boolean }>(h, 'license.status');
    expect(status.state).toBe('VALID');
    expect(status.usable).toBe(true);
    expect(status.edition).toBe(edition);

    const app = await callOk<{
      features: { pharmacy: boolean; supermarket: boolean; productName: string; edition: string };
      setup: { setupRequired: boolean };
      session: unknown;
    }>(h, 'app.state');
    expect(app.features.edition).toBe(edition);
    expect(app.features.pharmacy).toBe(edition !== 'SUPERMARKET');
    expect(app.features.supermarket).toBe(edition !== 'PHARMACY');
    // The product name follows the edition, never a hard-coded one.
    expect(app.features.productName).toBe(
      edition === 'SUPERMARKET' ? 'Infoflex Mart' : edition === 'PHARMACY' ? 'Infoflex Pharm' : 'Infoflex Pharm & Mart'
    );
    // Nothing is set up yet, and a nameless shop cannot be set up at all.
    expect(app.setup.setupRequired).toBe(true);

    /* ---- first-run setup rules ---- */
    const emptyName = await callErr(h, 'setup.complete', {
      storeName: '   ',
      storeAddress: '1 Test Road',
      storePhone: '0803 111 1111',
      adminUsername: 'admin',
      adminFullName: 'Ada Admin',
      adminPassword: 'adminpass123'
    });
    expect(emptyName.code).toBe('VALIDATION');
    expect(emptyName.message.toLowerCase()).toContain('store name');

    // A real setup then works, and signs the administrator straight in.
    const shop = await setupShop(activated);
    const admin = shop.admin;
    // Setup cannot be run twice either.
    const twice = await callErr(h, 'setup.complete', {
      storeName: 'Another Shop',
      adminUsername: 'admin3',
      adminFullName: 'Third Admin',
      adminPassword: 'adminpass789'
    });
    expect(['CONFLICT', 'FORBIDDEN']).toContain(twice.code);

    /* ---- login for each role ---- */
    const wrong = await callErr(h, 'auth.login', { username: 'admin', password: 'not-the-password' });
    expect(wrong.code).toBe('UNAUTHENTICATED');

    const cashier = await callOk<{ id: number }>(
      h,
      'users.create',
      { username: 'cashier1', fullName: 'Grace Cashier', role: 'CASHIER', password: 'cashierpass1' },
      admin.token
    );
    expect(cashier.id).toBeGreaterThan(0);
    const cashierFirst = await callOk<{ token: string; mustChangePassword: boolean; role: string }>(h, 'auth.login', {
      username: 'cashier1',
      password: 'cashierpass1'
    });
    expect(cashierFirst.role).toBe('CASHIER');
    expect(cashierFirst.mustChangePassword).toBe(true);
    const blocked = await callErr(h, 'products.list', {}, cashierFirst.token);
    expect(blocked.code).toBe('FORBIDDEN');
    await callOk(h, 'auth.changePassword', { newPassword: 'cashierpass2' }, cashierFirst.token);
    const cashierSession = await callOk<SessionInfo>(h, 'auth.login', {
      username: 'cashier1',
      password: 'cashierpass2'
    });
    expect(cashierSession.mustChangePassword).toBe(false);
    // A cashier cannot add users or change prices.
    const cashierAddsUser = await callErr(
      h,
      'users.create',
      { username: 'sneaky', fullName: 'Sneaky User', role: 'SUPERVISOR', password: 'sneakypass1' },
      cashierSession.token
    );
    expect(cashierAddsUser.code).toBe('FORBIDDEN');

    let supervisor: SessionInfo | null = null;
    if (edition !== 'PHARMACY') {
      await callOk(
        h,
        'users.create',
        { username: 'supervisor1', fullName: 'Sam Supervisor', role: 'SUPERVISOR', password: 'supervisorpass1' },
        admin.token
      );
      const first = await callOk<{ token: string }>(h, 'auth.login', { username: 'supervisor1', password: 'supervisorpass1' });
      await callOk(h, 'auth.changePassword', { newPassword: 'supervisorpass2' }, first.token);
      supervisor = await callOk<SessionInfo>(h, 'auth.login', { username: 'supervisor1', password: 'supervisorpass2' });
      expect(supervisor.role).toBe('SUPERVISOR');
      // Supervisors may approve, not administer.
      const supervisorCannotAdd = await callErr(
        h,
        'users.create',
        { username: 'another', fullName: 'Another User', role: 'CASHIER', password: 'anotherpass1' },
        supervisor.token
      );
      expect(supervisorCannotAdd.code).toBe('FORBIDDEN');
    } else {
      // A pharmacy licence has no supervisor role at all.
      const noSupervisor = await callErr(
        h,
        'users.create',
        { username: 'supervisor1', fullName: 'Sam Supervisor', role: 'SUPERVISOR', password: 'supervisorpass1' },
        admin.token
      );
      expect(noSupervisor.code).toBe('EDITION_RESTRICTED');
    }

    /* ---- a sale to a printed receipt ---- */
    const product = await makeProduct(shop, edition);
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 2 }],
        paymentMethod: 'CASH',
        amountPaid: 500_000
      },
      cashierSession.token
    );
    expect(sale.total).toBe(270_000); // 2 × ₦1,350.00
    expect(sale.storeName).toBe(shop.storeName);
    expect(sale.receiptNo).toMatch(/^RCP-/);

    const doc = await callOk<{ html: string }>(h, 'sales.document', { id: sale.id }, cashierSession.token);
    expect(doc.html).toContain(shop.storeName);
    expect(doc.html).toContain('12 Allen Avenue');
    expect(doc.html).toContain('₦1,350.00');
    expect(doc.html).toContain(sale.receiptNo);

    // Printing twice marks the second copy DUPLICATE; the store name never changes.
    const print1 = await callOk<{ html: string; duplicate: boolean }>(h, 'pos.print', { id: sale.id }, cashierSession.token);
    const print2 = await callOk<{ html: string; duplicate: boolean }>(h, 'pos.print', { id: sale.id }, cashierSession.token);
    expect(print1.duplicate).toBe(false);
    expect(print2.duplicate).toBe(true);
    expect(print2.html).toContain(shop.storeName);

    /* ---- a return with a credit note ---- */
    const ret = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      { saleId: sale.id, lines: [{ saleItemId: sale.items![0].id, qty: 1 }], reason: 'Customer changed mind' },
      admin.token
    );
    expect(ret.pending).toBe(false);
    expect(ret.value.total).toBe(135_000);
    const note = await callOk<{ html: string }>(h, 'returns.document', { id: ret.value.id }, admin.token);
    expect(note.html).toContain(shop.storeName);
    expect(note.html).toContain(ret.value.creditNoteNo);

    /* ---- reports ---- */
    const daily = await callOk<ReportResult>(
      h,
      'reports.build',
      { kind: 'DAILY_SUMMARY', from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) },
      admin.token
    );
    expect(daily.html).toContain(shop.storeName);
    expect(daily.totals.gross).toBe(270_000);
    expect(daily.totals.returns).toBe(135_000);
    expect(daily.meta['Net sales (ex VAT)']).toBe(135_000);

    /* ---- edition modules are mounted only where they belong ---- */
    if (edition === 'SUPERMARKET') {
      const noPharmacy = await callErr(h, 'pharmacy.expiryWatch', {}, admin.token);
      expect(noPharmacy.code).toBe('EDITION_RESTRICTED');
      const departments = await callOk<unknown[]>(h, 'mart.departments.list', {}, admin.token);
      expect(Array.isArray(departments)).toBe(true);
      void supervisor;
    } else {
      const noMart = await callErr(h, 'mart.departments.list', {}, admin.token);
      expect(noMart.code).toBe('EDITION_RESTRICTED');
      const watch = await callOk<unknown[]>(h, 'pharmacy.expiryWatch', {}, admin.token);
      expect(Array.isArray(watch)).toBe(true);
    }

    h.close();
  });

  it('locks when the licence expires and unlocks on renewal', async () => {
    const shop = await openShop(edition, 30);
    const { h, clock } = shop;
    const product = await makeProduct(shop, edition);

    // Sell while the licence is good.
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'CASH', amountPaid: 200_000 },
      shop.admin.token
    );
    expect(sale.receiptNo).toMatch(/^RCP-/);

    // A month later the period has ended.
    clock.advanceDays(31);
    const expired = await callOk<{ state: string; usable: boolean }>(h, 'license.status');
    expect(expired.state).toBe('EXPIRED');
    expect(expired.usable).toBe(false);

    // The month away also ended the sign-in, exactly as the idle timeout would.
    const stale = await callErr(h, 'products.list', {}, shop.admin.token);
    expect(['LICENSE_EXPIRED', 'UNAUTHENTICATED']).toContain(stale.code);
    const cannotSell = await callErr(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'CASH', amountPaid: 200_000 },
      shop.admin.token
    );
    expect(cannotSell.code).toBe('LICENSE_EXPIRED');

    // The vendor renews with the same edition for another year.
    const renewal = await callOk<{ state: string; usable: boolean; edition: Edition }>(h, 'license.activate', {
      masterPassword: MASTER(),
      edition,
      startsOn: clock.current().toISOString().slice(0, 10),
      endsOn: new Date(clock.current().getTime() + 365 * 86_400_000).toISOString().slice(0, 10),
      customerName: 'Infoflex Test Customer'
    });
    expect(renewal.state).toBe('VALID');
    expect(renewal.usable).toBe(true);

    // Trading resumes after signing in again, with the old data intact.
    const adminSession = await callOk<SessionInfo>(h, 'auth.login', { username: 'admin', password: 'adminpass123' });
    const products = await callOk<Product[]>(h, 'products.list', {}, adminSession.token);
    expect(products.some((row) => row.id === product.id)).toBe(true);
    const newSale = await callOk<Sale>(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'CASH', amountPaid: 200_000 },
      adminSession.token
    );
    expect(newSale.receiptNo).not.toBe(sale.receiptNo);

    // Both periods are in the history.
    const history = await callOk<{ edition: string }[]>(h, 'license.history', {}, adminSession.token);
    expect(history.length).toBeGreaterThanOrEqual(2);
    h.close();
  });
});

describe('BOTH — one licence, both modules', () => {
  it('sells a pharmacy item and a weighed supermarket item in the same shop', async () => {
    const shop = await openShop('BOTH');
    const { h, admin } = shop;

    const pharmacyProduct = await callOk<Product>(
      h,
      'products.create',
      {
        name: 'Amoxicillin 500mg (21)',
        category: 'Antibiotics',
        unit: 'pack',
        costPrice: 90_000,
        price: 180_000,
        openingStock: 10,
        openingBatchNo: 'BOTH-1',
        openingExpiry: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)
      },
      admin.token
    );

    const department = await callOk<{ id: number }>(h, 'mart.departments.save', { name: 'Groceries' }, admin.token);
    const rice = await callOk<Product>(
      h,
      'products.create',
      {
        name: 'Long Grain Rice (per kg)',
        category: 'Fresh Produce',
        unit: 'kg',
        costPrice: 105_000,
        price: 140_000,
        pricePerKg: 140_000,
        isWeighed: true,
        pluCode: '00101',
        departmentId: department.id,
        openingStock: 50_000,
        openingBatchNo: 'DEFAULT'
      },
      admin.token
    );

    // 1.5 kg of rice scans from the scale, then both lines sell together.
    const scan = await callOk<{ product: Product; scannedQty: number | null } | null>(
      h,
      'products.scan',
      { code: '20010101500' },
      admin.token
    );
    expect(scan?.product.id).toBe(rice.id);
    expect(scan?.scannedQty).toBe(1500);

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [
          { productId: pharmacyProduct.id, qty: 1 },
          { productId: rice.id, qty: 1500 }
        ],
        paymentMethod: 'CASH',
        amountPaid: 500_000
      },
      admin.token
    );
    // ₦1,800.00 + 1.5 × ₦1,400.00 = ₦3,900.00
    expect(sale.total).toBe(390_000);
    const doc = await callOk<{ html: string }>(h, 'sales.document', { id: sale.id }, admin.token);
    expect(doc.html).toContain(shop.storeName);
    expect(doc.html).toContain('Long Grain Rice');

    // Both edition modules answer on a BOTH licence.
    await callOk(h, 'pharmacy.expiryWatch', {}, admin.token);
    await callOk(h, 'mart.departments.list', {}, admin.token);
    h.close();
  });
});
