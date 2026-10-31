import { describe, expect, it } from 'vitest';
import type {
  DailySummary,
  DayReconciliation,
  MonthlySummary,
  ReportCatalogueEntry,
  ReportKind,
  ReportResult,
  Sale,
  SaleReturn,
  SessionInfo
} from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct, makeUser } from './helpers';

type H = Awaited<ReturnType<typeof bootstrap>>['h'];

const MONTH = '2026-03';
const DAY1 = '2026-03-05';
const DAY2 = '2026-03-06';
const STORE_ADDRESS = '12 Allen Avenue, Ikeja, Lagos';

async function sell(h: H, token: string, lines: { productId: number; qty: number }[], extra: Record<string, unknown> = {}) {
  return callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'RECEIPT',
      lines,
      paymentMethod: 'CASH',
      amountPaid: 5_000_000,
      ...extra
    },
    token
  );
}

function ageSale(h: H, saleId: number, iso: string): void {
  h.db.handle.prepare('UPDATE sales SET created_at = ? WHERE id = ?').run(iso, saleId);
  h.db.handle.prepare('UPDATE payments SET created_at = ? WHERE sale_id = ?').run(iso, saleId);
}

function ageReturn(h: H, returnId: number, iso: string): void {
  h.db.handle
    .prepare('UPDATE returns SET requested_at = ?, approved_at = ? WHERE id = ?')
    .run(iso, iso, returnId);
}

/**
 * The hand-calculated ledger every accounting test starts from.
 *
 *   day 1 (2026-03-05), retail, admin
 *     Rice 5kg  × 2 @ ₦1,000  = ₦2,000      cost ₦600 each
 *     Milk 400g × 1 @ ₦500    = ₦500        cost ₦300
 *     sale-level discount                     –₦100
 *     total                                   ₦2,400   (VAT off)
 *     return: 1 rice back, resellable         –₦480 (one of two rice, 40% of the sale)
 *
 *   day 2 (2026-03-06), wholesale invoice, admin
 *     Rice 5kg × 5 @ ₦900 trade price = ₦4,500
 *     paid ₦2,000 by transfer, ₦2,500 on account
 */
async function seedLedger(h: H, admin: SessionInfo) {
  const rice = await createProduct(h, admin, {
    name: 'Rice 5kg',
    price: 100_000,
    wholesalePrice: 90_000,
    costPrice: 60_000,
    openingStock: 100,
    openingBatchNo: 'RICE-1'
  });
  const milk = await createProduct(h, admin, {
    name: 'Milk 400g',
    price: 50_000,
    wholesalePrice: 45_000,
    costPrice: 30_000,
    openingStock: 100,
    openingBatchNo: 'MILK-1'
  });
  const customer = await callOk<{ id: number }>(
    h,
    'directory.customers.save',
    { name: 'Sunrise Stores', phone: '0805 111 2222', creditLimit: 5_000_000 },
    admin.token
  );
  await callOk(h, 'settings.update', { paymentCredit: true }, admin.token);

  const sale1 = await sell(
    h,
    admin.token,
    [
      { productId: rice.id, qty: 2 },
      { productId: milk.id, qty: 1 }
    ],
    { discount: 10_000, amountPaid: 240_000, customerName: 'Walk-in' }
  );
  const ret = await callOk<{ value: SaleReturn }>(
    h,
    'returns.create',
    {
      saleId: sale1.id,
      reasonCode: 'CHANGED_MIND',
      reason: 'One bag came back',
      returnType: 'REFUND',
      refundMethod: 'CASH',
      lines: [{ saleItemId: sale1.items![0].id, qty: 1, resellable: true }]
    },
    admin.token
  );
  // The accounting reports work on past dates, so both rows move into March.
  ageSale(h, sale1.id, `${DAY1}T10:00:00.000Z`);
  ageReturn(h, ret.value.id, `${DAY1}T11:00:00.000Z`);

  const sale2 = await callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'INVOICE',
      tier: 'WHOLESALE',
      lines: [{ productId: rice.id, qty: 5 }],
      customerId: customer.id,
      customerName: 'Sunrise Stores',
      paymentMethod: 'SPLIT',
      amountPaid: 200_000,
      payments: [
        { method: 'TRANSFER', amount: 200_000 },
        { method: 'CREDIT', amount: 250_000 }
      ]
    },
    admin.token
  );
  ageSale(h, sale2.id, `${DAY2}T09:30:00.000Z`);

  return { rice, milk, customer, sale1, sale2, creditNote: ret.value };
}

describe('accounting and reports — phase 8', () => {
  it('builds a daily summary that matches the hand calculation', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);

    const day1 = await callOk<DailySummary>(h, 'reports.daily', { date: DAY1 }, admin.token);
    expect(day1).toMatchObject({
      date: DAY1,
      salesCount: 1,
      retailCount: 1,
      retailSales: 240_000,
      wholesaleCount: 0,
      wholesaleSales: 0,
      grossSales: 250_000,
      discounts: 10_000,
      tax: 0,
      returnsCount: 1,
      returnsTotal: 96_000,
      netSales: 144_000,
      netSalesInclVat: 144_000,
      cogs: 90_000,
      grossProfit: 54_000,
      scopeUserId: null
    });
    // Cash paid the till; the return refunded ₦480 out of it.
    expect(day1.payments).toEqual([{ method: 'CASH', label: 'Cash', count: 1, amount: 240_000 }]);
    expect(day1.users).toHaveLength(1);
    expect(day1.users[0]).toMatchObject({ salesCount: 1, gross: 250_000, net: 240_000, returns: 96_000 });
    expect(day1.html).toContain('Sunmart Test Store');
    expect(day1.html).toContain('Daily Summary');

    const day2 = await callOk<DailySummary>(h, 'reports.daily', { date: DAY2 }, admin.token);
    expect(day2).toMatchObject({
      salesCount: 1,
      retailCount: 0,
      wholesaleCount: 1,
      wholesaleSales: 450_000,
      grossSales: 450_000,
      discounts: 0,
      returnsTotal: 0,
      netSales: 450_000,
      cogs: 300_000,
      grossProfit: 150_000
    });
    // ₦2,000 transfer + the ₦2,500 left on account.
    expect(day2.payments).toEqual([
      { method: 'CREDIT', label: 'Credit', count: 1, amount: 250_000 },
      { method: 'TRANSFER', label: 'Bank transfer', count: 1, amount: 200_000 }
    ]);

    const quiet = await callOk<DailySummary>(h, 'reports.daily', { date: '2026-03-07' }, admin.token);
    expect(quiet.salesCount).toBe(0);
    expect(quiet.netSales).toBe(0);
    expect(quiet.grossProfit).toBe(0);
    expect(quiet.payments).toEqual([]);
    h.close();
  });

  it('shows a cashier only their own figures and never profit', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    const cashier = await makeUser(h, admin, 'CASHIER', 'rep8cash');
    const product = await createProduct(h, admin, { price: 80_000, costPrice: 50_000, openingStock: 50 });
    await sell(h, cashier.token, [{ productId: product.id, qty: 1 }], { amountPaid: 80_000 });
    await sell(h, admin.token, [{ productId: product.id, qty: 2 }], { amountPaid: 160_000 });
    const today = new Date().toISOString().slice(0, 10);

    const mine = await callOk<DailySummary>(h, 'reports.daily', { date: today }, cashier.token);
    expect(mine.salesCount).toBe(1);
    expect(mine.netSales).toBe(80_000);
    expect(mine.grossProfit).toBeNull();
    expect(mine.scopeUserId).not.toBeNull();
    expect(mine.users).toHaveLength(1);
    expect(mine.html).not.toMatch(/gross profit/i);

    const everyone = await callOk<DailySummary>(h, 'reports.daily', { date: today }, admin.token);
    expect(everyone.salesCount).toBe(2);
    expect(everyone.netSales).toBe(240_000);
    expect(everyone.users).toHaveLength(2);
    expect(everyone.grossProfit).toBe(240_000 - 150_000);

    const month = await callOk<MonthlySummary>(
      h,
      'reports.monthly',
      { month: today.slice(0, 7) },
      cashier.token
    );
    expect(month.salesCount).toBe(1);
    expect(month.grossProfit).toBeNull();
    h.close();
  });

  it('builds a monthly summary whose day table and chart agree with the month', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);

    const month = await callOk<MonthlySummary>(h, 'reports.monthly', { month: MONTH }, admin.token);
    expect(month).toMatchObject({
      month: MONTH,
      from: '2026-03-01',
      to: '2026-03-31',
      salesCount: 2,
      grossSales: 700_000,
      discounts: 10_000,
      returnsCount: 1,
      returnsTotal: 96_000,
      netSales: 594_000,
      netSalesInclVat: 594_000,
      cogs: 390_000,
      grossProfit: 204_000
    });
    expect(month.days).toHaveLength(31);
    expect(month.days.reduce((sum, day) => sum + day.takings, 0)).toBe(594_000);
    expect(month.days.reduce((sum, day) => sum + day.net, 0)).toBe(594_000);
    expect(month.days.reduce((sum, day) => sum + (day.profit ?? 0), 0)).toBe(204_000);
    expect(month.days.find((day) => day.date === DAY1)).toMatchObject({ net: 144_000, cogs: 90_000 });
    expect(month.days.find((day) => day.date === DAY2)).toMatchObject({ net: 450_000, cogs: 300_000 });
    expect(month.days.find((day) => day.date === '2026-03-01')).toMatchObject({ net: 0, salesCount: 0 });
    expect(month.chart.values).toHaveLength(31);
    expect(month.chart.values.reduce((sum, value) => sum + value, 0)).toBe(594_000);
    expect(month.html).toContain('Sunmart Test Store');
    expect(month.html).toContain('Monthly Summary');

    const report = await callOk<ReportResult>(
      h,
      'reports.build',
      { kind: 'MONTHLY_SUMMARY', month: MONTH, from: '2026-03-01', to: '2026-03-31' },
      admin.token
    );
    expect(report.rows).toHaveLength(31);
    expect(report.totals.net).toBe(594_000);
    expect(report.totals.profit).toBe(204_000);
    expect(report.chart?.values).toHaveLength(31);
    expect(report.owner).toBe('SHARED');
    h.close();
  });

  it('removes VAT from net sales and reverses the return’s share of it', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await callOk(h, 'settings.update', { vatEnabled: true, vatRate: 7.5 }, admin.token);
    const product = await createProduct(h, admin, { price: 100_000, costPrice: 60_000, openingStock: 20 });
    const today = new Date().toISOString().slice(0, 10);

    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 2 }], { amountPaid: 215_000 });
    expect(sale).toMatchObject({ subtotal: 200_000, tax: 15_000, total: 215_000 });

    const ret = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'CHANGED_MIND',
        reason: 'One back',
        lines: [{ saleItemId: sale.items![0].id, qty: 1, resellable: true }]
      },
      admin.token
    );
    // Half the line, grossed up by VAT: ₦1,075.00 of ₦2,150.00.
    expect(ret.value.total).toBe(107_500);

    const day = await callOk<DailySummary>(h, 'reports.daily', { date: today }, admin.token);
    expect(day.grossSales).toBe(200_000);
    expect(day.tax).toBe(15_000);
    expect(day.returnsTotal).toBe(107_500);
    // Revenue without VAT: (215,000 − 15,000) − (107,500 − 7,500) = 100,000.
    expect(day.netSales).toBe(100_000);
    expect(day.netSalesInclVat).toBe(107_500);
    expect(day.cogs).toBe(60_000);
    expect(day.grossProfit).toBe(40_000);
    h.close();
  });

  it('reconciles an end-of-day close with shifts and cashiers, and saves the variance', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    const cashier = await makeUser(h, admin, 'CASHIER', 'dayclerk');
    const product = await createProduct(h, admin, { price: 80_000, costPrice: 50_000, openingStock: 50 });
    const today = new Date().toISOString().slice(0, 10);

    const shift = await callOk<{ id: number }>(h, 'mart.shifts.open', { openingFloat: 100_000 }, cashier.token);
    const cashSale = await sell(h, cashier.token, [{ productId: product.id, qty: 1 }], { amountPaid: 80_000, shiftId: shift.id });
    expect(cashSale.total).toBe(80_000);

    // A ₦800 cash refund comes out of the same drawer.
    // A voided sale keeps its payment row but must not count as drawer cash.
    const mistyped = await sell(h, cashier.token, [{ productId: product.id, qty: 1 }], {
      amountPaid: 80_000,
      shiftId: shift.id
    });
    await callOk(h, 'sales.void', { id: mistyped.id, reason: 'Rang the wrong item' }, cashier.token);
    await callOk(h, 'sales.approveVoid', { id: mistyped.id }, admin.token);

    const damagedSale = await sell(h, admin.token, [{ productId: product.id, qty: 1 }], { amountPaid: 80_000 });
    const ret = await callOk<{ value: SaleReturn }>(
      h,
      'returns.create',
      {
        saleId: damagedSale.id,
        reasonCode: 'DAMAGED',
        reason: 'Damaged pack',
        lines: [{ saleItemId: damagedSale.items![0].id, qty: 1, resellable: false }],
        refundMethod: 'CASH'
      },
      cashier.token
    );
    expect(ret.value.total).toBe(80_000);
    // The admin sold another ₦800 in cash outside a shift.
    await sell(h, admin.token, [{ productId: product.id, qty: 1 }], { amountPaid: 80_000 });

    const closeShift = await callOk<{ id: number }>(
      h,
      'mart.shifts.close',
      { shiftId: shift.id, countedCash: 99_500 },
      cashier.token
    );
    expect(closeShift.id).toBe(shift.id);

    const view = await callOk<DayReconciliation>(
      h,
      'operations.day.reconcile',
      { businessDate: today, openingFloat: 100_000 },
      admin.token
    );
    expect(view.shiftReconciliation).toBe(true);
    expect(view.salesCount).toBe(3);
    expect(view.cashSales).toBe(240_000);
    expect(view.cashRefunds).toBe(80_000);
    expect(view.expectedCash).toBe(100_000 + 240_000 - 80_000);
    expect(view.canClose).toBe(true);

    const cashierShift = view.shifts.find((row) => row.shiftId === shift.id)!;
    expect(cashierShift).toMatchObject({
      openingFloat: 100_000,
      cashSales: 80_000,
      cashRefunds: 80_000,
      expectedCash: 100_000,
      countedCash: 99_500,
      variance: -500,
      status: 'CLOSED'
    });
    const cashierRow = view.cashiers.find((row) => row.username === 'dayclerk')!;
    expect(cashierRow).toMatchObject({ salesCount: 1, cashSales: 80_000, cashRefunds: 80_000, expectedCash: 100_000, variance: -500 });
    const adminRow = view.cashiers.find((row) => row.username === 'admin')!;
    expect(adminRow).toMatchObject({ salesCount: 2, cashSales: 160_000, expectedCash: 160_000, countedCash: null });

    // A cashier cannot close the business day; a supervisor can.
    const denied = await callErr(h, 'operations.day.close', { businessDate: today, countedCash: 259_000 }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');

    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'daysup');
    const closing = await callOk<{ variance: number; expected_cash: number; counted_cash: number }>(
      h,
      'operations.day.close',
      { businessDate: today, openingFloat: 100_000, countedCash: 259_000 },
      supervisor.token
    );
    expect(closing.expected_cash).toBe(260_000);
    expect(closing.counted_cash).toBe(259_000);
    expect(closing.variance).toBe(-1_000);

    // Without being told the float again, the reconciliation reuses the saved one.
    const after = await callOk<DayReconciliation>(h, 'operations.day.reconcile', { businessDate: today }, admin.token);
    expect(after.openingFloat).toBe(100_000);
    expect(after.canClose).toBe(false);
    expect(after.countedCash).toBe(259_000);
    expect(after.variance).toBe(-1_000);
    expect(after.closedBy).toBe('daysup');

    const again = await callErr(h, 'operations.day.close', { businessDate: today, countedCash: 1 }, admin.token);
    expect(again.code).toBe('CONFLICT');
    h.close();
  });

  it('reports top sellers, slow movers, user performance, debtors and supplier purchases', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    const seed = await seedLedger(h, admin);
    const idle = await createProduct(h, admin, {
      name: 'Sleeping Beans',
      price: 40_000,
      costPrice: 20_000,
      openingStock: 30
    });
    const supplier = await callOk<{ id: number }>(
      h,
      'directory.suppliers.save',
      { name: 'Lagos Wholesale Ltd', phone: '0803 999 0000' },
      admin.token
    );
    await callOk(
      h,
      'purchases.create',
      {
        supplierId: supplier.id,
        invoiceNo: 'SUP-1',
        purchaseDate: DAY1,
        amountPaid: 0,
        items: [{ productId: seed.rice.id, qty: 10, costPrice: 55_000, batchNo: 'RICE-2', expiryDate: '2027-01-01' }]
      },
      admin.token
    );
    const cashier = await makeUser(h, admin, 'CASHIER', 'perf8');

    const period = { from: DAY1, to: DAY2 };
    const top = await callOk<ReportResult>(h, 'reports.build', { kind: 'TOP_SELLERS', ...period }, admin.token);
    expect(top.rows[0]).toMatchObject({ name: 'Rice 5kg', qty: 7, revenue: 650_000, profit: 230_000 });
    expect(top.rows).toHaveLength(2);

    const slow = await callOk<ReportResult>(h, 'reports.build', { kind: 'SLOW_MOVERS', ...period }, admin.token);
    expect(slow.rows.map((row) => row.name)).toContain('Sleeping Beans');
    expect(slow.rows.map((row) => row.name)).not.toContain('Rice 5kg');
    expect(slow.totals.tiedUp).toBe(30 * 20_000);

    const people = await callOk<ReportResult>(h, 'reports.build', { kind: 'USER_PERFORMANCE', ...period }, admin.token);
    const adminRow = people.rows.find((row) => String(row.user).includes('admin'))!;
    expect(adminRow).toMatchObject({ count: 2, total: 690_000, returns: 96_000 });

    const debtors = await callOk<ReportResult>(h, 'reports.build', { kind: 'DEBTORS', ...period }, admin.token);
    expect(debtors.rows).toHaveLength(1);
    expect(debtors.rows[0]).toMatchObject({ customer: 'Sunrise Stores', invoices: 1, due: 250_000, creditLimit: 5_000_000 });
    expect(debtors.totals.due).toBe(250_000);

    const purchases = await callOk<ReportResult>(h, 'reports.build', { kind: 'SUPPLIER_PURCHASES', ...period }, admin.token);
    expect(purchases.rows[0]).toMatchObject({ supplier: 'Lagos Wholesale Ltd', invoices: 1, total: 550_000, balance: 550_000 });

    const denied = await callErr(h, 'reports.build', { kind: 'DEBTORS', ...period }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');
    void idle;
    h.close();
  });

  it('reports departments, promotions, loyalty, stocktake variance and overrides (supermarket)', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    const actor = { userId: admin.userId, username: admin.username };
    const { saveDepartment, savePromotion, saveLoyaltyMember } = await import('../src/services/marketing');
    const department = saveDepartment(h.db, { name: 'Groceries' }, actor);
    const product = await createProduct(h, admin, {
      name: 'Bag of Beans',
      price: 100_000,
      costPrice: 60_000,
      openingStock: 40,
      departmentId: department.id
    });
    savePromotion(h.db, { name: 'Beans 10% off', promoType: 'PERCENT', value: 10, productId: product.id }, actor);
    const member = saveLoyaltyMember(h.db, { name: 'Ada Shopper', phone: '0803 444 5555' }, actor);
    const today = new Date().toISOString().slice(0, 10);

    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 4 }], {
      amountPaid: 360_000,
      loyaltyMemberId: member.id
    });
    expect(sale.promoDiscount).toBe(40_000);
    expect(sale.total).toBe(360_000);
    expect(sale.loyaltyPoints).toBe(36);

    // A stocktake with a variance.
    const count = await callOk<{ count: { id: number }; items: { id: number; system_qty: number }[] }>(
      h,
      'stocktake.create',
      { note: 'Shelf count' },
      admin.token
    );
    const line = count.items.find((item) => item.id) ?? count.items[0];
    await callOk(
      h,
      'stocktake.save',
      { countId: count.count.id, entries: [{ itemId: line.id, countedQty: Math.max(0, line.system_qty - 2) }] },
      admin.token
    );
    await callOk(h, 'stocktake.post', { countId: count.count.id }, admin.token);

    // A void and an override, both audited.
    const voided = await sell(h, admin.token, [{ productId: product.id, qty: 1 }], { amountPaid: 90_000 });
    await callOk(h, 'sales.void', { id: voided.id, reason: 'Cashier error' }, admin.token);
    await callOk(
      h,
      'pos.approve',
      { purpose: 'PRICE_OVERRIDE', username: 'admin', password: 'adminpass123', reason: 'Damaged bag' },
      admin.token
    );

    const departments = await callOk<ReportResult>(h, 'reports.build', { kind: 'DEPARTMENT_SALES', from: today, to: today }, admin.token);
    expect(departments.rows[0]).toMatchObject({ department: 'Groceries', qty: 4, revenue: 360_000 });
    expect(departments.totals.revenue).toBe(360_000);
    expect(departments.chart).toBeDefined();

    const promotions = await callOk<ReportResult>(h, 'reports.build', { kind: 'PROMOTION_PERFORMANCE', from: today, to: today }, admin.token);
    expect(promotions.rows[0]).toMatchObject({ name: 'Beans 10% off', qty: 4, revenue: 360_000, discount: 40_000 });

    const loyalty = await callOk<ReportResult>(h, 'reports.build', { kind: 'LOYALTY', from: today, to: today }, admin.token);
    expect(loyalty.rows[0]).toMatchObject({ name: 'Ada Shopper', earned: 36, redeemed: 0, balance: 36 });

    const variance = await callOk<ReportResult>(h, 'reports.build', { kind: 'STOCKTAKE_VARIANCE', from: today, to: today }, admin.token);
    expect(variance.rows).toHaveLength(1);
    expect(variance.totals.varianceQty).toBeLessThan(0);

    const overrides = await callOk<ReportResult>(h, 'reports.build', { kind: 'VOID_OVERRIDES', from: today, to: today }, admin.token);
    expect(overrides.rows.some((row) => row.type === 'VOID')).toBe(true);
    expect(overrides.rows.some((row) => String(row.type).startsWith('OVERRIDE'))).toBe(true);
    expect(overrides.totals.amount).toBe(90_000);
    h.close();
  });

  it('reports pharmacy write-offs and expiry, and enforces the editions', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Test Pharmacy' });
    const product = await createProduct(h, admin, {
      name: 'Amoxil 500mg',
      price: 80_000,
      costPrice: 50_000,
      openingStock: 20,
      openingExpiry: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    });
    const today = new Date().toISOString().slice(0, 10);
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 2 }], { amountPaid: 160_000 });
    await callOk(
      h,
      'returns.create',
      {
        saleId: sale.id,
        reasonCode: 'EXPIRED',
        reason: 'Found expired',
        lines: [{ saleItemId: sale.items![0].id, qty: 1, resellable: true }]
      },
      admin.token
    );

    const writeoffs = await callOk<ReportResult>(h, 'reports.build', { kind: 'WRITE_OFFS', from: today, to: today }, admin.token);
    expect(writeoffs.rows).toHaveLength(1);
    expect(writeoffs.rows[0]).toMatchObject({ name: 'Amoxil 500mg', qty: 1, cost: 50_000, value: 50_000, reason: 'EXPIRED' });
    expect(writeoffs.totals.value).toBe(50_000);

    const expiry = await callOk<ReportResult>(h, 'reports.build', { kind: 'EXPIRY_WATCH', from: today, to: today }, admin.token);
    expect(expiry.rows.length).toBeGreaterThan(0);

    const department = await callErr(h, 'reports.build', { kind: 'DEPARTMENT_SALES', from: today, to: today }, admin.token);
    expect(department.code).toBe('EDITION_RESTRICTED');

    const catalogue = await callOk<ReportCatalogueEntry[]>(h, 'reports.catalogue', {}, admin.token);
    expect(catalogue.map((entry) => entry.kind)).toContain('WRITE_OFFS');
    expect(catalogue.map((entry) => entry.kind)).not.toContain('DEPARTMENT_SALES');

    h.close();
  });

  it('hides cost and profit from supervisors but keeps every retail figure', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'reportsup');

    const supervisorStock = await callOk<ReportResult>(h, 'reports.build', { kind: 'STOCK_VALUATION' }, supervisor.token);
    expect(supervisorStock.columns.map((column) => column.key)).not.toContain('cost');
    expect(supervisorStock.totals.cost).toBeUndefined();
    expect(supervisorStock.totals.retail).toBeGreaterThan(0);

    const adminStock = await callOk<ReportResult>(h, 'reports.build', { kind: 'STOCK_VALUATION' }, admin.token);
    expect(adminStock.columns.map((column) => column.key)).toContain('cost');
    expect(adminStock.totals.cost).toBeGreaterThan(0);

    const supervisorMonth = await callOk<MonthlySummary>(h, 'reports.monthly', { month: MONTH }, supervisor.token);
    expect(supervisorMonth.grossProfit).toBeNull();
    expect(supervisorMonth.netSales).toBe(594_000);

    // A supervisor may read the audit trail, but a supermarket install never
    // lists the pharmacy reports.
    const supervisorCatalogue = await callOk<ReportCatalogueEntry[]>(h, 'reports.catalogue', {}, supervisor.token);
    expect(supervisorCatalogue.some((entry) => entry.kind === 'AUDIT')).toBe(true);
    expect(supervisorCatalogue.some((entry) => entry.kind === 'WRITE_OFFS')).toBe(false);
    expect(supervisorCatalogue.some((entry) => entry.kind === 'LOW_STOCK')).toBe(true);
    h.close();
  });

  it('exports CSV with the store header, the period and naira amounts', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);

    const daily = await callOk<{ filename: string; data: string; encoding: string }>(
      h,
      'reports.export',
      { kind: 'DAILY_SUMMARY', from: DAY1, to: DAY1 },
      admin.token
    );
    expect(daily.filename).toBe('daily_summary-2026-03-05.csv');
    expect(daily.encoding).toBe('utf8');
    expect(daily.data.startsWith('\uFEFF')).toBe(true);
    expect(daily.data).toContain('Sunmart Test Store');
    expect(daily.data).toContain(STORE_ADDRESS);
    expect(daily.data).toContain('Daily Summary');
    expect(daily.data).toContain('2026-03-05');
    expect(daily.data).toContain('Gross sales,2500.00');
    expect(daily.data).toContain('Net sales (ex VAT),1440.00');
    expect(daily.data).toContain('Gross profit,540.00');
    expect(daily.data).toContain('Total,1,2500.00,1440.00,960.00');

    const monthly = await callOk<{ filename: string; data: string }>(
      h,
      'reports.export',
      { kind: 'MONTHLY_SUMMARY', month: MONTH, from: '2026-03-01', to: '2026-03-31' },
      admin.token
    );
    expect(monthly.filename).toBe('monthly_summary-2026-03-01.csv');
    expect(monthly.data).toContain('Sunmart Test Store');
    expect(monthly.data).toContain('2026-03-06,1,4500.00,4500.00,0.00,3000.00,1500.00');
    expect(monthly.data).toContain('Total,2,5940.00,5940.00,960.00,3900.00,2040.00');
    h.close();
  });

  it('exports a real Excel workbook with the store identity', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);

    const file = await callOk<{ filename: string; data: string; encoding: string; mime: string }>(
      h,
      'reports.excel',
      { kind: 'SALES_SUMMARY', from: DAY1, to: DAY2 },
      admin.token
    );
    expect(file.filename).toBe('sales_summary-2026-03-05.xlsx');
    expect(file.encoding).toBe('base64');
    expect(file.mime).toContain('spreadsheetml');
    const buffer = Buffer.from(file.data, 'base64');
    // An .xlsx is a zip: "PK" opens every workbook.
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(2000);

    // The sheet carries the store name, the report title and a total row.
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0];
    const cells: string[] = [];
    sheet.eachRow((row) => {
      row.eachCell((value) => cells.push(String(value.text ?? value.value ?? '')));
    });
    expect(cells).toContain('Sunmart Test Store');
    expect(cells.join(' | ')).toContain('Sales Summary');
    expect(cells).toContain('Total');

    // The cashier cannot export the whole company's numbers either.
    const cashier = await makeUser(h, admin, 'CASHIER', 'rep8xls');
    const scoped = await callOk<{ data: string }>(h, 'reports.excel', { kind: 'SALES_SUMMARY' }, cashier.token);
    expect(scoped.data.length).toBeGreaterThan(0);
    const denied = await callErr(h, 'reports.excel', { kind: 'DEBTORS' }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');
    h.close();
  });

  it('prints every report with the store name, address and period', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Sunmart Test Store' });
    await seedLedger(h, admin);
    const kinds: ReportKind[] = [
      'DAILY_SUMMARY',
      'MONTHLY_SUMMARY',
      'SALES_SUMMARY',
      'PRODUCT_SALES',
      'TOP_SELLERS',
      'SLOW_MOVERS',
      'STOCK_VALUATION',
      'LOW_STOCK',
      'DEBTORS',
      'SUPPLIER_PURCHASES',
      'USER_PERFORMANCE',
      'RETURNS',
      'AUDIT',
      'DEPARTMENT_SALES',
      'PROMOTION_PERFORMANCE',
      'LOYALTY',
      'STOCKTAKE_VARIANCE',
      'VOID_OVERRIDES'
    ];
    for (const kind of kinds) {
      const report = await callOk<ReportResult>(
        h,
        'reports.build',
        { kind, month: MONTH, from: DAY1, to: DAY2 },
        admin.token
      );
      expect(report.html, kind).toContain('Sunmart Test Store');
      expect(report.html, kind).toContain(STORE_ADDRESS);
      expect(report.html, kind).toContain(report.title.replace(/&/g, '&amp;'));
      // Range reports print the period in the subtitle; a point-in-time report
      // (stock, debtors) has no date range to show.
      if (!['STOCK_VALUATION', 'LOW_STOCK', 'DEBTORS'].includes(kind)) {
        const period = kind === 'MONTHLY_SUMMARY' ? MONTH : DAY1;
        expect(report.html, kind).toContain(period);
      }
    }

    // A pharmacy edition refuses the supermarket-only reports outright.
    const pharmacy = await bootstrap('PHARMACY', { storeName: 'Grace Test Pharmacy' });
    const blocked = await callErr(pharmacy.h, 'reports.build', { kind: 'LOYALTY' }, pharmacy.admin.token);
    expect(blocked.code).toBe('EDITION_RESTRICTED');
    const pharmacyCatalogue = await callOk<ReportCatalogueEntry[]>(pharmacy.h, 'reports.catalogue', {}, pharmacy.admin.token);
    expect(pharmacyCatalogue.map((entry) => entry.kind)).toContain('WRITE_OFFS');
    expect(pharmacyCatalogue.map((entry) => entry.kind)).not.toContain('LOYALTY');
    pharmacy.h.close();
    h.close();
  });
});
