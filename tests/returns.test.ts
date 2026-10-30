import { describe, expect, it } from 'vitest';
import type { Product, Sale, SaleReturn } from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct, makeUser } from './helpers';

async function sell(
  h: Awaited<ReturnType<typeof bootstrap>>['h'],
  token: string,
  productId: number,
  qty: number
): Promise<Sale> {
  return callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'RECEIPT',
      lines: [{ productId, qty }],
      paymentMethod: 'CASH',
      amountPaid: qty * 1_000_000
    },
    token
  );
}

describe('returns and credit notes', () => {
  it('lets a cashier complete a small return within the limit', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashr');
    const product = await createProduct(h, admin, { openingStock: 20 });
    const sale = await sell(h, cashier.token, product.id, 5);

    const outcome = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reason: 'Wrong item dispensed',
        lines: [{ saleItemId: sale.items![0].id, qty: 2 }]
      },
      cashier.token
    );
    expect(outcome.pending).toBe(false);
    expect(outcome.value.status).toBe('COMPLETED');
    expect(outcome.value.creditNoteNo).toMatch(/^CN-\d{6}$/);
    expect(outcome.value.total).toBe(160_000);
    expect(outcome.value.items?.[0].restock).toBe(true);

    const after = await callOk<Product>(h, 'products.get', { id: product.id }, admin.token);
    expect(after.stockQty).toBe(17); // 20 - 5 + 2

    const doc = await callOk<{ html: string }>(h, 'returns.document', { id: outcome.value.id }, admin.token);
    expect(doc.html).toContain('Credit Note');
    expect(doc.html).toContain('Grace Pharmacy');
    h.close();
  });

  it('routes over-limit returns to an approver and restocks only after approval', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashbig');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'supbig');
    const product = await createProduct(h, admin, { openingStock: 20, price: 200_000 });
    const sale = await sell(h, cashier.token, product.id, 2); // ₦4,000

    await callOk(h, 'settings.update', { returnLimit: 100_000 }, admin.token); // ₦1,000

    const pending = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reason: 'Customer complaint',
        lines: [{ saleItemId: sale.items![0].id, qty: 2 }]
      },
      cashier.token
    );
    expect(pending.pending).toBe(true);
    expect(pending.value.status).toBe('PENDING');
    expect(pending.value.creditNoteNo).toBeNull();
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(18);

    const approved = await callOk<SaleReturn>(h, 'returns.approve', { id: pending.value.id }, supervisor.token);
    expect(approved.status).toBe('COMPLETED');
    expect(approved.creditNoteNo).toMatch(/^CN-/);
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(20);

    const again = await callErr(h, 'returns.approve', { id: pending.value.id }, supervisor.token);
    expect(again.code).toBe('CONFLICT');
    h.close();
  });

  it('rejects a pending return without restocking', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashrj');
    const product = await createProduct(h, admin, { openingStock: 10, price: 300_000 });
    const sale = await sell(h, cashier.token, product.id, 1);
    await callOk(h, 'settings.update', { returnLimit: 1_000 }, admin.token);

    const pending = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reason: 'Changed mind',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      cashier.token
    );
    const rejected = await callOk<SaleReturn>(
      h,
      'returns.reject',
      { id: pending.value.id, reason: 'Item was used' },
      admin.token
    );
    expect(rejected.status).toBe('REJECTED');
    expect((await callOk<Product>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(9);

    const complete = await callErr(h, 'returns.approve', { id: pending.value.id }, admin.token);
    expect(complete.code).toBe('CONFLICT');
    h.close();
  });

  it('prevents over-returning the same item', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashor');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, cashier.token, product.id, 3);
    const itemId = sale.items![0].id;

    await callOk(
      h,
      'returns.create',
      { saleId: sale.id, reason: 'Partly faulty', lines: [{ saleItemId: itemId, qty: 2 }] },
      cashier.token
    );
    const err = await callErr(
      h,
      'returns.create',
      { saleId: sale.id, reason: 'More faulty', lines: [{ saleItemId: itemId, qty: 2 }] },
      cashier.token
    );
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/at most 1/);
    h.close();
  });

  it('refuses returns against voided sales', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, admin.token, product.id, 1);
    await callOk(h, 'sales.void', { id: sale.id, reason: 'Mistake' }, admin.token);
    const err = await callErr(
      h,
      'returns.create',
      { saleId: sale.id, reason: 'Nope', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      admin.token
    );
    expect(err.code).toBe('CONFLICT');
    h.close();
  });

  it('keeps returns scoped for cashiers', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashierA = await makeUser(h, admin, 'CASHIER', 'casha');
    const cashierB = await makeUser(h, admin, 'CASHIER', 'cashb');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, cashierA.token, product.id, 2);
    await callOk(
      h,
      'returns.create',
      { saleId: sale.id, reason: 'Faulty pack', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      cashierA.token
    );
    const seenByA = await callOk<SaleReturn[]>(h, 'returns.list', {}, cashierA.token);
    const seenByB = await callOk<SaleReturn[]>(h, 'returns.list', {}, cashierB.token);
    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);
    h.close();
  });
});
