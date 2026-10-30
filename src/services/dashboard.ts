import type { Database } from '../db';
import type { DashboardSummary } from '../shared/types';
import { rangeBounds } from './helpers';
import { listStockAlerts } from './inventory';

export function getDashboard(
  db: Database,
  options: { scopeUserId?: number; expiryWindowDays?: number; trackedOnly?: boolean } = {}
): DashboardSummary {
  const today = new Date().toISOString().slice(0, 10);
  const weekStart = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const todayBounds = rangeBounds(today, today);
  const weekBounds = rangeBounds(weekStart, today);
  const scope = options.scopeUserId ? ' AND user_id = ?' : '';
  const scopeParams = options.scopeUserId ? [options.scopeUserId] : [];

  const todayRow = db.handle
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM sales
       WHERE status = 'COMPLETED' AND doc_type = 'RECEIPT' AND created_at BETWEEN ? AND ?${scope}`
    )
    .get(todayBounds.start, todayBounds.end, ...scopeParams) as { count: number; total: number };

  const weekRow = db.handle
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total FROM sales
       WHERE status = 'COMPLETED' AND created_at BETWEEN ? AND ?${scope}`
    )
    .get(weekBounds.start, weekBounds.end, ...scopeParams) as { total: number };

  const returnsRow = db.handle
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total FROM returns
       WHERE status = 'COMPLETED' AND requested_at BETWEEN ? AND ?
       ${options.scopeUserId ? 'AND requested_by = ?' : ''}`
    )
    .get(
      todayBounds.start,
      todayBounds.end,
      ...(options.scopeUserId ? [options.scopeUserId] : [])
    ) as { total: number };

  const pendingRow = db.handle
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM sales WHERE status = 'COMPLETED' AND void_requested_at IS NOT NULL) AS voids,
        (SELECT COUNT(*) FROM returns WHERE status = 'PENDING') AS returns`
    )
    .get() as { voids: number; returns: number };

  const alerts = listStockAlerts(db, options.expiryWindowDays ?? 90, {
    trackedOnly: options.trackedOnly ?? false
  });

  const recent = db.handle
    .prepare(
      `SELECT s.id, s.receipt_no, s.doc_type, s.customer_name, s.total, s.payment_method, s.status,
              s.username, s.created_at, s.void_requested_at,
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items_count
       FROM sales s WHERE 1=1${options.scopeUserId ? ' AND s.user_id = ?' : ''}
       ORDER BY s.id DESC LIMIT 8`
    )
    .all(...(options.scopeUserId ? [options.scopeUserId] : [])) as {
    id: number;
    receipt_no: string;
    doc_type: 'RECEIPT' | 'INVOICE';
    customer_name: string | null;
    total: number;
    payment_method: 'CASH' | 'TRANSFER' | 'POS' | 'SPLIT';
    status: 'COMPLETED' | 'VOIDED';
    username: string;
    created_at: string;
    void_requested_at: string | null;
    items_count: number;
  }[];

  const top = db.handle
    .prepare(
      `SELECT i.name, SUM(i.qty) AS qty, SUM(i.line_total) AS total
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?
       ${options.scopeUserId ? 'AND s.user_id = ?' : ''}
       GROUP BY i.name ORDER BY qty DESC LIMIT 5`
    )
    .all(todayBounds.start, todayBounds.end, ...(options.scopeUserId ? [options.scopeUserId] : [])) as {
    name: string;
    qty: number;
    total: number;
  }[];

  return {
    todaySales: todayRow.total,
    todayTransactions: todayRow.count,
    todayReturns: returnsRow.total,
    weekSales: weekRow.total,
    lowStockCount: alerts.lowStock.length,
    expiringCount: alerts.expiring.length,
    pendingVoids: pendingRow.voids,
    pendingReturns: pendingRow.returns,
    recentSales: recent.map((r) => ({
      id: r.id,
      receiptNo: r.receipt_no,
      docType: r.doc_type,
      customerName: r.customer_name,
      total: r.total,
      paymentMethod: r.payment_method,
      status: r.status,
      username: r.username,
      createdAt: r.created_at,
      voidRequestedAt: r.void_requested_at,
      itemsCount: r.items_count
    })),
    topProducts: top.map((t) => ({ name: t.name, qty: t.qty, total: t.total }))
  };
}
