import { describe, expect, it } from 'vitest';
import { bootstrap, callErr, callOk, createProduct, makeUser } from './helpers';
import type { Batch, Product, StockCountDetail, StockCountRow } from '../src/shared/types';

const iso = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('products, packs and stock control', () => {
  it('stores brand and pack size and converts packs into base units on receipt', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await callOk<Product>(
      h,
      'products.create',
      {
        name: 'Amoxicillin 500mg',
        brand: 'Emzor',
        unit: 'capsule',
        packSize: 12,
        packUnit: 'carton',
        wholesaleMinQty: 5,
        costPrice: 30_000,
        price: 45_000,
        openingStock: 0
      },
      admin.token
    );
    expect(product.brand).toBe('Emzor');
    expect(product.packSize).toBe(12);
    expect(product.packUnit).toBe('carton');
    expect(product.wholesaleMinQty).toBe(5);

    const result = await callOk<{ receivedQty: number; product: Product }>(
      h,
      'stock.receive',
      { productId: product.id, packs: 3, batchNo: 'AMX-1', expiryDate: iso(300), costPrice: 30_000 },
      admin.token
    );
    expect(result.receivedQty).toBe(36);
    expect(result.product.stockQty).toBe(36);
    h.close();
  });

  it('rejects a pack size of zero', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const error = await callErr(
      h,
      'products.create',
      { name: 'Bad pack', packSize: 0, costPrice: 1_000, price: 2_000 },
      admin.token
    );
    expect(error.code).toBe('VALIDATION');
    h.close();
  });

  it('receives weighed goods in kilograms and sells them by the gram', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const rice = await callOk<Product>(
      h,
      'products.create',
      {
        name: 'Local rice',
        unit: 'kg',
        isWeighed: true,
        pricePerKg: 120_000,
        costPrice: 90_000,
        price: 120_000,
        pluCode: '4011'
      },
      admin.token
    );
    const received = await callOk<{ receivedQty: number; product: Product }>(
      h,
      'stock.receive',
      { productId: rice.id, weightKg: 2.5 },
      admin.token
    );
    expect(received.receivedQty).toBe(2_500);
    expect(received.product.stockQty).toBe(2_500);

    // 1.5 kg at ₦1,200/kg = ₦1,800.00
    const sale = await callOk<{ id: number; total: number; items: { qty: number; lineTotal: number; isWeighed: boolean }[] }>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: rice.id, qty: 1_500 }],
        paymentMethod: 'CASH',
        amountPaid: 200_000,
        customerName: 'Walk-in'
      },
      admin.token
    );
    expect(sale.items[0].lineTotal).toBe(180_000);
    expect(sale.items[0].isWeighed).toBe(true);

    const doc = await callOk<{ html: string }>(h, 'sales.document', { id: sale.id }, admin.token);
    expect(doc.html).toContain('1.500 kg');
    expect(doc.html).toContain('/kg');

    // Returning 500 g credits half a kilo: ₦600.00, not ₦60,000.00.
    const saleItems = await callOk<{ items: { id: number; isWeighed: boolean }[] }>(
      h,
      'sales.get',
      { id: sale.id },
      admin.token
    );
    const returned = await callOk<{ value: { total: number; items: { qty: number; netTotal: number }[] } }>(
      h,
      'returns.create',
      { saleId: sale.id, lines: [{ saleItemId: saleItems.items[0].id, qty: 500 }], reason: 'Customer changed mind' },
      admin.token
    );
    // lineTotal keeps the original line value; netTotal is the credit for 500 g.
    expect(returned.value.items[0].netTotal).toBe(60_000);
    expect(returned.value.total).toBe(60_000);
    h.close();
  });

  it('requires a reason for stock adjustments and locks them to the administrator', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Bottled water', openingStock: 10 });
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup1');

    const noReason = await callErr(
      h,
      'stock.adjust',
      { productId: product.id, removeQty: 2, reasonType: 'DAMAGED', reason: '  ' },
      admin.token
    );
    expect(noReason.code).toBe('VALIDATION');

    const denied = await callErr(
      h,
      'stock.adjust',
      { productId: product.id, removeQty: 2, reasonType: 'DAMAGED', reason: 'Broken' },
      supervisor.token
    );
    expect(denied.code).toBe('FORBIDDEN');

    const adjusted = await callOk<{ delta: number; after: number }>(
      h,
      'stock.adjust',
      { productId: product.id, removeQty: 2, reasonType: 'DAMAGED', reason: 'Broken during cleaning' },
      admin.token
    );
    expect(adjusted.delta).toBe(-2);
    expect(adjusted.after).toBe(8);

    const movement = h.db.handle
      .prepare("SELECT reason_type, note FROM stock_movements WHERE product_id = ? AND type = 'ADJUSTMENT'")
      .get(product.id) as { reason_type: string; note: string };
    expect(movement.reason_type).toBe('DAMAGED');
    expect(movement.note).toContain('Broken');

    const auditRow = h.db.handle
      .prepare("SELECT details FROM audit_log WHERE action = 'stock.adjust' ORDER BY id DESC LIMIT 1")
      .get() as { details: string };
    expect(JSON.parse(auditRow.details).reasonType).toBe('DAMAGED');
    h.close();
  });

  it('keeps cost prices away from cashiers and supervisors', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    await createProduct(h, admin, { name: 'Sugar 1kg', costPrice: 60_000, price: 75_000, openingStock: 5 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'cash1');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup2');

    for (const token of [cashier.token, supervisor.token]) {
      const rows = await callOk<Product[]>(h, 'products.list', {}, token);
      expect(rows[0].price).toBe(75_000);
      expect(rows[0].costPrice).toBe(0);

      const batches = await callOk<Batch[]>(h, 'stock.batches', { productId: rows[0].id }, token);
      expect(batches.every((batch) => batch.costPrice === 0)).toBe(true);
    }

    const edit = await callErr(
      h,
      'products.update',
      { id: 1, name: 'Sugar 1kg', costPrice: 1, price: 1 },
      cashier.token
    );
    expect(edit.code).toBe('FORBIDDEN');
    h.close();
  });

  it('alerts on low stock and near expiry with the configured window', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    await createProduct(h, admin, {
      name: 'Vitamin C',
      openingStock: 3,
      reorderLevel: 5,
      openingExpiry: iso(20)
    });
    const alerts = await callOk<{
      lowStock: Product[];
      expiring: { daysLeft: number; name: string }[];
      expiryWindowDays: number;
    }>(h, 'stock.alerts', {}, admin.token);
    expect(alerts.lowStock.map((p) => p.name)).toContain('Vitamin C');
    expect(alerts.expiring.some((row) => row.name === 'Vitamin C')).toBe(true);
    expect(alerts.expiryWindowDays).toBe(90);
    h.close();
  });
});

describe('bulk import, export and labels', () => {
  const HEADER =
    'SKU,Name,Brand,Category,Unit,Pack Size,Cost Price,Retail Price,Wholesale Price,Wholesale Min Qty,Reorder Level,Opening Stock,Barcode,Expiry Date';

  it('dry runs an import without writing, then imports the valid rows', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const csv = [
      HEADER,
      'SKU-1,Panadol Extra,GSK,Analgesics,tablet,12,"1,200.00","1,500.00","1,400.00",6,10,24,6151100000011,',
      'SKU-2,Ibuprofen 400mg,,Analgesics,tablet,10,900,1200,1100,4,5,0,,',
      'SKU-3,,,Analgesics,tablet,10,900,1200,,,,,,,,'
    ].join('\r\n');

    const dry = await callOk<{
      mode: string;
      validRows: number;
      created: number;
      skipped: number;
      errors: { row: number; field: string; message: string }[];
      preview: { name: string; action: string }[];
    }>(h, 'products.import', { filename: 'stock.csv', data: csv, encoding: 'utf8', mode: 'DRY_RUN' }, admin.token);
    expect(dry.mode).toBe('DRY_RUN');
    expect(dry.validRows).toBe(2);
    expect(dry.created).toBe(2);
    expect(dry.errors.some((error) => error.field === 'name' && error.row === 4)).toBe(true);
    expect(dry.preview.map((row) => row.name)).toContain('Panadol Extra');
    expect((await callOk<Product[]>(h, 'products.list', {}, admin.token)).length).toBe(0);

    const applied = await callOk<{ created: number; mode: string }>(
      h,
      'products.import',
      { filename: 'stock.csv', data: csv, encoding: 'utf8', mode: 'IMPORT' },
      admin.token
    );
    expect(applied.mode).toBe('IMPORT');
    expect(applied.created).toBe(2);

    const products = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(products).toHaveLength(2);
    const panadol = products.find((product) => product.sku === 'SKU-1')!;
    expect(panadol.brand).toBe('GSK');
    expect(panadol.price).toBe(150_000);
    expect(panadol.costPrice).toBe(120_000);
    expect(panadol.wholesaleMinQty).toBe(6);
    expect(panadol.barcode).toBe('6151100000011');

    // A second run updates instead of duplicating.
    const again = await callOk<{ created: number; updated: number; skipped: number }>(
      h,
      'products.import',
      {
        filename: 'stock.csv',
        data: csv.replace('"1,500.00"', '"1,600.00"'),
        encoding: 'utf8',
        mode: 'IMPORT'
      },
      admin.token
    );
    expect(again.created).toBe(0);
    expect(again.updated).toBe(1);
    expect(again.skipped).toBe(1);
    expect((await callOk<Product[]>(h, 'products.list', {}, admin.token)).length).toBe(2);
    h.close();
  });

  it('blocks imports for non-administrators', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cash2');
    const error = await callErr(
      h,
      'products.import',
      { filename: 'x.csv', data: `${HEADER}\r\nA,B,,C,unit,1,100,200,,,,0,,`, encoding: 'utf8', mode: 'DRY_RUN' },
      cashier.token
    );
    expect(error.code).toBe('FORBIDDEN');
    h.close();
  });

  it('exports products as CSV and hands back an Excel template', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    await createProduct(h, admin, { name: 'Golden Penny Semovita', brand: 'Flour Mills' });
    const csv = await callOk<{ filename: string; encoding: string; data: string; rows: number }>(
      h,
      'products.export',
      { format: 'CSV' },
      admin.token
    );
    expect(csv.encoding).toBe('utf8');
    expect(csv.rows).toBe(1);
    expect(csv.data.split('\r\n')[0]).toContain('Name');
    expect(csv.data).toContain('Golden Penny Semovita');

    const xlsx = await callOk<{ filename: string; encoding: string; data: string }>(
      h,
      'products.export',
      { format: 'XLSX' },
      admin.token
    );
    expect(xlsx.encoding).toBe('base64');
    expect(xlsx.filename.endsWith('.xlsx')).toBe(true);
    expect(xlsx.data.length).toBeGreaterThan(100);

    const template = await callOk<{ encoding: string; data: string }>(
      h,
      'products.exportTemplate',
      {},
      admin.token
    );
    expect(template.encoding).toBe('base64');
    h.close();
  });

  it('prints price labels with a scannable barcode', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Peak Milk 400g', barcode: '6151100000028' });
    const sheet = await callOk<{ html: string; count: number; copies: number }>(
      h,
      'labels.print',
      { productIds: [product.id], copies: 3 },
      admin.token
    );
    expect(sheet.count).toBe(1);
    expect(sheet.copies).toBe(3);
    expect((sheet.html.match(/class="label"/g) ?? []).length).toBe(3);
    expect(sheet.html).toContain('Peak Milk 400g');
    expect(sheet.html).toContain('<svg');
    expect(sheet.html).toContain('6151100000028');
    h.close();
  });
});

describe('stocktake and purchase orders', () => {
  it('counts stock, records the variance and posts it as movements', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Tinned tomatoes', openingStock: 10 });

    const count = await callOk<StockCountDetail>(h, 'stocktake.create', { note: 'Aisle 2' }, admin.token);
    expect(count.count.status).toBe('DRAFT');
    const line = count.items.find((item) => item.sku === product.sku)!;
    expect(line.system_qty).toBe(10);

    const saved = await callOk<StockCountDetail>(
      h,
      'stocktake.save',
      { countId: count.count.id, entries: [{ itemId: line.id, countedQty: 7 }] },
      admin.token
    );
    expect(saved.totals.varianceQty).toBe(-3);
    expect(saved.totals.varianceValue).toBe(-3 * 50_000);

    const posted = await callOk<StockCountDetail>(h, 'stocktake.post', { countId: count.count.id }, admin.token);
    expect(posted.count.status).toBe('POSTED');
    expect(posted.totals.varianceQty).toBe(-3);

    const batches = await callOk<Batch[]>(h, 'stock.batches', { productId: product.id }, admin.token);
    expect(batches.reduce((sum, batch) => sum + batch.qty, 0)).toBe(7);

    const posted2 = await callErr(h, 'stocktake.post', { countId: count.count.id }, admin.token);
    expect(posted2.code).toBe('CONFLICT');

    const list = await callOk<StockCountRow[]>(h, 'stocktake.list', {}, admin.token);
    expect(list[0].count_no).toBe(count.count.count_no);
    h.close();
  });

  it('keeps stocktake behind the supermarket edition and admin permission', async () => {
    const pharmacy = await bootstrap('PHARMACY');
    const blocked = await callErr(pharmacy.h, 'stocktake.create', {}, pharmacy.admin.token);
    expect(blocked.code).toBe('EDITION_RESTRICTED');
    pharmacy.h.close();

    const { h, admin } = await bootstrap('SUPERMARKET');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup4');
    const denied = await callErr(h, 'stocktake.create', {}, supervisor.token);
    expect(denied.code).toBe('FORBIDDEN');
    h.close();
  });

  it('orders from a supplier, then receives the goods against a GRN', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Sachet water', costPrice: 20_000, openingStock: 0 });

    const order = await callOk<{ id: number; status: string; purchase_no: string; total: number }>(
      h,
      'purchases.createOrder',
      { items: [{ productId: product.id, qty: 100, costPrice: 20_000 }] },
      admin.token
    );
    expect(order.status).toBe('DRAFT');
    expect(order.purchase_no.startsWith('PO-')).toBe(true);
    expect(order.total).toBe(2_000_000);

    const stillEmpty = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(stillEmpty[0].stockQty).toBe(0);

    const received = await callOk<{ status: string; grn_no: string; received_at: string }>(
      h,
      'purchases.receiveOrder',
      { id: order.id, invoiceNo: 'INV-9' },
      admin.token
    );
    expect(received.status).toBe('RECEIVED');
    expect(received.grn_no.startsWith('GRN-')).toBe(true);
    expect(received.received_at).toBeTruthy();

    const stocked = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(stocked[0].stockQty).toBe(100);

    const twice = await callErr(h, 'purchases.receiveOrder', { id: order.id }, admin.token);
    expect(twice.code).toBe('CONFLICT');
    h.close();
  });

  it('cancels a draft order without touching stock', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Milk powder', openingStock: 0 });
    const order = await callOk<{ id: number }>(
      h,
      'purchases.createOrder',
      { items: [{ productId: product.id, qty: 5, costPrice: 100_000 }] },
      admin.token
    );
    const cancelled = await callOk<{ status: string }>(h, 'purchases.cancelOrder', { id: order.id }, admin.token);
    expect(cancelled.status).toBe('CANCELLED');
    const rows = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(rows[0].stockQty).toBe(0);
    h.close();
  });
});
