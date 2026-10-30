import type { Database } from '../core/db';
import type { ReportKind, ReportRequest, ReportResult, StoreProfile } from '../../shared/types';
import { buildReportDocument } from './documents';
import { dayRange, rangeBounds } from './helpers';
import { listAudit } from '../core/audit';
import { listStockAlerts } from './inventory';

const KIND_TITLES: Record<ReportKind, string> = {
  SALES_SUMMARY: 'Sales Summary',
  PRODUCT_SALES: 'Product Sales',
  STOCK_VALUATION: 'Stock Valuation',
  LOW_STOCK: 'Low Stock',
  EXPIRY_WATCH: 'Expiry Watch',
  RETURNS: 'Returns & Credit Notes',
  AUDIT: 'Audit Trail'
};

export interface ReportContext {
  db: Database;
  store: StoreProfile;
  productName: string;
  /** When set, the report is limited to this user (cashier "my sales"). */
  scopeUserId?: number;
}

function money(n: number): number {
  return n;
}

export function buildReport(ctx: ReportContext, request: ReportRequest): ReportResult {
  const { db, store } = ctx;
  const kind = request.kind;
  if (!KIND_TITLES[kind]) throw new Error('Unknown report.');
  const { from, to } = dayRange(request.from, request.to);
  const { start, end } = rangeBounds(from, to);
  const scopeUserId = ctx.scopeUserId ?? request.userId;
  const userFilter = scopeUserId ? ' AND s.user_id = ' + Number(scopeUserId) : '';
  const limit = Math.min(Math.max(request.limit ?? 1000, 1), 5000);

  let columns: ReportResult['columns'] = [];
  let rows: ReportResult['rows'] = [];
  let totals: Record<string, number> = {};
  let meta: Record<string, string | number> = {};
  let subtitle = `${from} to ${to}`;

  switch (kind) {
    case 'SALES_SUMMARY': {
      const day = db.handle
        .prepare(
          `SELECT substr(s.created_at, 1, 10) AS date,
                  COUNT(*) AS transactions,
                  SUM(s.subtotal) AS gross,
                  SUM(s.discount) AS discounts,
                  SUM(s.total) AS net
           FROM sales s
           WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userFilter}
           GROUP BY date ORDER BY date DESC`
        )
        .all(start, end) as {
        date: string;
        transactions: number;
        gross: number;
        discounts: number;
        net: number;
      }[];
      const returnsRow = db.handle
        .prepare(
          `SELECT COALESCE(SUM(r.total), 0) AS total, COUNT(*) AS count FROM returns r
           WHERE r.status = 'COMPLETED' AND r.requested_at BETWEEN ? AND ?
           ${scopeUserId ? 'AND r.requested_by = ?' : ''}`
        )
        .get(...(scopeUserId ? [start, end, scopeUserId] : [start, end])) as {
        total: number;
        count: number;
      };
      const payments = db.handle
        .prepare(
          `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total FROM sales s
           WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userFilter}
           GROUP BY payment_method ORDER BY total DESC`
        )
        .all(start, end) as { payment_method: string; count: number; total: number }[];
      const byUser = db.handle
        .prepare(
          `SELECT s.username, COUNT(*) AS count, SUM(s.total) AS total FROM sales s
           WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userFilter}
           GROUP BY s.username ORDER BY total DESC`
        )
        .all(start, end) as { username: string; count: number; total: number }[];

      const gross = day.reduce((s, d) => s + d.net, 0);
      const discounts = day.reduce((s, d) => s + d.discounts, 0);
      const transactions = day.reduce((s, d) => s + d.transactions, 0);
      columns = [
        { key: 'date', label: 'Date' },
        { key: 'transactions', label: 'Sales', align: 'right' },
        { key: 'gross', label: 'Gross', align: 'right', money: true },
        { key: 'discounts', label: 'Discounts', align: 'right', money: true },
        { key: 'net', label: 'Net sales', align: 'right', money: true }
      ];
      rows = day.map((d) => ({ ...d }));
      totals = { gross, discounts, net: gross };
      meta = {
        Transactions: transactions,
        'Net sales': money(gross),
        Returns: returnsRow.total,
        'Returns count': returnsRow.count,
        'Net after returns': gross - returnsRow.total,
        'Payment split': payments.map((p) => `${p.payment_method}: ${(p.total / 100).toFixed(2)}`).join(' | ') || '—',
        'Sold by': byUser.map((u) => `${u.username} (${u.count})`).join(', ') || '—',
        ...(scopeUserId ? { Scope: 'My sales only' } : {})
      };
      break;
    }
    case 'PRODUCT_SALES': {
      const data = db.handle
        .prepare(
          `SELECT i.name, i.sku, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue,
                  SUM(i.cost_price * i.qty) AS cost
           FROM sale_items i JOIN sales s ON s.id = i.sale_id
           WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?${userFilter}
           GROUP BY i.sku, i.name ORDER BY revenue DESC LIMIT ?`
        )
        .all(start, end, limit) as {
        name: string;
        sku: string;
        qty: number;
        revenue: number;
        cost: number;
      }[];
      columns = [
        { key: 'sku', label: 'Code' },
        { key: 'name', label: 'Item' },
        { key: 'qty', label: 'Qty sold', align: 'right' },
        { key: 'revenue', label: 'Revenue', align: 'right', money: true },
        { key: 'profit', label: 'Profit', align: 'right', money: true }
      ];
      rows = data.map((d) => ({
        sku: d.sku,
        name: d.name,
        qty: d.qty,
        revenue: d.revenue,
        profit: d.revenue - d.cost
      }));
      totals = {
        qty: data.reduce((s, d) => s + d.qty, 0),
        revenue: data.reduce((s, d) => s + d.revenue, 0),
        profit: data.reduce((s, d) => s + d.revenue - d.cost, 0)
      };
      break;
    }
    case 'STOCK_VALUATION': {
      const data = db.handle
        .prepare(
          `SELECT p.sku, p.name, p.unit,
                  COALESCE(SUM(b.qty), 0) AS qty,
                  p.cost_price AS cost_price, p.price AS price
           FROM products p LEFT JOIN stock_batches b ON b.product_id = p.id
           WHERE p.active = 1
           GROUP BY p.id ORDER BY p.name COLLATE NOCASE`
        )
        .all() as {
        sku: string;
        name: string;
        unit: string;
        qty: number;
        cost_price: number;
        price: number;
      }[];
      columns = [
        { key: 'sku', label: 'Code' },
        { key: 'name', label: 'Item' },
        { key: 'qty', label: 'Qty', align: 'right' },
        { key: 'cost', label: 'Cost value', align: 'right', money: true },
        { key: 'retail', label: 'Retail value', align: 'right', money: true }
      ];
      rows = data.map((d) => ({
        sku: d.sku,
        name: d.name,
        qty: `${d.qty} ${d.unit}`,
        cost: d.qty * d.cost_price,
        retail: d.qty * d.price
      }));
      totals = {
        cost: data.reduce((s, d) => s + d.qty * d.cost_price, 0),
        retail: data.reduce((s, d) => s + d.qty * d.price, 0)
      };
      subtitle = 'Current stock at cost and retail value';
      break;
    }
    case 'LOW_STOCK': {
      const alerts = listStockAlerts(db, 0);
      columns = [
        { key: 'sku', label: 'Code' },
        { key: 'name', label: 'Item' },
        { key: 'qty', label: 'In stock', align: 'right' },
        { key: 'reorderLevel', label: 'Reorder at', align: 'right' }
      ];
      rows = alerts.lowStock.map((p) => ({
        sku: p.sku,
        name: p.name,
        qty: p.stockQty,
        reorderLevel: p.reorderLevel
      }));
      totals = { qty: rows.reduce((s, r) => s + Number(r.qty), 0) };
      subtitle = 'Items at or below their reorder level';
      break;
    }
    case 'EXPIRY_WATCH': {
      const alerts = listStockAlerts(db, 90);
      columns = [
        { key: 'sku', label: 'Code' },
        { key: 'name', label: 'Item' },
        { key: 'batchNo', label: 'Batch' },
        { key: 'expiryDate', label: 'Expiry' },
        { key: 'daysLeft', label: 'Days left', align: 'right' },
        { key: 'qty', label: 'Qty', align: 'right' }
      ];
      rows = alerts.expiring.map((e) => ({ ...e }));
      totals = { qty: alerts.expiring.reduce((s, e) => s + e.qty, 0) };
      subtitle = 'Batches expiring within 90 days (and already expired)';
      break;
    }
    case 'RETURNS': {
      const data = db.handle
        .prepare(
          `SELECT r.credit_note_no, r.requested_at, s.receipt_no, COALESCE(r.customer_name, 'Walk-in') AS customer,
                  r.total, r.status, COALESCE(u.full_name, 'Unknown') AS requested_by, r.reason
           FROM returns r JOIN sales s ON s.id = r.sale_id
           LEFT JOIN users u ON u.id = r.requested_by
           WHERE r.requested_at BETWEEN ? AND ?
           ${scopeUserId ? 'AND r.requested_by = ?' : ''}
           ORDER BY r.id DESC LIMIT ?`
        )
        .all(...(scopeUserId ? [start, end, scopeUserId, limit] : [start, end, limit])) as {
        credit_note_no: string | null;
        requested_at: string;
        receipt_no: string;
        customer: string;
        total: number;
        status: string;
        requested_by: string;
        reason: string;
      }[];
      columns = [
        { key: 'creditNoteNo', label: 'Credit note' },
        { key: 'date', label: 'Date' },
        { key: 'receiptNo', label: 'Receipt' },
        { key: 'customer', label: 'Customer' },
        { key: 'status', label: 'Status' },
        { key: 'total', label: 'Amount', align: 'right', money: true }
      ];
      rows = data.map((d) => ({
        creditNoteNo: d.credit_note_no ?? 'PENDING',
        date: d.requested_at.slice(0, 10),
        receiptNo: d.receipt_no,
        customer: d.customer,
        status: d.status,
        total: d.total
      }));
      totals = { total: data.filter((d) => d.status === 'COMPLETED').reduce((s, d) => s + d.total, 0) };
      subtitle = `Returns recorded between ${from} and ${to}`;
      break;
    }
    case 'AUDIT': {
      const entries = listAudit(db, { from, to, limit });
      columns = [
        { key: 'when', label: 'When' },
        { key: 'username', label: 'User' },
        { key: 'action', label: 'Action' },
        { key: 'entity', label: 'Entity' },
        { key: 'details', label: 'Details' }
      ];
      rows = entries.map((e) => ({
        when: e.createdAt.slice(0, 19).replace('T', ' '),
        username: e.username ?? '—',
        action: e.action,
        entity: e.entity ? `${e.entity}#${e.entityId ?? ''}` : '—',
        details: (e.details ?? '').slice(0, 160)
      }));
      subtitle = `Audit entries between ${from} and ${to}`;
      break;
    }
  }

  const title = KIND_TITLES[kind];
  const html = buildReportDocument({
    title,
    subtitle,
    columns,
    rows,
    totals,
    meta,
    storeName: store.storeName,
    storeAddress: store.storeAddress,
    storePhone: store.storePhone,
    productName: ctx.productName
  });

  return { kind, title, subtitle, columns, rows, totals, meta, html };
}
