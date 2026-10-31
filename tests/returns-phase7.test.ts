import { describe, expect, it } from 'vitest';
import type { Sale, SaleReturn, StockWriteoff, ReturnableSale } from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct, makeUser } from './helpers';
import {
  listLoyaltyMembers,
  listLoyaltyTransactions,
  saveLoyaltyMember,
  savePromotion
} from '../src/services/marketing';

type H = Awaited<ReturnType<typeof bootstrap>>['h'];

async function sell(
  h: H,
  token: string,
  lines: { productId: number; qty: number; unitPrice?: number; discount?: number }[],
  extra: Record<string, unknown> = {}
): Promise<Sale> {
  const subtotal = 1_000_000;
  return callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'RECEIPT',
      lines,
      paymentMethod: 'CASH',
      amountPaid: subtotal,
      ...extra
    },
    token
  );
}

function ageSale(h: H, saleId: number, days: number): void {
  const stamp = new Date(Date.now() - days * 86_400_000).toISOString();
  h.db.handle.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(stamp, saleId);
}

describe('returns — phase 7', () => {
  it('opens a receipt by number and reports what is still returnable', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 4 }]);

    const opened = await callOk<ReturnableSale>(h, 'returns.lookup', { receiptNo: sale.receiptNo }, admin.token);
    expect(opened.sale.id).toBe(sale.id);
    expect(opened.windowDays).toBe(7);
    expect(opened.withinWindow).toBe(true);
    expect(opened.items).toHaveLength(1);
    expect(opened.items[0].returnableQty).toBe(4);
    expect(opened.items[0].refundPerUnit).toBe(80_000);
    expect(opened.returnableValue).toBe(320_000);

    // A partial return reduces what the desk offers next time.
    await callOk(
      h,
      'returns.create',
      {
        receiptNo: sale.receiptNo,
        reasonCode: 'CHANGED_MIND',
        reason: 'Customer changed mind',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      admin.token
    );
    const reopened = await callOk<ReturnableSale>(h, 'returns.lookup', { receiptNo: sale.receiptNo }, admin.token);
    expect(reopened.items[0].alreadyReturned).toBe(1);
    expect(reopened.items[0].returnableQty).toBe(3);
    expect(reopened.returnableValue).toBe(240_000);

    const unknown = await callErr(h, 'returns.lookup', { receiptNo: 'RCP-999999' }, admin.token);
    expect(unknown.code).toBe('NOT_FOUND');
    h.close();
  });

  it('never returns more than was sold, across several returns and pending ones', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 3 }]);
    const itemId = sale.items![0].id;

    await callOk(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'DAMAGED', reason: 'Damaged pack', lines: [{ saleItemId: itemId, qty: 2 }] },
      admin.token
    );
    const over = await callErr(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'DAMAGED', reason: 'Another', lines: [{ saleItemId: itemId, qty: 2 }] },
      admin.token
    );
    expect(over.code).toBe('VALIDATION');
    expect(over.message).toMatch(/at most 1/);

    const ok = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'DAMAGED', reason: 'Last one', lines: [{ saleItemId: itemId, qty: 1 }] },
      admin.token
    );
    expect(ok.value.total).toBe(80_000);
    h.close();
  });

  it('blocks returns outside the window until an administrator overrides it', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'retcash');
    await makeUser(h, admin, 'SUPERVISOR', 'retsup');
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, cashier.token, [{ productId: product.id, qty: 1 }]);
    ageSale(h, sale.id, 10);

    const opened = await callOk<ReturnableSale>(h, 'returns.lookup', { saleId: sale.id }, cashier.token);
    expect(opened.ageDays).toBe(10);
    expect(opened.withinWindow).toBe(false);

    const blocked = await callErr(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'Too late',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      cashier.token
    );
    expect(blocked.code).toBe('APPROVAL_REQUIRED');
    expect(blocked.message).toMatch(/window/i);

    // A supervisor cannot override the window: it is an administrator decision.
    const supervisorApproval = await callErr(
      h,
      'pos.approve',
      { purpose: 'RETURN_WINDOW', username: 'retsup', password: 'userpass123' },
      cashier.token
    );
    expect(supervisorApproval.code).toBe('FORBIDDEN');

    const grant = await callOk<{ token: string }>(
      h,
      'pos.approve',
      { purpose: 'RETURN_WINDOW', username: 'admin', password: 'adminpass123', reason: 'Goodwill' },
      cashier.token
    );
    const completed = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'Late goodwill return',
        approvalToken: grant.token,
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      cashier.token
    );
    expect(completed.pending).toBe(false);
    expect(completed.value.windowOverride).toBe(true);
    expect(completed.value.approvedVia).toBe('PIN');
    expect(completed.value.status).toBe('COMPLETED');
    h.close();
  });

  it('asks a supervisor to approve returns above the limit, by PIN or by queue', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'retlim');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'retover');
    const product = await createProduct(h, admin, { openingStock: 10, price: 500_000 });
    await callOk(h, 'settings.update', { returnLimit: 100_000 }, admin.token);
    const sale = await sell(h, cashier.token, [{ productId: product.id, qty: 1 }]);

    const queued = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'WRONG_ITEM', reason: 'Wrong item', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      cashier.token
    );
    expect(queued.pending).toBe(true);
    expect(queued.value.status).toBe('PENDING');
    expect(queued.value.creditNoteNo).toBeNull();

    // Second sale: this time the supervisor's PIN is entered at the counter.
    const sale2 = await sell(h, cashier.token, [{ productId: product.id, qty: 1 }]);
    const grant = await callOk<{ token: string }>(
      h,
      'pos.approve',
      { purpose: 'RETURN', username: 'retover', password: 'userpass123' },
      cashier.token
    );
    const immediate = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      {
        saleId: sale2.id,
        reasonCode: 'WRONG_ITEM',
        reason: 'Wrong strength',
        approvalToken: grant.token,
        lines: [{ saleItemId: sale2.items![0].id, qty: 1 }]
      },
      cashier.token
    );
    expect(immediate.pending).toBe(false);
    expect(immediate.value.status).toBe('COMPLETED');
    expect(immediate.value.approvedVia).toBe('PIN');
    expect(immediate.value.creditNoteNo).toMatch(/^CN-/);

    // The queued one still needs the approvals tab.
    const approved = await callOk<SaleReturn>(h, 'returns.approve', { id: queued.value.id }, supervisor.token);
    expect(approved.status).toBe('COMPLETED');
    h.close();
  });

  it('reverses promotions and loyalty points proportionally (supermarket)', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const actor = { userId: admin.userId, username: admin.username };
    const product = await createProduct(h, admin, { name: 'Peak Milk 400g', price: 100_000, openingStock: 20 });
    const member = saveLoyaltyMember(h.db, { name: 'Amaka Returns', phone: '0803 222 1111' }, actor);
    savePromotion(h.db, { name: 'Milk 10% off', promoType: 'PERCENT', value: 10, productId: product.id }, actor);
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 3 }], { loyaltyMemberId: member.id });
    expect(sale.promoDiscount).toBe(30_000);
    expect(sale.total).toBe(270_000);
    expect(sale.loyaltyPoints).toBe(27);

    const partial = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'Two left',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      admin.token
    );
    // One of three units: a third of the promotion and a third of the points.
    expect(partial.value.total).toBe(90_000);
    expect(partial.value.promoReversed).toBe(10_000);
    expect(partial.value.loyaltyPointsReversed).toBe(9);

    expect(listLoyaltyMembers(h.db).find((m) => m.id === member.id)?.points).toBe(18);
    expect(listLoyaltyTransactions(h.db, member.id).some((row) => row.points_change === -9)).toBe(true);

    // Returning the remaining two units reverses the rest of the promotion.
    const rest = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'All back',
        lines: [{ saleItemId: sale.items![0].id, qty: 2 }]
      },
      admin.token
    );
    expect(rest.value.total).toBe(180_000);
    expect(rest.value.promoReversed).toBe(20_000);
    expect(listLoyaltyMembers(h.db).find((m) => m.id === member.id)?.points).toBe(0);
    h.close();
  });

  it('returns discounted lines for their share of what the customer paid, VAT included', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { price: 100_000, openingStock: 20 });
    await callOk(h, 'settings.update', { vatEnabled: true, vatRate: 7.5 }, admin.token);

    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 2, discount: 10_000 }], {
      discount: 10_000
    });
    expect(sale.subtotal).toBe(200_000);
    expect(sale.discount).toBe(20_000);
    expect(sale.tax).toBe(13_500);
    expect(sale.total).toBe(193_500);

    const oneUnit = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'WRONG_ITEM', reason: 'One back', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      admin.token
    );
    // Half the discounted line, grossed up by VAT: 96,750 of 193,500.
    expect(oneUnit.value.total).toBe(96_750);
    expect(oneUnit.value.discountReversed).toBe(10_000);
    expect(oneUnit.value.promoReversed).toBe(0);

    const second = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'WRONG_ITEM', reason: 'Other back', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      admin.token
    );
    expect(oneUnit.value.total + second.value.total).toBe(193_500);
    h.close();
  });

  it('restocks resellable goods to their batch and writes off the rest (pharmacy)', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { name: 'Amoxil 500mg', openingStock: 10 });
    await callOk(
      h,
      'stock.receive',
      { productId: product.id, qty: 5, batchNo: 'AMX-EARLY', expiryDate: futureDate(20), costPrice: 50_000 },
      admin.token
    );
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 5 }]);
    // FEFO took the early batch first.
    expect(sale.items?.map((i) => [i.batchNo, i.qty])).toEqual([['AMX-EARLY', 5]]);
    const saleItemId = sale.items![0].id;

    const good = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'WRONG_ITEM',
        reason: 'Wrong strength',
        lines: [{ saleItemId, qty: 2, resellable: true }]
      },
      admin.token
    );
    expect(good.value.items?.[0].restock).toBe(true);
    const batches = await callOk<{ batchNo: string; qty: number }[]>(
      h,
      'stock.batches',
      { productId: product.id },
      admin.token
    );
    expect(batches.find((b) => b.batchNo === 'AMX-EARLY')?.qty).toBe(2);

    const damaged = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'DAMAGED',
        reason: 'Crushed packs',
        lines: [{ saleItemId, qty: 1, resellable: false }]
      },
      admin.token
    );
    expect(damaged.value.items?.[0].restock).toBe(false);

    const writeoffs = await callOk<StockWriteoff[]>(h, 'returns.writeoffs', {}, admin.token);
    expect(writeoffs).toHaveLength(1);
    expect(writeoffs[0]).toMatchObject({
      productName: 'Amoxil 500mg',
      qty: 1,
      costPrice: 50_000,
      value: 50_000,
      reasonCode: 'DAMAGED'
    });
    const after = await callOk<{ stockQty: number }>(h, 'products.get', { id: product.id }, admin.token);
    expect(after.stockQty).toBe(10 + 5 - 5 + 2);

    // An expired reason can never go back on the shelf.
    const expired = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'EXPIRED',
        reason: 'Found expired',
        lines: [{ saleItemId, qty: 1, resellable: true }]
      },
      admin.token
    );
    expect(expired.value.items?.[0].restock).toBe(false);

    // Opened goods are a pharmacy write-off too.
    const opened = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'Opened box',
        lines: [{ saleItemId, qty: 1, resellable: true, condition: 'OPENED' }]
      },
      admin.token
    );
    expect(opened.value.items?.[0].restock).toBe(false);

    const auditRows = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'return.writeoff'")
      .get() as { n: number };
    expect(auditRows.n).toBe(3);
    h.close();
  });

  it('records refund, store credit and exchange returns', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 20 });

    const refund = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: (await sell(h, admin.token, [{ productId: product.id, qty: 1 }])).id,
        reasonCode: 'DAMAGED',
        reason: 'Broken',
        returnType: 'REFUND',
        refundMethod: 'TRANSFER',
        lines: [{ saleItemId: 1, qty: 1 }]
      },
      admin.token
    );
    expect(refund.value.returnType).toBe('REFUND');
    expect(refund.value.refundMethod).toBe('TRANSFER');
    h.close();
  });

  it('prints a credit note with the original store name and marks reprints DUPLICATE', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy' });
    const product = await createProduct(h, admin, { openingStock: 10 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 2 }]);
    const ret = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      { saleId: sale.id, reasonCode: 'CHANGED_MIND', reason: 'Changed mind', lines: [{ saleItemId: sale.items![0].id, qty: 1 }] },
      admin.token
    );

    await callOk(h, 'settings.update', { storeName: 'Grace Pharmacy & Stores' }, admin.token);
    const first = await callOk<{ html: string; duplicate: boolean; creditNote: SaleReturn }>(
      h,
      'returns.print',
      { id: ret.value.id },
      admin.token
    );
    expect(first.html).toContain('Grace Pharmacy');
    expect(first.html).not.toContain('&amp; Stores');
    expect(first.html).toContain('Credit Note');
    expect(first.html).toContain(ret.value.creditNoteNo!);
    expect(first.html).toContain('Customer changed mind');
    expect(first.duplicate).toBe(false);

    const again = await callOk<{ html: string; duplicate: boolean }>(h, 'returns.print', { id: ret.value.id }, admin.token);
    expect(again.duplicate).toBe(true);
    expect(again.html).toContain('Duplicate');

    const trail = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM document_prints WHERE kind = 'RETURN' AND return_id = ?")
      .get(ret.value.id) as { n: number };
    expect(trail.n).toBe(2);
    h.close();
  });

  it('marks store credit and exchange correctly', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 20 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 2 }]);

    const credit = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'Wanted credit',
        returnType: 'STORE_CREDIT',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      admin.token
    );
    expect(credit.value.returnType).toBe('STORE_CREDIT');
    expect(credit.value.refundMethod).toBe('STORE_CREDIT');

    const missingNote = await callErr(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'WRONG_ITEM',
        reason: 'Swap',
        returnType: 'EXCHANGE',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      admin.token
    );
    expect(missingNote.code).toBe('VALIDATION');
    expect(missingNote.message).toMatch(/exchange/i);

    const exchange = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'WRONG_ITEM',
        reason: 'Swapped for the 250mg pack',
        returnType: 'EXCHANGE',
        exchangeNote: 'Amoxil 250mg x1',
        lines: [{ saleItemId: sale.items![0].id, qty: 1 }]
      },
      admin.token
    );
    expect(exchange.value.returnType).toBe('EXCHANGE');
    expect(exchange.value.exchangeNote).toMatch(/250mg/);
    h.close();
  });
});

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}
