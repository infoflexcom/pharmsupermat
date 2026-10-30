import { describe, expect, it } from 'vitest';
import type { Product, Sale } from '../src/shared/types';
import { callErr, callOk, createProduct, makeUser, bootstrap } from './helpers';

describe('point of sale', () => {
  it('completes a sale, deducts stock and snapshots the store details', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy' });
    const product = await createProduct(h, admin);

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 3 }],
        paymentMethod: 'CASH',
        amountPaid: 300_000
      },
      admin.token
    );

    expect(sale.total).toBe(240_000); // 3 × ₦800
    expect(sale.changeDue).toBe(60_000);
    expect(sale.receiptNo).toMatch(/^RCP-\d{6}$/);
    expect(sale.storeName).toBe('Grace Pharmacy');
    expect(sale.items).toHaveLength(1);
    expect(sale.items?.[0].batchNo).toBe('PCM-001');

    const after = await callOk<Product>(h, 'products.get', { id: product.id }, admin.token);
    expect(after.stockQty).toBe(37);

    // Renaming the store must not rewrite history.
    await callOk(h, 'settings.update', { storeName: 'Grace Pharmacy & Stores' }, admin.token);
    const doc = await callOk<{ html: string }>(h, 'sales.document', { id: sale.id }, admin.token);
    expect(doc.html).toContain('Grace Pharmacy');
    expect(doc.html).not.toContain('Grace Pharmacy &amp; Stores');
    h.close();
  });

  it('rolls the whole sale back when stock is insufficient', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin);
    const before = h.db.handle.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number };

    const err = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 500 }],
        paymentMethod: 'CASH',
        amountPaid: 999_999_999
      },
      admin.token
    );
    expect(err.code).toBe('INSUFFICIENT_STOCK');

    const after = h.db.handle.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(40);
    h.close();
  });

  it('sells first-expiry-first-out and never sells expired stock', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 10, openingExpiry: futureDate(120) });
    await callOk(
      h,
      'stock.receive',
      { productId: product.id, qty: 5, batchNo: 'EARLY', expiryDate: futureDate(20), costPrice: 50_000 },
      admin.token
    );

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 7 }],
        paymentMethod: 'CASH',
        amountPaid: 600_000
      },
      admin.token
    );
    expect(sale.items?.map((i) => [i.batchNo, i.qty])).toEqual([
      ['EARLY', 5],
      ['PCM-001', 2]
    ]);

    // Now a product whose only stock is expired.
    const expired = await createProduct(h, admin, {
      name: 'Old Ampicillin',
      openingStock: 4,
      openingBatchNo: 'EXP-1',
      openingExpiry: pastDate(5)
    });
    const err = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: expired.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000
      },
      admin.token
    );
    expect(err.code).toBe('INSUFFICIENT_STOCK');
    expect(err.message).toMatch(/expired/i);
    h.close();
  });

  it('validates money inputs', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const p = await createProduct(h, admin);

    const badDiscount = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: p.id, qty: 1 }],
        discount: 100_000,
        paymentMethod: 'CASH',
        amountPaid: 90_000
      },
      admin.token
    );
    expect(badDiscount.code).toBe('VALIDATION');

    const shortPaid = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: p.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 10
      },
      admin.token
    );
    expect(shortPaid.code).toBe('VALIDATION');

    const noLines = await callErr(h, 'sales.create', { docType: 'RECEIPT', lines: [], paymentMethod: 'CASH', amountPaid: 1 }, admin.token);
    expect(noLines.code).toBe('VALIDATION');
    h.close();
  });

  it('requires supervisor rights for price overrides', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { price: 100_000 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'cash9');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup9');

    const blocked = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1, unitPrice: 90_000 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000
      },
      cashier.token
    );
    expect(blocked.code).toBe('APPROVAL_REQUIRED');

    const ok = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1, unitPrice: 90_000 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000
      },
      supervisor.token
    );
    expect(ok.total).toBe(90_000);
    const audit = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.create' AND severity = 'WARN'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
    h.close();
  });

  it('voids without deleting, restores stock, and routes cashier voids to approval', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashv');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'supv');

    const batchBefore = await callOk<{ id: number; expiryDate: string | null; qty: number }[]>(
      h,
      'stock.batches',
      { productId: product.id },
      admin.token
    );

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 2 }],
        paymentMethod: 'CASH',
        amountPaid: 200_000
      },
      cashier.token
    );

    const requested = await callOk<{ sale: Sale; applied: boolean }>(
      h,
      'sales.void',
      { id: sale.id, reason: 'Customer changed mind' },
      cashier.token
    );
    expect(requested.applied).toBe(false);
    expect(requested.sale.voidRequestedAt).toBeTruthy();
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(8);

    const vouched = await callOk<Sale>(h, 'sales.approveVoid', { id: sale.id }, supervisor.token);
    expect(vouched.status).toBe('VOIDED');
    expect(vouched.voidReason).toBe('Customer changed mind');
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(10);

    // Stock went back to the original batch, still carrying its expiry date.
    const batchAfter = await callOk<{ id: number; expiryDate: string | null; qty: number }[]>(
      h,
      'stock.batches',
      { productId: product.id },
      admin.token
    );
    expect(batchAfter).toHaveLength(batchBefore.length);
    expect(batchAfter[0]).toMatchObject({
      id: batchBefore[0].id,
      expiryDate: batchBefore[0].expiryDate,
      qty: batchBefore[0].qty
    });

    // The sale row is still there.
    const stored = h.db.handle.prepare('SELECT COUNT(*) AS n FROM sales WHERE id = ?').get(sale.id) as {
      n: number;
    };
    expect(stored.n).toBe(1);

    const again = await callErr(h, 'sales.void', { id: sale.id, reason: 'again' }, admin.token);
    expect(again.code).toBe('CONFLICT');
    h.close();
  });

  it('blocks sales without a prescription reference for prescription items (pharmacy)', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const rx = await createProduct(h, admin, { name: 'Amoxicillin 500mg', rxRequired: true });
    const err = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: rx.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000
      },
      admin.token
    );
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/prescription/i);

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: rx.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000,
        prescriptionRef: 'RX-7781'
      },
      admin.token
    );
    expect(sale.prescriptionRef).toBe('RX-7781');
    h.close();
  });

  it('raises wholesale invoices with wholesale prices', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { price: 80_000, wholesalePrice: 65_000 });
    const invoice = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'INVOICE',
        lines: [{ productId: product.id, qty: 10 }],
        paymentMethod: 'TRANSFER',
        amountPaid: 650_000,
        customerName: 'Sunrise Chemists'
      },
      admin.token
    );
    expect(invoice.docType).toBe('INVOICE');
    expect(invoice.total).toBe(650_000);
    expect(invoice.receiptNo).toMatch(/^INV-/);
    const doc = await callOk<{ html: string }>(h, 'sales.document', { id: invoice.id }, admin.token);
    expect(doc.html).toContain('Wholesale Invoice');
    expect(doc.html).toContain('Grace Pharmacy');
    h.close();
  });

  it('lets cashiers see only their own sales', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin);
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashown');

    await callOk(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 100_000
      },
      admin.token
    );
    const cashierSale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 2 }],
        paymentMethod: 'CASH',
        amountPaid: 200_000
      },
      cashier.token
    );

    const own = await callOk<{ id: number }[]>(h, 'sales.list', {}, cashier.token);
    expect(own.every((s) => s.id === cashierSale.id)).toBe(true);
    expect(own.length).toBe(1);

    const all = await callOk<{ id: number }[]>(h, 'sales.list', {}, admin.token);
    expect(all.length).toBe(2);

    const forbidden = await callErr(h, 'sales.get', { id: all.find((s) => s.id !== cashierSale.id)!.id }, cashier.token);
    expect(forbidden.code).toBe('FORBIDDEN');
    h.close();
  });

  it('sends low-stock and expiry alerts', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    await createProduct(h, admin, { openingStock: 2, reorderLevel: 5, openingExpiry: futureDate(10) });
    const alerts = await callOk<{ lowStock: Product[]; expiring: { daysLeft: number }[] }>(
      h,
      'stock.alerts',
      {},
      admin.token
    );
    expect(alerts.lowStock).toHaveLength(1);
    expect(alerts.expiring[0].daysLeft).toBeLessThanOrEqual(10);
    h.close();
  });
});

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
function pastDate(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
