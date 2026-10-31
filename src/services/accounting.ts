/**
 * Daily and monthly accounting.
 *
 * Every figure here is derived from the immutable sale, payment, return and
 * write-off rows — nothing is pre-computed into a summary table — so a summary
 * can be re-run for any past date and always agrees with the underlying sales.
 *
 * Money is integer kobo throughout. Definitions (documented in DECISIONS §38):
 *   gross sales   Σ sale subtotals, before discounts and before VAT
 *   discounts     Σ every reduction (line + promotion + sale-level)
 *   VAT           Σ tax charged
 *   net sales     (paid revenue − VAT) − (returns − their share of VAT)
 *   COGS          cost of goods that stayed sold: sale costs less the cost of
 *                 returned goods that went back on the shelf
 *   gross profit  net sales − COGS, administrators only
 */
import type { Database } from '../db';
import type {
  DailySummary,
  MonthDayTotal,
  MonthlySummary,
  PaymentTotal,
  ReportChart,
  StoreProfile,
  SummaryTotals,
  UserSalesTotal
} from '../shared/types';
import { validation } from '../shared/errors';
import { buildSummaryDocument } from './documents';
import { monthBounds, monthDays, rangeBounds } from './helpers';

export interface SummaryQuery {
  start: string;
  end: string;
  /** Cashiers only see their own sales and their own returns. */
  scopeUserId?: number;
  /** Administrators see cost and profit; everyone else gets null. */
  includeProfit: boolean;
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  POS: 'Card / POS',
  CREDIT: 'Credit',
  SPLIT: 'Split'
};

const money = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Cost of one sale line: weighed lines carry a per-kilogram cost. */
function lineCost(costPrice: number, qty: number, isWeighed: number | boolean): number {
  return isWeighed ? Math.round((costPrice * qty) / 1000) : costPrice * qty;
}

export interface SummaryCore extends SummaryTotals {
  payments: PaymentTotal[];
  users: UserSalesTotal[];
  /** Sales revenue including VAT, before returns. */
  saleTotals: number;
}

export function summarise(db: Database, query: SummaryQuery): SummaryCore {
  const { start, end, scopeUserId, includeProfit } = query;
  const userClause = scopeUserId ? ' AND s.user_id = ?' : '';
  const userArgs = scopeUserId ? [scopeUserId] : [];

  const sales = db.handle
    .prepare(
      `SELECT s.id, s.tier, s.subtotal, s.discount, s.tax, s.total, s.user_id, s.username,
              s.promo_discount, s.item_discount
         FROM sales s
        WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}`
    )
    .all(start, end, ...userArgs) as {
    id: number;
    tier: string;
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    user_id: number | null;
    username: string;
    promo_discount: number;
    item_discount: number;
  }[];

  const saleIds = new Set(sales.map((s) => s.id));

  let grossSales = 0;
  let discounts = 0;
  let tax = 0;
  let saleTotals = 0;
  let retailSales = 0;
  let retailCount = 0;
  let wholesaleSales = 0;
  let wholesaleCount = 0;

  for (const sale of sales) {
    grossSales += money(sale.subtotal);
    discounts += money(sale.discount);
    tax += money(sale.tax);
    saleTotals += money(sale.total);
    if (sale.tier === 'WHOLESALE') {
      wholesaleSales += money(sale.total);
      wholesaleCount += 1;
    } else {
      retailSales += money(sale.total);
      retailCount += 1;
    }
  }

  /* ---- cost of goods sold ---- */
  const saleItems = db.handle
    .prepare(
      `SELECT i.sale_id, i.qty, i.cost_price, i.is_weighed
         FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}`
    )
    .all(start, end, ...userArgs) as { sale_id: number; qty: number; cost_price: number; is_weighed: number }[];

  let cogs = 0;
  for (const item of saleItems) {
    if (!saleIds.has(item.sale_id)) continue;
    cogs += lineCost(money(item.cost_price), money(item.qty), item.is_weighed);
  }

  /* ---- returns (completed in the period, dated by approval) ---- */
  const returns = db.handle
    .prepare(
      `SELECT r.total, r.refund_method, s.total AS sale_total, s.tax AS sale_tax
         FROM returns r JOIN sales s ON s.id = r.sale_id
        WHERE r.status = 'COMPLETED' AND r.approved_at BETWEEN ? AND ?
        ${scopeUserId ? 'AND r.requested_by = ?' : ''}`
    )
    .all(start, end, ...userArgs) as {
    total: number;
    refund_method: string | null;
    sale_total: number;
    sale_tax: number;
  }[];

  let returnsTotal = 0;
  let returnsTax = 0;
  for (const row of returns) {
    returnsTotal += money(row.total);
    // A credit note is a proportional share of the sale, so its VAT is too.
    returnsTax += money(row.sale_total) > 0 ? Math.round((money(row.total) * money(row.sale_tax)) / money(row.sale_total)) : 0;
  }

  const returnedItems = db.handle
    .prepare(
      `SELECT ri.qty, ri.cost_price, COALESCE(si.is_weighed, 0) AS is_weighed
         FROM return_items ri
         JOIN returns r ON r.id = ri.return_id
         LEFT JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE r.status = 'COMPLETED' AND r.approved_at BETWEEN ? AND ?
          AND COALESCE(ri.resellable, ri.restock) = 1
        ${scopeUserId ? 'AND r.requested_by = ?' : ''}`
    )
    .all(start, end, ...userArgs) as { qty: number; cost_price: number; is_weighed: number }[];

  let cogsReturned = 0;
  for (const item of returnedItems) {
    cogsReturned += lineCost(money(item.cost_price), money(item.qty), item.is_weighed);
  }
  const cogsNet = Math.max(0, cogs - cogsReturned);

  const netSalesInclVat = saleTotals - returnsTotal;
  const netSales = saleTotals - tax - (returnsTotal - returnsTax);

  /* ---- payment methods ---- */
  const paymentRows = db.handle
    .prepare(
      `SELECT p.method, COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
        GROUP BY p.method ORDER BY amount DESC`
    )
    .all(start, end, ...userArgs) as { method: string; count: number; amount: number }[];

  const payments: PaymentTotal[] = paymentRows.map((row) => ({
    method: row.method,
    label: PAYMENT_LABELS[row.method] ?? row.method,
    count: row.count,
    amount: money(row.amount)
  }));

  /* ---- sales per user ---- */
  const userMap = new Map<number, UserSalesTotal>();
  const names = db.handle.prepare('SELECT id, username, full_name FROM users').all() as {
    id: number;
    username: string;
    full_name: string;
  }[];
  const fullNameById = new Map(names.map((row) => [row.id, row.full_name]));
  for (const sale of sales) {
    const userId = sale.user_id ?? 0;
    const entry =
      userMap.get(userId) ??
      ({
        userId,
        username: sale.username,
        fullName: fullNameById.get(userId) ?? sale.username,
        salesCount: 0,
        gross: 0,
        net: 0,
        returns: 0
      } satisfies UserSalesTotal);
    entry.salesCount += 1;
    entry.gross += money(sale.subtotal);
    entry.net += money(sale.total);
    userMap.set(userId, entry);
  }
  const returnByUser = db.handle
    .prepare(
      `SELECT r.requested_by AS user_id, COALESCE(SUM(r.total), 0) AS total
         FROM returns r
        WHERE r.status = 'COMPLETED' AND r.approved_at BETWEEN ? AND ?
        ${scopeUserId ? 'AND r.requested_by = ?' : ''}
        GROUP BY r.requested_by`
    )
    .all(start, end, ...userArgs) as { user_id: number | null; total: number }[];
  for (const row of returnByUser) {
    const entry = userMap.get(row.user_id ?? 0);
    if (entry) entry.returns += money(row.total);
  }

  const core: SummaryCore = {
    salesCount: sales.length,
    retailCount,
    retailSales,
    wholesaleCount,
    wholesaleSales,
    grossSales,
    discounts,
    tax,
    returnsCount: returns.length,
    returnsTotal,
    netSales,
    netSalesInclVat,
    cogs: cogsNet,
    grossProfit: includeProfit ? netSales - cogsNet : null,
    payments,
    users: [...userMap.values()].sort((a, b) => b.net - a.net),
    saleTotals
  };
  return core;
}

export interface SummaryBuildContext {
  store: StoreProfile;
  productName: string;
  includeProfit: boolean;
}

export function dailySummary(
  db: Database,
  input: { date?: string },
  ctx: SummaryBuildContext & { scopeUserId?: number }
): DailySummary {
  const date = (input.date ?? '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validation('Choose a date to summarise.');
  const { start, end } = rangeBounds(date, date);
  const core = summarise(db, {
    start,
    end,
    includeProfit: ctx.includeProfit,
    ...(ctx.scopeUserId ? { scopeUserId: ctx.scopeUserId } : {})
  });

  const html = buildSummaryDocument({
    title: 'Daily Summary',
    subtitle: `${new Date(`${date}T12:00:00.000Z`).toLocaleDateString('en-NG', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })} (${date})`,
    store: ctx.store,
    productName: ctx.productName,
    totals: core,
    payments: core.payments,
    users: core.users,
    includeProfit: ctx.includeProfit,
    ...(ctx.scopeUserId ? { scopeNote: 'Figures for your own sales only.' } : {})
  });

  return {
    date,
    salesCount: core.salesCount,
    retailCount: core.retailCount,
    retailSales: core.retailSales,
    wholesaleCount: core.wholesaleCount,
    wholesaleSales: core.wholesaleSales,
    grossSales: core.grossSales,
    discounts: core.discounts,
    tax: core.tax,
    returnsCount: core.returnsCount,
    returnsTotal: core.returnsTotal,
    netSales: core.netSales,
    netSalesInclVat: core.netSalesInclVat,
    cogs: core.cogs,
    grossProfit: core.grossProfit,
    payments: core.payments,
    users: core.users,
    scopeUserId: ctx.scopeUserId ?? null,
    html
  };
}

export function monthlySummary(
  db: Database,
  input: { month?: string },
  ctx: SummaryBuildContext & { scopeUserId?: number }
): MonthlySummary {
  const month = (input.month ?? '').trim() || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw validation('Choose a month (YYYY-MM).');
  const { start, end } = monthBounds(month);
  const scope = ctx.scopeUserId ? { scopeUserId: ctx.scopeUserId } : {};
  const core = summarise(db, { start, end, includeProfit: ctx.includeProfit, ...scope });

  const days: MonthDayTotal[] = monthDays(month).map((date) => {
    const bounds = rangeBounds(date, date);
    const day = summarise(db, { start: bounds.start, end: bounds.end, includeProfit: ctx.includeProfit, ...scope });
    return {
      date,
      salesCount: day.salesCount,
      net: day.netSales,
      takings: day.netSalesInclVat,
      returns: day.returnsTotal,
      cogs: day.cogs,
      profit: day.grossProfit
    };
  });

  const chart: ReportChart = {
    labels: days.map((day) => String(Number(day.date.slice(8, 10)))),
    values: days.map((day) => day.takings),
    label: 'Daily takings',
    money: true
  };

  const monthLabel = new Date(`${month}-01T12:00:00.000Z`).toLocaleDateString('en-NG', {
    year: 'numeric',
    month: 'long'
  });

  const html = buildSummaryDocument({
    title: 'Monthly Summary',
    subtitle: `${monthLabel} (${month})`,
    store: ctx.store,
    productName: ctx.productName,
    totals: core,
    payments: core.payments,
    users: core.users,
    days,
    chart,
    includeProfit: ctx.includeProfit,
    ...(ctx.scopeUserId ? { scopeNote: 'Figures for your own sales only.' } : {})
  });

  return {
    month,
    from: start.slice(0, 10),
    to: end.slice(0, 10),
    salesCount: core.salesCount,
    retailCount: core.retailCount,
    retailSales: core.retailSales,
    wholesaleCount: core.wholesaleCount,
    wholesaleSales: core.wholesaleSales,
    grossSales: core.grossSales,
    discounts: core.discounts,
    tax: core.tax,
    returnsCount: core.returnsCount,
    returnsTotal: core.returnsTotal,
    netSales: core.netSales,
    netSalesInclVat: core.netSalesInclVat,
    cogs: core.cogs,
    grossProfit: core.grossProfit,
    payments: core.payments,
    days,
    chart,
    html
  };
}
