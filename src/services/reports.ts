/**
 * The report catalogue.
 *
 * Every report is a plain query against the shop's own database plus the same
 * printable HTML envelope, so the screen, the printer, the PDF and the CSV all
 * show the customer's store name, address and the period being reported.
 *
 * Feature rules live here *and* in the main-process registry: a pharmacy-only
 * report cannot be built on a supermarket licence even if a caller asks for it
 * directly, and money that only an administrator may see (cost and profit) is
 * never selected for anybody else.
 */
import type { Database } from '../db';
import type {
  FeatureFlags,
  ReportCatalogueEntry,
  ReportChart,
  ReportKind,
  ReportRequest,
  ReportResult,
  ReportColumn,
  StoreProfile
} from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { buildReportDocument } from './documents';
import { dayRange, rangeBounds } from './helpers';
import { listAudit } from './audit';
import { listStockAlerts } from './inventory';
import { dailySummary, monthlySummary } from './accounting';

export const REPORT_CATALOGUE: ReportCatalogueEntry[] = [
  {
    kind: 'DAILY_SUMMARY',
    label: 'Daily summary',
    description: 'Any date: sales, payments, returns, cost and profit.',
    owner: 'SHARED'
  },
  {
    kind: 'MONTHLY_SUMMARY',
    label: 'Monthly summary',
    description: 'Any month: the month’s totals, a day-by-day table and chart.',
    owner: 'SHARED'
  },
  {
    kind: 'SALES_SUMMARY',
    label: 'Sales by day',
    description: 'Day-by-day takings, discounts and cashier split over a period.',
    owner: 'SHARED'
  },
  {
    kind: 'PRODUCT_SALES',
    label: 'Product sales',
    description: 'Units sold, revenue and profit per product.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  { kind: 'TOP_SELLERS', label: 'Top sellers', description: 'The ten best-selling lines in the period.', owner: 'SHARED' },
  {
    kind: 'SLOW_MOVERS',
    label: 'Slow movers',
    description: 'Stock that did not sell in the period, with the money tied up in it.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  {
    kind: 'STOCK_VALUATION',
    label: 'Stock valuation',
    description: 'Current stock at cost and retail value.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  { kind: 'LOW_STOCK', label: 'Low stock', description: 'Items at or below their reorder level.', owner: 'SHARED' },
  {
    kind: 'DEBTORS',
    label: 'Debtors & credit',
    description: 'Customers owing money on credit invoices.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  {
    kind: 'SUPPLIER_PURCHASES',
    label: 'Supplier purchases',
    description: 'What was bought from each supplier in the period.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  {
    kind: 'USER_PERFORMANCE',
    label: 'User performance',
    description: 'Sales, averages, returns and voids per user.',
    permission: 'reports.view.all',
    owner: 'SHARED'
  },
  { kind: 'RETURNS', label: 'Returns & credit notes', description: 'Every return with its type, reason and value.', owner: 'SHARED' },
  {
    kind: 'AUDIT',
    label: 'Audit trail',
    description: 'Who did what, in order.',
    owner: 'SHARED',
    permission: 'audit.view'
  },
  {
    kind: 'EXPIRY_WATCH',
    label: 'Expiry watch',
    description: 'Batches expiring in the next 90 days (and already expired).',
    owner: 'PHARMACY'
  },
  {
    kind: 'WRITE_OFFS',
    label: 'Write-offs',
    description: 'Goods returned as unsellable, at cost, with the reason.',
    permission: 'reports.view.all',
    owner: 'PHARMACY'
  },
  {
    kind: 'DEPARTMENT_SALES',
    label: 'Sales by department',
    description: 'Revenue and units per supermarket department.',
    permission: 'reports.view.all',
    owner: 'SUPERMARKET'
  },
  {
    kind: 'PROMOTION_PERFORMANCE',
    label: 'Promotion performance',
    description: 'What each promotion sold and what it cost in discount.',
    permission: 'reports.view.all',
    owner: 'SUPERMARKET'
  },
  {
    kind: 'LOYALTY',
    label: 'Loyalty report',
    description: 'Points earned and spent per member.',
    permission: 'reports.view.all',
    owner: 'SUPERMARKET'
  },
  {
    kind: 'STOCKTAKE_VARIANCE',
    label: 'Stocktake variance',
    description: 'Counted quantities against the system, with the value of the difference.',
    permission: 'reports.view.all',
    owner: 'SUPERMARKET'
  },
  {
    kind: 'VOID_OVERRIDES',
    label: 'Voids & overrides',
    description: 'Voided sales and every supervisor override, with who approved them.',
    permission: 'reports.view.all',
    owner: 'SUPERMARKET'
  }
];

const CATALOGUE = new Map<ReportKind, ReportCatalogueEntry>(REPORT_CATALOGUE.map((entry) => [entry.kind, entry]));

export function catalogueEntry(kind: ReportKind): ReportCatalogueEntry {
  const entry = CATALOGUE.get(kind);
  if (!entry) throw validation('Unknown report.');
  return entry;
}

/** The main process enforces the edition before a report is even built. */
export function assertReportAllowed(kind: ReportKind, features: FeatureFlags): ReportCatalogueEntry {
  const entry = catalogueEntry(kind);
  if (entry.owner === 'PHARMACY' && !features.pharmacy) {
    throw new AppError('EDITION_RESTRICTED', 'This report belongs to the pharmacy module, which is not enabled.');
  }
  if (entry.owner === 'SUPERMARKET' && !features.supermarket) {
    throw new AppError('EDITION_RESTRICTED', 'This report belongs to the supermarket module, which is not enabled.');
  }
  return entry;
}

export interface ReportContext {
  db: Database;
  store: StoreProfile;
  productName: string;
  /** When set, the report is limited to this user (cashier “my sales”). */
  scopeUserId?: number;
  /** Cost and profit columns are selected only for an administrator. */
  includeProfit: boolean;
  features: FeatureFlags;
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  POS: 'Card / POS',
  CREDIT: 'Credit',
  SPLIT: 'Split'
};

const money = (value: unknown): number => (typeof value === 'number' ? value : 0);

function lineCost(costPrice: number, qty: number, isWeighed: number | boolean): number {
  return isWeighed ? Math.round((costPrice * qty) / 1000) : costPrice * qty;
}

function chartOf(labels: string[], values: number[], label: string): ReportChart {
  return { labels, values, label, money: true };
}

interface Built {
  kind: ReportKind;
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number>;
  meta: Record<string, string | number>;
  chart?: ReportChart;
}

export function buildReport(ctx: ReportContext, request: ReportRequest): ReportResult {
  const { db } = ctx;
  const entry = assertReportAllowed(request.kind, ctx.features);
  const { from, to } = dayRange(request.from, request.to);
  const { start, end } = rangeBounds(from, to);
  const scopeUserId = ctx.scopeUserId ?? request.userId;
  const userClause = scopeUserId ? ` AND s.user_id = ${Number(scopeUserId)}` : '';
  const limit = Math.min(Math.max(request.limit ?? 1000, 1), 5000);
  const scopeNote: Record<string, string | number> = scopeUserId ? { Scope: 'My sales only' } : {};

  const built = ((): Built => {
    switch (request.kind) {
      /* ---------------- daily / monthly ---------------- */
      case 'DAILY_SUMMARY': {
        const summary = dailySummary(
          db,
          { date: from },
          {
            store: ctx.store,
            productName: ctx.productName,
            includeProfit: ctx.includeProfit,
            ...(scopeUserId ? { scopeUserId } : {})
          }
        );
        return {
          kind: request.kind,
          title: 'Daily Summary',
          subtitle: `Trading day ${from}`,
          columns: [
            { key: 'user', label: 'User' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'gross', label: 'Gross', align: 'right', money: true },
            { key: 'takings', label: 'Takings', align: 'right', money: true },
            { key: 'returns', label: 'Returns', align: 'right', money: true }
          ],
          rows: summary.users.map((user) => ({
            user: `${user.fullName} (${user.username})`,
            sales: user.salesCount,
            gross: user.gross,
            takings: user.net,
            returns: user.returns
          })),
          totals: {
            sales: summary.salesCount,
            gross: summary.grossSales,
            takings: summary.netSalesInclVat,
            returns: summary.returnsTotal
          },
          meta: {
            Transactions: summary.salesCount,
            'Gross sales': summary.grossSales,
            Discounts: summary.discounts,
            VAT: summary.tax,
            Returns: summary.returnsTotal,
            'Net sales (ex VAT)': summary.netSales,
            'Takings (incl VAT)': summary.netSalesInclVat,
            'Cost of goods sold': summary.cogs,
            ...(ctx.includeProfit ? { 'Gross profit': summary.grossProfit ?? 0 } : {}),
            'Retail vs wholesale': `${summary.retailCount} / ${summary.wholesaleCount}`,
            'Payment split':
              summary.payments.map((p) => `${p.label}: ${(p.amount / 100).toFixed(2)}`).join(' | ') || '—',
            ...scopeNote
          },
          html: summary.html
        } as Built & { html: string };
      }
      case 'MONTHLY_SUMMARY': {
        const summary = monthlySummary(
          db,
          { month: request.month ?? (from.slice(0, 7) === to.slice(0, 7) ? from.slice(0, 7) : undefined) },
          {
            store: ctx.store,
            productName: ctx.productName,
            includeProfit: ctx.includeProfit,
            ...(scopeUserId ? { scopeUserId } : {})
          }
        );
        return {
          kind: request.kind,
          title: 'Monthly Summary',
          subtitle: `${summary.from} to ${summary.to}`,
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'net', label: 'Net sales', align: 'right', money: true },
            { key: 'takings', label: 'Takings', align: 'right', money: true },
            { key: 'returns', label: 'Returns', align: 'right', money: true },
            { key: 'cost', label: 'Cost', align: 'right', money: true },
            ...(ctx.includeProfit ? [{ key: 'profit', label: 'Profit', align: 'right' as const, money: true }] : [])
          ],
          rows: summary.days.map((day) => ({
            date: day.date,
            sales: day.salesCount,
            net: day.net,
            takings: day.takings,
            returns: day.returns,
            cost: day.cogs,
            ...(ctx.includeProfit ? { profit: day.profit ?? 0 } : {})
          })),
          totals: {
            sales: summary.salesCount,
            net: summary.netSales,
            takings: summary.netSalesInclVat,
            returns: summary.returnsTotal,
            cost: summary.cogs,
            ...(ctx.includeProfit ? { profit: summary.grossProfit ?? 0 } : {})
          },
          meta: {
            Period: `${summary.from} to ${summary.to}`,
            Transactions: summary.salesCount,
            'Gross sales': summary.grossSales,
            Discounts: summary.discounts,
            VAT: summary.tax,
            Returns: summary.returnsTotal,
            'Net sales (ex VAT)': summary.netSales,
            'Takings (incl VAT)': summary.netSalesInclVat,
            'Cost of goods sold': summary.cogs,
            ...(ctx.includeProfit ? { 'Gross profit': summary.grossProfit ?? 0 } : {}),
            'Payment split':
              summary.payments.map((p) => `${p.label}: ${(p.amount / 100).toFixed(2)}`).join(' | ') || '—',
            ...scopeNote
          },
          chart: summary.chart,
          html: summary.html
        } as Built & { html: string };
      }

      /* ---------------- day by day ---------------- */
      case 'SALES_SUMMARY': {
        const day = db.handle
          .prepare(
            `SELECT substr(s.created_at, 1, 10) AS date,
                    COUNT(*) AS transactions,
                    SUM(s.subtotal) AS gross,
                    SUM(s.discount) AS discounts,
                    SUM(s.total) AS net
             FROM sales s
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
             GROUP BY date ORDER BY date DESC`
          )
          .all(start, end) as { date: string; transactions: number; gross: number; discounts: number; net: number }[];
        const returnsRow = db.handle
          .prepare(
            `SELECT COALESCE(SUM(r.total), 0) AS total, COUNT(*) AS count FROM returns r
             WHERE r.status = 'COMPLETED' AND r.approved_at BETWEEN ? AND ?
             ${scopeUserId ? 'AND r.requested_by = ?' : ''}`
          )
          .get(...(scopeUserId ? [start, end, scopeUserId] : [start, end])) as { total: number; count: number };
        const payments = db.handle
          .prepare(
            `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total FROM sales s
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
             GROUP BY payment_method ORDER BY total DESC`
          )
          .all(start, end) as { payment_method: string; count: number; total: number }[];
        const byUser = db.handle
          .prepare(
            `SELECT s.username, COUNT(*) AS count, SUM(s.total) AS total FROM sales s
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
             GROUP BY s.username ORDER BY total DESC`
          )
          .all(start, end) as { username: string; count: number; total: number }[];

        const net = day.reduce((sum, row) => sum + money(row.net), 0);
        const discounts = day.reduce((sum, row) => sum + money(row.discounts), 0);
        const transactions = day.reduce((sum, row) => sum + row.transactions, 0);
        const chronological = [...day].reverse();
        return {
          kind: request.kind,
          title: 'Sales Summary',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'transactions', label: 'Sales', align: 'right' },
            { key: 'gross', label: 'Gross', align: 'right', money: true },
            { key: 'discounts', label: 'Discounts', align: 'right', money: true },
            { key: 'net', label: 'Net sales', align: 'right', money: true }
          ],
          rows: day.map((row) => ({ ...row })),
          totals: { gross: net, discounts, net },
          meta: {
            Transactions: transactions,
            'Net sales': net,
            Returns: returnsRow.total,
            'Returns count': returnsRow.count,
            'Net after returns': net - returnsRow.total,
            'Payment split':
              payments.map((p) => `${PAYMENT_LABELS[p.payment_method] ?? p.payment_method}: ${(p.total / 100).toFixed(2)}`).join(' | ') || '—',
            'Sold by': byUser.map((u) => `${u.username} (${u.count})`).join(', ') || '—',
            ...scopeNote
          },
          chart: chartOf(chronological.map((row) => row.date.slice(5)), chronological.map((row) => money(row.net)), 'Daily net sales')
        };
      }

      /* ---------------- products ---------------- */
      case 'PRODUCT_SALES':
      case 'TOP_SELLERS': {
        const data = db.handle
          .prepare(
            `SELECT i.name, i.sku, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue,
                    SUM(CASE WHEN i.is_weighed = 1 THEN ROUND(i.cost_price * i.qty / 1000.0) ELSE i.cost_price * i.qty END) AS cost
             FROM sale_items i JOIN sales s ON s.id = i.sale_id
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
             GROUP BY i.sku, i.name ORDER BY qty DESC, revenue DESC LIMIT ?`
          )
          .all(start, end, request.kind === 'TOP_SELLERS' ? 10 : limit) as {
          name: string;
          sku: string;
          qty: number;
          revenue: number;
          cost: number;
        }[];
        const rows = data.map((row) => ({
          sku: row.sku,
          name: row.name,
          qty: row.qty,
          revenue: money(row.revenue),
          ...(ctx.includeProfit ? { profit: money(row.revenue) - money(row.cost) } : {})
        }));
        return {
          kind: request.kind,
          title: request.kind === 'TOP_SELLERS' ? 'Top Sellers' : 'Product Sales',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'sku', label: 'Code' },
            { key: 'name', label: 'Item' },
            { key: 'qty', label: 'Qty sold', align: 'right' },
            { key: 'revenue', label: 'Revenue', align: 'right', money: true },
            ...(ctx.includeProfit ? [{ key: 'profit', label: 'Profit', align: 'right' as const, money: true }] : [])
          ],
          rows,
          totals: {
            qty: data.reduce((sum, row) => sum + money(row.qty), 0),
            revenue: data.reduce((sum, row) => sum + money(row.revenue), 0),
            ...(ctx.includeProfit
              ? { profit: data.reduce((sum, row) => sum + money(row.revenue) - money(row.cost), 0) }
              : {})
          },
          meta: { Items: data.length, ...scopeNote }
        };
      }
      case 'SLOW_MOVERS': {
        const data = db.handle
          .prepare(
            `SELECT p.sku, p.name, COALESCE(SUM(b.qty), 0) AS qty, p.cost_price,
                    (SELECT MAX(s.created_at) FROM sale_items i JOIN sales s ON s.id = i.sale_id
                      WHERE i.product_id = p.id AND s.status = 'COMPLETED') AS last_sold,
                    (SELECT COALESCE(SUM(i.qty), 0) FROM sale_items i JOIN sales s ON s.id = i.sale_id
                      WHERE i.product_id = p.id AND s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?) AS sold
             FROM products p LEFT JOIN product_batches b ON b.product_id = p.id
             WHERE p.active = 1
             GROUP BY p.id ORDER BY p.name COLLATE NOCASE`
          )
          .all(start, end) as {
          sku: string;
          name: string;
          qty: number;
          cost_price: number;
          last_sold: string | null;
          sold: number;
        }[];
        const slow = data
          .filter((row) => money(row.sold) === 0 && money(row.qty) > 0)
          .sort((a, b) => money(b.qty) * money(b.cost_price) - money(a.qty) * money(a.cost_price))
          .slice(0, limit);
        return {
          kind: request.kind,
          title: 'Slow Movers',
          subtitle: `No sales between ${from} and ${to}`,
          columns: [
            { key: 'sku', label: 'Code' },
            { key: 'name', label: 'Item' },
            { key: 'qty', label: 'In stock', align: 'right' },
            ...(ctx.includeProfit
              ? [
                  { key: 'costPrice', label: 'Unit cost', align: 'right' as const, money: true },
                  { key: 'tiedUp', label: 'Money tied up', align: 'right' as const, money: true }
                ]
              : []),
            { key: 'lastSold', label: 'Last sold' }
          ],
          rows: slow.map((row) => ({
            sku: row.sku,
            name: row.name,
            qty: row.qty,
            ...(ctx.includeProfit
              ? { costPrice: money(row.cost_price), tiedUp: money(row.qty) * money(row.cost_price) }
              : {}),
            lastSold: row.last_sold ? row.last_sold.slice(0, 10) : 'Never'
          })),
          totals: {
            qty: slow.reduce((sum, row) => sum + money(row.qty), 0),
            ...(ctx.includeProfit
              ? { tiedUp: slow.reduce((sum, row) => sum + money(row.qty) * money(row.cost_price), 0) }
              : {})
          },
          meta: { Items: slow.length }
        };
      }
      case 'STOCK_VALUATION': {
        const data = db.handle
          .prepare(
            `SELECT p.sku, p.name, p.unit, COALESCE(SUM(b.qty), 0) AS qty, p.cost_price, p.price
             FROM products p LEFT JOIN product_batches b ON b.product_id = p.id
             WHERE p.active = 1 GROUP BY p.id ORDER BY p.name COLLATE NOCASE`
          )
          .all() as { sku: string; name: string; unit: string; qty: number; cost_price: number; price: number }[];
        return {
          kind: request.kind,
          title: 'Stock Valuation',
          subtitle: 'Current stock at cost and retail value',
          columns: [
            { key: 'sku', label: 'Code' },
            { key: 'name', label: 'Item' },
            { key: 'qty', label: 'Qty', align: 'right' },
            ...(ctx.includeProfit ? [{ key: 'cost', label: 'Cost value', align: 'right' as const, money: true }] : []),
            { key: 'retail', label: 'Retail value', align: 'right', money: true }
          ],
          rows: data.map((row) => ({
            sku: row.sku,
            name: row.name,
            qty: `${row.qty} ${row.unit}`,
            ...(ctx.includeProfit ? { cost: money(row.qty) * money(row.cost_price) } : {}),
            retail: money(row.qty) * money(row.price)
          })),
          totals: {
            ...(ctx.includeProfit
              ? { cost: data.reduce((sum, row) => sum + money(row.qty) * money(row.cost_price), 0) }
              : {}),
            retail: data.reduce((sum, row) => sum + money(row.qty) * money(row.price), 0)
          },
          meta: { Products: data.length }
        };
      }
      case 'LOW_STOCK': {
        const alerts = listStockAlerts(db, 0);
        return {
          kind: request.kind,
          title: 'Low Stock',
          subtitle: 'Items at or below their reorder level',
          columns: [
            { key: 'sku', label: 'Code' },
            { key: 'name', label: 'Item' },
            { key: 'qty', label: 'In stock', align: 'right' },
            { key: 'reorderLevel', label: 'Reorder at', align: 'right' }
          ],
          rows: alerts.lowStock.map((p) => ({ sku: p.sku, name: p.name, qty: p.stockQty, reorderLevel: p.reorderLevel })),
          totals: { qty: alerts.lowStock.reduce((sum, p) => sum + p.stockQty, 0) },
          meta: { Items: alerts.lowStock.length }
        };
      }

      /* ---------------- debt & suppliers ---------------- */
      case 'DEBTORS': {
        const data = db.handle
          .prepare(
            `SELECT COALESCE(c.name, s.customer_name, 'Walk-in') AS customer,
                    COALESCE(c.phone, s.customer_phone, '') AS phone,
                    COUNT(*) AS invoices, SUM(s.balance_due) AS due,
                    MIN(s.created_at) AS oldest, MAX(s.created_at) AS newest,
                    COALESCE(c.credit_limit, 0) AS credit_limit
             FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
             WHERE s.status = 'COMPLETED' AND s.balance_due > 0
             GROUP BY customer, phone ORDER BY due DESC`
          )
          .all() as {
          customer: string;
          phone: string;
          invoices: number;
          due: number;
          oldest: string;
          newest: string;
          credit_limit: number;
        }[];
        return {
          kind: request.kind,
          title: 'Debtors & Credit',
          subtitle: 'Outstanding credit invoices as at today',
          columns: [
            { key: 'customer', label: 'Customer' },
            { key: 'phone', label: 'Phone' },
            { key: 'invoices', label: 'Invoices', align: 'right' },
            { key: 'due', label: 'Owing', align: 'right', money: true },
            { key: 'creditLimit', label: 'Credit limit', align: 'right', money: true },
            { key: 'oldest', label: 'Oldest invoice' }
          ],
          rows: data.map((row) => ({
            customer: row.customer,
            phone: row.phone || '—',
            invoices: row.invoices,
            due: money(row.due),
            creditLimit: money(row.credit_limit),
            oldest: row.oldest?.slice(0, 10) ?? '—'
          })),
          totals: { invoices: data.reduce((sum, row) => sum + row.invoices, 0), due: data.reduce((sum, row) => sum + money(row.due), 0) },
          meta: { Customers: data.length }
        };
      }
      case 'SUPPLIER_PURCHASES': {
        const data = db.handle
          .prepare(
            `SELECT COALESCE(supplier_name, 'Unnamed supplier') AS supplier, COUNT(*) AS invoices,
                    COALESCE(SUM(total), 0) AS total, COALESCE(SUM(amount_paid), 0) AS paid
             FROM purchases
             WHERE purchase_date BETWEEN ? AND ? AND status <> 'CANCELLED'
             GROUP BY supplier ORDER BY total DESC`
          )
          .all(from, to) as { supplier: string; invoices: number; total: number; paid: number }[];
        return {
          kind: request.kind,
          title: 'Supplier Purchases',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'supplier', label: 'Supplier' },
            { key: 'invoices', label: 'Deliveries', align: 'right' },
            { key: 'total', label: 'Value', align: 'right', money: true },
            { key: 'paid', label: 'Paid', align: 'right', money: true },
            { key: 'balance', label: 'Balance', align: 'right', money: true }
          ],
          rows: data.map((row) => ({
            supplier: row.supplier,
            invoices: row.invoices,
            total: money(row.total),
            paid: money(row.paid),
            balance: money(row.total) - money(row.paid)
          })),
          totals: {
            invoices: data.reduce((sum, row) => sum + row.invoices, 0),
            total: data.reduce((sum, row) => sum + money(row.total), 0),
            paid: data.reduce((sum, row) => sum + money(row.paid), 0),
            balance: data.reduce((sum, row) => sum + money(row.total) - money(row.paid), 0)
          },
          meta: { Suppliers: data.length }
        };
      }

      /* ---------------- people ---------------- */
      case 'USER_PERFORMANCE': {
        const sales = db.handle
          .prepare(
            `SELECT s.user_id, s.username, COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS total,
                    COALESCE(SUM((SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                                  WHERE p.sale_id = s.id AND p.method = 'CASH')), 0) AS cash
             FROM sales s
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userClause}
             GROUP BY s.user_id, s.username ORDER BY total DESC`
          )
          .all(start, end) as { user_id: number; username: string; count: number; total: number; cash: number }[];
        const returns = db.handle
          .prepare(
            `SELECT r.requested_by AS user_id, COUNT(*) AS count, COALESCE(SUM(r.total), 0) AS total
             FROM returns r WHERE r.status = 'COMPLETED' AND r.approved_at BETWEEN ? AND ?
             ${scopeUserId ? 'AND r.requested_by = ?' : ''} GROUP BY r.requested_by`
          )
          .all(...(scopeUserId ? [start, end, scopeUserId] : [start, end])) as {
          user_id: number | null;
          count: number;
          total: number;
        }[];
        const voids = db.handle
          .prepare(
            `SELECT voided_by AS user_id, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
             FROM sales WHERE status = 'VOIDED' AND voided_at BETWEEN ? AND ?
             ${scopeUserId ? 'AND user_id = ?' : ''} GROUP BY voided_by`
          )
          .all(...(scopeUserId ? [start, end, scopeUserId] : [start, end])) as {
          user_id: number | null;
          count: number;
          total: number;
        }[];
        const userNames = new Map(
          (db.handle.prepare('SELECT id, full_name FROM users').all() as { id: number; full_name: string }[]).map((row) => [
            row.id,
            row.full_name
          ])
        );
        const rows = sales.map((row) => {
          const ret = returns.find((r) => (r.user_id ?? 0) === (row.user_id ?? 0));
          const vd = voids.find((v) => (v.user_id ?? 0) === (row.user_id ?? 0));
          return {
            user: `${userNames.get(row.user_id) ?? row.username} (${row.username})`,
            count: row.count,
            total: money(row.total),
            average: row.count > 0 ? Math.round(money(row.total) / row.count) : 0,
            cash: money(row.cash),
            returns: money(ret?.total ?? 0),
            returnsCount: ret?.count ?? 0,
            voids: vd?.count ?? 0,
            voidValue: money(vd?.total ?? 0)
          };
        });
        return {
          kind: request.kind,
          title: 'User Performance',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'user', label: 'User' },
            { key: 'count', label: 'Sales', align: 'right' },
            { key: 'total', label: 'Takings', align: 'right', money: true },
            { key: 'average', label: 'Average sale', align: 'right', money: true },
            { key: 'cash', label: 'Cash taken', align: 'right', money: true },
            { key: 'returns', label: 'Returns', align: 'right', money: true },
            { key: 'voids', label: 'Voids', align: 'right' }
          ],
          rows,
          totals: {
            count: rows.reduce((sum, row) => sum + row.count, 0),
            total: rows.reduce((sum, row) => sum + row.total, 0),
            returns: rows.reduce((sum, row) => sum + row.returns, 0),
            voids: rows.reduce((sum, row) => sum + row.voids, 0)
          },
          meta: scopeNote
        };
      }

      /* ---------------- returns & write-offs ---------------- */
      case 'RETURNS': {
        const data = db.handle
          .prepare(
            `SELECT r.credit_note_no, r.requested_at, r.approved_at, s.receipt_no,
                    COALESCE(r.customer_name, 'Walk-in') AS customer, r.total, r.status,
                    r.return_type, r.reason_code, r.reason, COALESCE(u.full_name, 'Unknown') AS requested_by
             FROM returns r JOIN sales s ON s.id = r.sale_id
             LEFT JOIN users u ON u.id = r.requested_by
             WHERE r.requested_at BETWEEN ? AND ?
             ${scopeUserId ? 'AND r.requested_by = ?' : ''}
             ORDER BY r.id DESC LIMIT ?`
          )
          .all(...(scopeUserId ? [start, end, scopeUserId, limit] : [start, end, limit])) as {
          credit_note_no: string | null;
          requested_at: string;
          approved_at: string | null;
          receipt_no: string;
          customer: string;
          total: number;
          status: string;
          return_type: string;
          reason_code: string;
          reason: string;
          requested_by: string;
        }[];
        return {
          kind: request.kind,
          title: 'Returns & Credit Notes',
          subtitle: `Returns recorded between ${from} and ${to}`,
          columns: [
            { key: 'creditNoteNo', label: 'Credit note' },
            { key: 'date', label: 'Date' },
            { key: 'receiptNo', label: 'Receipt' },
            { key: 'customer', label: 'Customer' },
            { key: 'type', label: 'Type' },
            { key: 'reason', label: 'Reason' },
            { key: 'status', label: 'Status' },
            { key: 'total', label: 'Amount', align: 'right', money: true }
          ],
          rows: data.map((row) => ({
            creditNoteNo: row.credit_note_no ?? 'PENDING',
            date: row.requested_at.slice(0, 10),
            receiptNo: row.receipt_no,
            customer: row.customer,
            type: row.return_type,
            reason: row.reason_code,
            status: row.status,
            total: money(row.total)
          })),
          totals: { total: data.filter((row) => row.status === 'COMPLETED').reduce((sum, row) => sum + money(row.total), 0) },
          meta: { Returns: data.length, ...scopeNote }
        };
      }
      case 'EXPIRY_WATCH': {
        const alerts = listStockAlerts(db, 90);
        return {
          kind: request.kind,
          title: 'Expiry Watch',
          subtitle: 'Batches expiring within 90 days (and already expired)',
          columns: [
            { key: 'sku', label: 'Code' },
            { key: 'name', label: 'Item' },
            { key: 'batchNo', label: 'Batch' },
            { key: 'expiryDate', label: 'Expiry' },
            { key: 'daysLeft', label: 'Days left', align: 'right' },
            { key: 'qty', label: 'Qty', align: 'right' }
          ],
          rows: alerts.expiring.map((row) => ({ ...row })),
          totals: { qty: alerts.expiring.reduce((sum, row) => sum + row.qty, 0) },
          meta: { Batches: alerts.expiring.length }
        };
      }
      case 'WRITE_OFFS': {
        const data = db.handle
          .prepare(
            `SELECT w.created_at, COALESCE(p.name, 'Item #' || w.product_id) AS name, w.batch_no,
                    w.qty, w.cost_price, w.value, w.reason_code, COALESCE(w.username, '—') AS username
             FROM stock_writeoffs w LEFT JOIN products p ON p.id = w.product_id
             WHERE w.created_at BETWEEN ? AND ? ORDER BY w.id DESC LIMIT ?`
          )
          .all(start, end, limit) as {
          created_at: string;
          name: string;
          batch_no: string | null;
          qty: number;
          cost_price: number;
          value: number;
          reason_code: string;
          username: string;
        }[];
        return {
          kind: request.kind,
          title: 'Write-offs',
          subtitle: `Unsellable goods written off ${from} to ${to}`,
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'name', label: 'Item' },
            { key: 'batchNo', label: 'Batch' },
            { key: 'qty', label: 'Qty', align: 'right' },
            { key: 'cost', label: 'Unit cost', align: 'right', money: true },
            { key: 'value', label: 'Written off', align: 'right', money: true },
            { key: 'reason', label: 'Reason' },
            { key: 'username', label: 'By' }
          ],
          rows: data.map((row) => ({
            date: row.created_at.slice(0, 10),
            name: row.name,
            batchNo: row.batch_no ?? '—',
            qty: row.qty,
            cost: money(row.cost_price),
            value: money(row.value),
            reason: row.reason_code,
            username: row.username
          })),
          totals: { qty: data.reduce((sum, row) => sum + row.qty, 0), value: data.reduce((sum, row) => sum + money(row.value), 0) },
          meta: { Lines: data.length }
        };
      }

      /* ---------------- supermarket module ---------------- */
      case 'DEPARTMENT_SALES': {
        const data = db.handle
          .prepare(
            `SELECT COALESCE(d.name, p.category, 'Unassigned') AS department,
                    i.qty, i.cost_price, i.line_total, i.line_discount, i.is_weighed, i.sale_id
             FROM sale_items i
             JOIN sales s ON s.id = i.sale_id
             LEFT JOIN products p ON p.id = i.product_id
             LEFT JOIN departments d ON d.id = p.department_id
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?`
          )
          .all(start, end) as {
          department: string;
          qty: number;
          cost_price: number;
          line_total: number;
          line_discount: number;
          is_weighed: number;
          sale_id: number;
        }[];
        const groups = new Map<string, { department: string; qty: number; revenue: number; cost: number; sales: Set<number> }>();
        for (const row of data) {
          const entry =
            groups.get(row.department) ??
            { department: row.department, qty: 0, revenue: 0, cost: 0, sales: new Set<number>() };
          entry.qty += money(row.qty);
          // line_discount already carries the promotion, so subtracting it once is right.
          entry.revenue += money(row.line_total) - money(row.line_discount);
          entry.cost += lineCost(money(row.cost_price), money(row.qty), row.is_weighed);
          entry.sales.add(row.sale_id);
          groups.set(row.department, entry);
        }
        const rows = [...groups.values()].sort((a, b) => b.revenue - a.revenue);
        return {
          kind: request.kind,
          title: 'Sales by Department',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'department', label: 'Department' },
            { key: 'sales', label: 'Sales', align: 'right' },
            { key: 'qty', label: 'Units', align: 'right' },
            { key: 'revenue', label: 'Revenue', align: 'right', money: true },
            ...(ctx.includeProfit ? [{ key: 'profit', label: 'Profit', align: 'right' as const, money: true }] : [])
          ],
          rows: rows.map((row) => ({
            department: row.department,
            sales: row.sales.size,
            qty: row.qty,
            revenue: row.revenue,
            ...(ctx.includeProfit ? { profit: row.revenue - row.cost } : {})
          })),
          totals: {
            qty: rows.reduce((sum, row) => sum + row.qty, 0),
            revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
            ...(ctx.includeProfit ? { profit: rows.reduce((sum, row) => sum + row.revenue - row.cost, 0) } : {})
          },
          meta: { Departments: rows.length },
          chart: chartOf(rows.map((row) => row.department), rows.map((row) => row.revenue), 'Revenue by department')
        };
      }
      case 'PROMOTION_PERFORMANCE': {
        const data = db.handle
          .prepare(
            `SELECT i.promotion_id, COALESCE(i.promotion_name, 'Promotion') AS name,
                    i.unit_price, i.qty, i.line_total, i.line_discount, i.is_weighed
             FROM sale_items i JOIN sales s ON s.id = i.sale_id
             WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ? AND i.promotion_id IS NOT NULL`
          )
          .all(start, end) as {
          promotion_id: number;
          name: string;
          unit_price: number;
          qty: number;
          line_total: number;
          line_discount: number;
          is_weighed: number;
        }[];
        const groups = new Map<number, { name: string; lines: number; qty: number; revenue: number; discount: number }>();
        for (const row of data) {
          const entry = groups.get(row.promotion_id) ?? { name: row.name, lines: 0, qty: 0, revenue: 0, discount: 0 };
          entry.lines += 1;
          entry.qty += money(row.qty);
          // line_discount already carries the promotion, so it is counted once.
          entry.discount += money(row.line_discount);
          entry.revenue += money(row.line_total) - money(row.line_discount);
          groups.set(row.promotion_id, entry);
        }
        const rows = [...groups.entries()].map(([id, entry]) => ({ id, ...entry })).sort((a, b) => b.revenue - a.revenue);
        return {
          kind: request.kind,
          title: 'Promotion Performance',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'name', label: 'Promotion' },
            { key: 'lines', label: 'Lines', align: 'right' },
            { key: 'qty', label: 'Units', align: 'right' },
            { key: 'revenue', label: 'Revenue', align: 'right', money: true },
            { key: 'discount', label: 'Discount given', align: 'right', money: true }
          ],
          rows: rows.map((row) => ({
            name: row.name,
            lines: row.lines,
            qty: row.qty,
            revenue: row.revenue,
            discount: row.discount
          })),
          totals: {
            lines: rows.reduce((sum, row) => sum + row.lines, 0),
            qty: rows.reduce((sum, row) => sum + row.qty, 0),
            revenue: rows.reduce((sum, row) => sum + row.revenue, 0),
            discount: rows.reduce((sum, row) => sum + row.discount, 0)
          },
          meta: { Promotions: rows.length }
        };
      }
      case 'LOYALTY': {
        const data = db.handle
          .prepare(
            `SELECT m.name, m.phone, m.points AS balance,
                    COALESCE(SUM(CASE WHEN t.points_change > 0 THEN t.points_change ELSE 0 END), 0) AS earned,
                    COALESCE(SUM(CASE WHEN t.points_change < 0 THEN -t.points_change ELSE 0 END), 0) AS redeemed,
                    COUNT(t.id) AS movements
             FROM loyalty_members m LEFT JOIN loyalty_transactions t
               ON t.member_id = m.id AND t.created_at BETWEEN ? AND ?
             GROUP BY m.id ORDER BY earned DESC, m.name COLLATE NOCASE LIMIT ?`
          )
          .all(start, end, limit) as {
          name: string;
          phone: string | null;
          balance: number;
          earned: number;
          redeemed: number;
          movements: number;
        }[];
        return {
          kind: request.kind,
          title: 'Loyalty Report',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'name', label: 'Member' },
            { key: 'phone', label: 'Phone' },
            { key: 'earned', label: 'Earned', align: 'right' },
            { key: 'redeemed', label: 'Redeemed', align: 'right' },
            { key: 'balance', label: 'Balance', align: 'right' },
            { key: 'movements', label: 'Movements', align: 'right' }
          ],
          rows: data.map((row) => ({
            name: row.name,
            phone: row.phone ?? '—',
            earned: money(row.earned),
            redeemed: money(row.redeemed),
            balance: money(row.balance),
            movements: row.movements
          })),
          totals: {
            earned: data.reduce((sum, row) => sum + money(row.earned), 0),
            redeemed: data.reduce((sum, row) => sum + money(row.redeemed), 0),
            balance: data.reduce((sum, row) => sum + money(row.balance), 0)
          },
          meta: { Members: data.length }
        };
      }
      case 'STOCKTAKE_VARIANCE': {
        const data = db.handle
          .prepare(
            `SELECT count_no, created_at, posted_at, status, items_counted, variance_qty, variance_value, username
             FROM stock_counts WHERE created_at BETWEEN ? AND ? ORDER BY id DESC LIMIT ?`
          )
          .all(start, end, limit) as {
          count_no: string;
          created_at: string;
          posted_at: string | null;
          status: string;
          items_counted: number;
          variance_qty: number;
          variance_value: number;
          username: string;
        }[];
        return {
          kind: request.kind,
          title: 'Stocktake Variance',
          subtitle: `Counts recorded ${from} to ${to}`,
          columns: [
            { key: 'countNo', label: 'Count' },
            { key: 'date', label: 'Date' },
            { key: 'status', label: 'Status' },
            { key: 'items', label: 'Items', align: 'right' },
            { key: 'varianceQty', label: 'Qty variance', align: 'right' },
            { key: 'varianceValue', label: 'Value variance', align: 'right', money: true },
            { key: 'username', label: 'By' }
          ],
          rows: data.map((row) => ({
            countNo: row.count_no,
            date: (row.posted_at ?? row.created_at).slice(0, 10),
            status: row.status,
            items: row.items_counted,
            varianceQty: row.variance_qty,
            varianceValue: money(row.variance_value),
            username: row.username
          })),
          totals: {
            items: data.reduce((sum, row) => sum + row.items_counted, 0),
            varianceQty: data.reduce((sum, row) => sum + row.variance_qty, 0),
            varianceValue: data.reduce((sum, row) => sum + money(row.variance_value), 0)
          },
          meta: { Counts: data.length }
        };
      }
      case 'VOID_OVERRIDES': {
        const voids = db.handle
          .prepare(
            `SELECT s.receipt_no, s.voided_at, s.total, s.void_reason, s.username,
                    COALESCE(a.full_name, '—') AS approved_by
             FROM sales s LEFT JOIN users a ON a.id = s.approved_by
             WHERE s.status = 'VOIDED' AND s.voided_at BETWEEN ? AND ?
             ORDER BY s.voided_at DESC LIMIT ?`
          )
          .all(start, end, limit) as {
          receipt_no: string;
          voided_at: string;
          total: number;
          void_reason: string | null;
          username: string;
          approved_by: string;
        }[];
        const approvals = db.handle
          .prepare(
            `SELECT created_at, username, details FROM audit_log
             WHERE action = 'pos.approval' AND created_at BETWEEN ? AND ?
             ORDER BY id DESC LIMIT ?`
          )
          .all(start, end, limit) as { created_at: string; username: string; details: string | null }[];
        const rows: Record<string, string | number | null>[] = [];
        for (const row of voids) {
          rows.push({
            when: (row.voided_at ?? '').slice(0, 16).replace('T', ' '),
            type: 'VOID',
            reference: row.receipt_no,
            user: row.username,
            approver: row.approved_by,
            amount: money(row.total),
            note: row.void_reason ?? ''
          });
        }
        for (const row of approvals) {
          let detail: { purpose?: string; approvedBy?: string; reason?: string | null } = {};
          try {
            detail = row.details ? (JSON.parse(row.details) as typeof detail) : {};
          } catch {
            detail = {};
          }
          rows.push({
            when: row.created_at.slice(0, 16).replace('T', ' '),
            type: `OVERRIDE${detail.purpose ? ` (${detail.purpose})` : ''}`,
            reference: '—',
            user: row.username,
            approver: detail.approvedBy ?? '—',
            amount: 0,
            note: detail.reason ?? ''
          });
        }
        rows.sort((a, b) => String(b.when).localeCompare(String(a.when)));
        return {
          kind: request.kind,
          title: 'Voids & Overrides',
          subtitle: `${from} to ${to}`,
          columns: [
            { key: 'when', label: 'When' },
            { key: 'type', label: 'Type' },
            { key: 'reference', label: 'Reference' },
            { key: 'user', label: 'Requested by' },
            { key: 'approver', label: 'Approved by' },
            { key: 'amount', label: 'Value', align: 'right', money: true },
            { key: 'note', label: 'Note' }
          ],
          rows,
          totals: {
            amount: voids.reduce((sum, row) => sum + money(row.total), 0),
            voids: voids.length,
            overrides: approvals.length
          },
          meta: { Voided: voids.length, Overrides: approvals.length }
        };
      }

      /* ---------------- audit ---------------- */
      case 'AUDIT': {
        const entries = listAudit(db, { from, to, limit });
        return {
          kind: request.kind,
          title: 'Audit Trail',
          subtitle: `Audit entries between ${from} and ${to}`,
          columns: [
            { key: 'when', label: 'When' },
            { key: 'username', label: 'User' },
            { key: 'action', label: 'Action' },
            { key: 'entity', label: 'Entity' },
            { key: 'details', label: 'Details' }
          ],
          rows: entries.map((entry) => ({
            when: entry.createdAt.slice(0, 19).replace('T', ' '),
            username: entry.username ?? '—',
            action: entry.action,
            entity: entry.entity ? `${entry.entity}#${entry.entityId ?? ''}` : '—',
            details: (entry.details ?? '').slice(0, 160)
          })),
          totals: { entries: entries.length },
          meta: { Entries: entries.length }
        };
      }
      default:
        throw validation('Unknown report.');
    }
  })() as Built & { html?: string };

  const html =
    built.html ??
    buildReportDocument({
      title: built.title,
      subtitle: built.subtitle,
      columns: built.columns,
      rows: built.rows,
      totals: built.totals,
      meta: built.meta,
      ...(built.chart ? { chart: built.chart } : {}),
      storeName: ctx.store.storeName,
      storeAddress: ctx.store.storeAddress,
      storePhone: ctx.store.storePhone,
      storeEmail: ctx.store.storeEmail,
      storeLicenceNo: ctx.store.storeLicenceNo,
      storeVatNo: ctx.store.storeVatNo,
      storeLogo: ctx.store.storeLogo,
      productName: ctx.productName
    });

  return {
    kind: built.kind,
    title: built.title,
    subtitle: built.subtitle,
    columns: built.columns,
    rows: built.rows,
    totals: built.totals,
    meta: built.meta,
    ...(built.chart ? { chart: built.chart } : {}),
    owner: entry.owner,
    html
  };
}
