/**
 * End-to-end smoke test against a running app instance.
 *
 * It drives the SAME HTTP bridge the UI uses (the Electron build swaps that for
 * IPC), so it exercises the real main-process guards, database transactions and
 * document rendering.
 *
 *   npm run dev:web                       # in one terminal
 *   VENDOR_MASTER_PASSWORD='...' npm run smoke
 *
 * The vendor master password is read from the environment and never stored.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const MASTER = process.env.VENDOR_MASTER_PASSWORD ?? '';

let token: string | null = null;
let passed = 0;
let failed = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];

function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  if (ok) passed += 1;
  else failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function api<T>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${BASE}/api/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, payload: { ...payload, token } })
  });
  const body = (await response.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
  if (!body.ok) throw new Error(`${channel}: [${body.error.code}] ${body.error.message}`);
  return body.data;
}

async function expectError(
  channel: string,
  payload: Record<string, unknown>,
  code: string
): Promise<void> {
  try {
    await api(channel, payload);
    throw new Error(`expected ${code}, call succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(`[${code}]`)) throw error;
  }
}

async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    record(name, true);
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error));
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  if (!MASTER) {
    console.error('Set VENDOR_MASTER_PASSWORD to run the smoke test.');
    process.exit(1);
  }

  const stamp = Date.now().toString().slice(-6);

  await check('health endpoint answers', async () => {
    const response = await fetch(`${BASE}/api/health`);
    assert(response.ok, 'health request failed');
  });

  await check('app starts unlicensed with no product branding', async () => {
    const state = await api<{ license: { state: string }; productName: string }>('app.state');
    assert(state.license.state === 'NONE', `licence was ${state.license.state}`);
    assert(state.productName === 'Infoflex', 'unlicensed product name should be Infoflex');
  });

  await check('wrong master password is rejected', async () => {
    await expectError('license.activate', {
      masterPassword: 'nope-nope-nope',
      edition: 'PHARMACY',
      customerName: 'Should Fail',
      expiresAt: new Date(Date.now() + 31_536_000_000).toISOString()
    }, 'FORBIDDEN');
  });

  const expiry = new Date(Date.now() + 365 * 86_400_000).toISOString();
  await check('activates PHARMACY edition with master password', async () => {
    const status = await api<{
      state: string;
      productName: string;
      edition: string;
      startsOn: string;
      endsOn: string;
      usable: boolean;
      daysRemaining: number;
    }>('license.activate', {
      masterPassword: MASTER,
      edition: 'PHARMACY',
      customerName: 'Grace Pharmacy Ikeja',
      expiresAt: expiry
    });
    assert(status.state === 'VALID', `state ${status.state}`);
    assert(status.productName === 'Infoflex Pharm', 'wrong product name');
    assert(status.usable === true, 'licence should be usable');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(status.startsOn), `start date ${status.startsOn}`);
    assert(status.endsOn > status.startsOn, 'end date must be after the start date');
    assert(status.daysRemaining > 300, `days remaining ${status.daysRemaining}`);
  });

  await check('refuses an end date of today (the app would lock immediately)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await expectError(
      'license.activate',
      { masterPassword: MASTER, edition: 'PHARMACY', startsOn: today, endsOn: today },
      'VALIDATION'
    );
  });

  await check('first-run setup requires a store name', async () => {
    await expectError(
      'setup.complete',
      { storeName: '', adminUsername: 'admin', adminFullName: 'Ada Obi', adminPassword: 'adminpass123' },
      'VALIDATION'
    );
  });

  await check('completes first-run setup', async () => {
    const setup = await api<{ setupRequired: boolean }>('setup.complete', {
      storeName: 'Grace Pharmacy',
      storeAddress: '12 Allen Avenue, Ikeja, Lagos',
      storePhone: '0803 000 0000',
      adminUsername: 'admin',
      adminFullName: 'Ada Obi',
      adminPassword: 'adminpass123'
    });
    assert(!setup.setupRequired, 'setup still required');
  });

  await check('admin signs in and permissions are scoped', async () => {
    const session = await api<{ token: string; role: string; permissions: string[] }>('auth.login', {
      username: 'admin',
      password: 'adminpass123'
    });
    token = session.token;
    assert(session.role === 'ADMIN', 'role');
    assert(session.permissions.includes('prices.set'), 'missing price permission');
  });

  await check('barcode/product lookup and catalogue', async () => {
    const products = await Promise.all([
      api<{ id: number }>('products.create', {
        name: 'Paracetamol 500mg (x10)',
        barcode: '6151100012345',
        category: 'Analgesics',
        unit: 'pack',
        costPrice: 50_000,
        price: 80_000,
        wholesalePrice: 70_000,
        reorderLevel: 10,
        openingStock: 60,
        openingBatchNo: 'PCM-2401',
        openingExpiry: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)
      }),
      api<{ id: number }>('products.create', {
        name: 'Amoxicillin 500mg',
        category: 'Antibiotics',
        unit: 'capsule',
        costPrice: 120_000,
        price: 180_000,
        reorderLevel: 5,
        rxRequired: true,
        openingStock: 24,
        openingBatchNo: 'AMX-9',
        openingExpiry: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10)
      }),
      api<{ id: number }>('products.create', {
        name: 'Vitamin C 1000mg',
        category: 'Supplements',
        costPrice: 150_000,
        price: 250_000,
        reorderLevel: 4,
        openingStock: 3
      })
    ]);
    const found = await api<{ name: string } | null>('products.lookup', { code: '6151100012345' });
    assert(found?.name === 'Paracetamol 500mg (x10)', 'barcode lookup failed');
    const list = await api<unknown[]>('products.list', {});
    assert(list.length === products.length, 'catalogue size mismatch');
  });

  await check('bulk import: dry run reports problems, then imports the clean rows', async () => {
    const csv = [
      'SKU,Name,Brand,Unit,Pack Size,Cost Price,Retail Price,Reorder Level,Opening Stock',
      'IMP-1,"Imported Tonic",Emzor,bottle,12,"2,000.00","3,000.00",6,24',
      'IMP-2,,,,,,,,'
    ].join('\r\n');
    const before = await api<unknown[]>('products.list', {});
    const dry = await api<{ mode: string; validRows: number; errors: unknown[] }>('products.import', {
      filename: 'smoke.csv',
      data: csv,
      encoding: 'utf8',
      mode: 'DRY_RUN'
    });
    assert(dry.mode === 'DRY_RUN' && dry.validRows === 1, 'dry run did not validate the sheet');
    assert(dry.errors.length >= 1, 'dry run did not report the bad row');
    const afterDry = await api<unknown[]>('products.list', {});
    assert(afterDry.length === before.length, 'dry run wrote products');

    const applied = await api<{ created: number }>('products.import', {
      filename: 'smoke.csv',
      data: csv,
      encoding: 'utf8',
      mode: 'IMPORT'
    });
    assert(applied.created === 1, 'import did not create the product');
    const after = await api<unknown[]>('products.list', {});
    assert(after.length === before.length + 1, 'import did not persist');
  });

  await check('export, template and pack-aware stock receipt', async () => {
    const csv = await api<{ encoding: string; rows: number; data: string }>('products.export', { format: 'CSV' });
    assert(csv.encoding === 'utf8' && csv.data.includes('Name'), 'CSV export failed');
    const template = await api<{ encoding: string; data: string }>('products.exportTemplate', {});
    assert(template.encoding === 'base64' && template.data.length > 100, 'template export failed');

    const [imported] = await api<Array<{ id: number; packSize: number; stockQty: number }>>('products.list', {
      search: 'Imported Tonic'
    });
    assert(imported.packSize === 12, 'pack size not imported');
    const received = await api<{ receivedQty: number; product: { stockQty: number } }>('stock.receive', {
      productId: imported.id,
      packs: 2
    });
    assert(received.receivedQty === 24, `pack conversion wrong: ${received.receivedQty}`);
    assert(received.product.stockQty === 48, 'stock not added');
  });

  await check('stock adjustments need a reason and are audited', async () => {
    const [imported] = await api<Array<{ id: number; stockQty: number }>>('products.list', {
      search: 'Imported Tonic'
    });
    await expectError(
      'stock.adjust',
      { productId: imported.id, removeQty: 1, reasonType: 'DAMAGED', reason: '' },
      'VALIDATION'
    );
    const adjusted = await api<{ delta: number; after: number }>('stock.adjust', {
      productId: imported.id,
      removeQty: 2,
      reasonType: 'DAMAGED',
      reason: 'Bottles broken in transit'
    });
    assert(adjusted.delta === -2, 'adjustment delta wrong');
    const ledger = await api<Array<{ type: string; reasonType: string }>>('stock.ledger', {
      productId: imported.id
    });
    assert(ledger[0].type === 'ADJUSTMENT' && ledger[0].reasonType === 'DAMAGED', 'adjustment not in ledger');
  });

  await check('cost prices are hidden from non-admin roles', async () => {
    const created = await api<{ id: number }>('users.create', {
      username: `viewer${stamp}`,
      fullName: 'Ngozi Viewer',
      role: 'CASHIER',
      password: 'viewerpass1'
    });
    assert(created.id > 0, 'viewer not created');
    const first = await api<{ token: string }>('auth.login', { username: `viewer${stamp}`, password: 'viewerpass1' });
    const adminToken = token;
    token = first.token;
    try {
      await api('auth.changePassword', { newPassword: 'viewerpass2' });
      const session = await api<{ token: string }>('auth.login', { username: `viewer${stamp}`, password: 'viewerpass2' });
      token = session.token;
      const products = await api<Array<{ costPrice: number; price: number }>>('products.list', {});
      assert(products.length > 0, 'no products for viewer');
      assert(products.every((product) => product.costPrice === 0), 'cashier can see cost prices');
      assert(products.some((product) => product.price > 0), 'selling prices were stripped too');
      await expectError('stock.adjust', { productId: 1, removeQty: 1, reason: 'x', reasonType: 'LOST' }, 'FORBIDDEN');
      await expectError('labels.print', {}, 'EDITION_RESTRICTED');
      await expectError('stocktake.create', {}, 'EDITION_RESTRICTED');
    } finally {
      token = adminToken;
    }
  });

  let saleId = 0;
  let saleReceipt = '';
  await check('cash sale deducts stock, applies discount and prints store name', async () => {
    const sale = await api<{
      id: number;
      receiptNo: string;
      total: number;
      changeDue: number;
      items: { batchNo: string }[];
    }>('sales.create', {
      docType: 'RECEIPT',
      lines: [
        { productId: 1, qty: 3 },
        { productId: 2, qty: 1 }
      ],
      prescriptionRef: 'RX-2001',
      discount: 10_000,
      paymentMethod: 'CASH',
      amountPaid: 500_000
    });
    saleId = sale.id;
    saleReceipt = sale.receiptNo;
    assert(sale.total === 3 * 80_000 + 180_000 - 10_000, `unexpected total ${sale.total}`);
    assert(sale.changeDue === 500_000 - sale.total, 'change wrong');
    const doc = await api<{ html: string }>('sales.document', { id: sale.id });
    assert(doc.html.includes('Grace Pharmacy'), 'store name missing from receipt');
    assert(doc.html.includes('RX-2001'), 'prescription ref missing');
  });

  await check('prescription item requires a reference', async () => {
    await expectError(
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: 2, qty: 1 }], paymentMethod: 'CASH', amountPaid: 500_000 },
      'VALIDATION'
    );
  });

  await check('insufficient stock is refused and rolled back', async () => {
    await expectError(
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: 3, qty: 99 }], paymentMethod: 'CASH', amountPaid: 9_999_900 },
      'INSUFFICIENT_STOCK'
    );
  });

  await check('store name change does not alter old receipts', async () => {
    await api('settings.update', { storeName: 'Grace Pharmacy & Stores' });
    const doc = await api<{ html: string }>('sales.document', { id: saleId });
    assert(doc.html.includes('Grace Pharmacy'), 'snapshot lost');
    assert(!doc.html.includes('Grace Pharmacy &amp; Stores'), 'receipt picked up the new name');
    await api('settings.update', { storeName: 'Grace Pharmacy' });
  });

  await check('bank transfer sale records payment method', async () => {
    const sale = await api<{ paymentMethod: string }>('sales.create', {
      docType: 'RECEIPT',
      lines: [{ productId: 3, qty: 1 }],
      paymentMethod: 'TRANSFER',
      amountPaid: 250_000
    });
    assert(sale.paymentMethod === 'TRANSFER', 'payment method');
  });

  await check('wholesale invoice uses wholesale prices', async () => {
    const invoice = await api<{ docType: string; total: number }>('sales.create', {
      docType: 'INVOICE',
      lines: [{ productId: 1, qty: 10 }],
      customerName: 'Sunrise Chemists',
      customerPhone: '0805 111 2222',
      customerAddress: '5 Broad Street, Lagos',
      paymentMethod: 'TRANSFER',
      amountPaid: 700_000
    });
    assert(invoice.total === 700_000, `invoice total ${invoice.total}`);
    assert(invoice.docType === 'INVOICE', 'doctype');
  });

  await check('return within the cashier limit issues a credit note', async () => {
    const sale = await api<{ items: { id: number }[] }>('sales.get', { id: saleId });
    const outcome = await api<{ value: { status: string; creditNoteNo: string; total: number } }>(
      'returns.create',
      { saleId, reason: 'Wrong item dispensed', lines: [{ saleItemId: sale.items[0].id, qty: 1 }] }
    );
    assert(outcome.value.status === 'COMPLETED', 'return not completed');
    assert(/^CN-/.test(outcome.value.creditNoteNo), 'credit note number');
  });

  await check('void marks the sale void (never deletes it) and restores stock', async () => {
    const before = await api<{ stockQty: number }>('products.get', { id: 1 });
    const sale = await api<{ items: { id: number }[] }>('sales.get', { id: saleId });
    await api('sales.void', { id: saleId, reason: 'Cashier mistake' });
    const after = await api<{ stockQty: number }>('products.get', { id: 1 });
    assert(after.stockQty > before.stockQty, 'stock not restored');
    const stored = await api<{ status: string }>('sales.get', { id: saleId });
    assert(stored.status === 'VOIDED', 'sale not voided');
    assert((sale.items ?? []).length > 0, 'sale items gone');
  });

  await check('cashier account: own sales only, no admin powers', async () => {
    const created = await api<{ id: number }>('users.create', {
      username: `cashier${stamp}`,
      fullName: 'Chidi Cashier',
      role: 'CASHIER',
      password: 'cashierpass1'
    });
    assert(created.id > 0, 'user not created');
    const first = await api<{ token: string; mustChangePassword: boolean }>('auth.login', {
      username: `cashier${stamp}`,
      password: 'cashierpass1'
    });
    assert(first.mustChangePassword, 'temp password flag missing');
    await (async () => {
      const previous = token;
      token = first.token;
      await api('auth.changePassword', { newPassword: 'cashierpass2' });
      token = previous;
    })();
    const cashierSession = await api<{ token: string; permissions: string[] }>('auth.login', {
      username: `cashier${stamp}`,
      password: 'cashierpass2'
    });
    const adminToken = token;
    token = cashierSession.token;
    try {
      await expectError('users.list', {}, 'FORBIDDEN');
      await expectError('products.create', { name: 'X', costPrice: 1, price: 2 }, 'FORBIDDEN');
      await expectError('audit.list', {}, 'FORBIDDEN');
      const ownSales = await api<unknown[]>('sales.list', {});
      assert(ownSales.length === 0, 'cashier sees other people sales');
    } finally {
      token = adminToken;
    }
  });

  await check('pharmacy-only channels are enforced in the main process', async () => {
    const expiryWatch = await api<{ expiring: unknown[] }>('inventory.expiryWatch', {});
    assert(Array.isArray(expiryWatch.expiring), 'expiry watch failed');
  });

  const reportKinds = ['SALES_SUMMARY', 'PRODUCT_SALES', 'STOCK_VALUATION', 'LOW_STOCK', 'EXPIRY_WATCH', 'RETURNS', 'AUDIT'];
  for (const kind of reportKinds) {
    await check(`report renders: ${kind}`, async () => {
      const report = await api<{ html: string; rows: unknown[] }>('reports.build', { kind });
      assert(report.html.includes('Grace Pharmacy'), 'store name missing from report');
    });
  }

  await check('dashboard aggregates today', async () => {
    const dashboard = await api<{ todayTransactions: number; todaySales: number }>('dashboard.get');
    assert(dashboard.todayTransactions >= 1, 'no transactions');
    assert(dashboard.todaySales > 0, 'no sales value');
  });

  await check('audit trail records key actions', async () => {
    const entries = await api<{ action: string }[]>('audit.list', { limit: 500 });
    const actions = new Set(entries.map((e) => e.action));
    for (const action of ['license.activate', 'setup.complete', 'auth.login', 'sale.create', 'sale.void', 'return.create', 'user.create']) {
      assert(actions.has(action as string), `missing audit action ${action}`);
    }
  });

  await check('backup is created and listed', async () => {
    const backup = await api<{ path: string; size: number }>('backup.create', { label: 'smoke' });
    assert(backup.size > 0, 'empty backup');
    const list = await api<{ name: string }[]>('backup.list');
    assert(list.length >= 1, 'backup not listed');
  });

  await check('document export writes HTML', async () => {
    const doc = await api<{ html: string }>('sales.document', { id: saleId + 1 });
    const saved = await api<{ path: string }>('documents.saveHtml', {
      html: doc.html,
      filename: `smoke-${stamp}.html`
    });
    assert(saved.path.endsWith('.html'), 'export path');
  });

  await check('renewal with a new range keeps every record intact', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date();
    end.setFullYear(end.getFullYear() + 2);
    const renewed = await api<{ state: string; endsOn: string }>('license.activate', {
      masterPassword: MASTER,
      edition: 'PHARMACY',
      startsOn: today,
      endsOn: end.toISOString().slice(0, 10)
    });
    assert(renewed.state === 'VALID', `renewed state ${renewed.state}`);
    const products = await api<unknown[]>('products.list', {});
    assert(Array.isArray(products) && products.length > 0, 'products disappeared after renewal');
    const settings = await api<{ storeName: string }>('settings.read', {});
    assert(settings.storeName === 'Grace Pharmacy', `store name became ${settings.storeName}`);
    const history = await api<Array<{ action: string }>>('license.history', {});
    assert(history.some((row) => row.action === 'ACTIVATE'), 'activation missing from history');
    assert(history.some((row) => row.action === 'RENEW'), 'renewal missing from history');
  });

  await check('licence status reports expiry window', async () => {
    const status = await api<{ state: string; daysRemaining: number }>('license.status');
    assert(status.state === 'VALID' || status.state === 'EXPIRING', status.state);
    assert(status.daysRemaining > 300, 'days remaining');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  console.log(`Demo data left in the harness database — receipt ${saleReceipt}.`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
