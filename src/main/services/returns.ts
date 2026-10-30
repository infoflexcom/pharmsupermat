import type { Database } from '../core/db';
import { nowIso } from '../core/db';
import type { ReturnInput, ReturnLine, SaleReturn, StoreProfile } from '../../shared/types';
import { AppError, notFound, validation } from '../core/errors';
import { audit } from '../core/audit';
import { receiveStock, type Actor } from './stock';
import { getSale, returnedQtyForItem, type SalesActor } from './sales';
import { nextDocumentNumber, rangeBounds } from './helpers';

interface ReturnRow {
  id: number;
  credit_note_no: string | null;
  sale_id: number;
  sale_receipt_no: string;
  customer_name: string | null;
  reason: string;
  total: number;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  requested_by: number;
  requested_by_name: string;
  requested_at: string;
  approved_by: number | null;
  approved_by_name: string | null;
  approved_at: string | null;
  reject_reason: string | null;
  store_name: string;
  store_address: string;
  store_phone: string;
}

interface ReturnItemRow {
  id: number;
  return_id: number;
  sale_item_id: number;
  product_id: number;
  name: string;
  qty: number;
  unit_price: number;
  line_total: number;
  batch_id: number | null;
  cost_price: number;
  restock: number;
}

const SELECT_RETURN = `
  SELECT r.*, s.receipt_no AS sale_receipt_no,
    COALESCE(u1.full_name, 'Unknown') AS requested_by_name,
    u2.full_name AS approved_by_name
  FROM returns r
  JOIN sales s ON s.id = r.sale_id
  LEFT JOIN users u1 ON u1.id = r.requested_by
  LEFT JOIN users u2 ON u2.id = r.approved_by
`;

function mapReturn(row: ReturnRow, items?: ReturnLine[]): SaleReturn {
  return {
    id: row.id,
    creditNoteNo: row.credit_note_no,
    saleId: row.sale_id,
    saleReceiptNo: row.sale_receipt_no,
    customerName: row.customer_name,
    reason: row.reason,
    total: row.total,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedAt: row.requested_at,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at,
    rejectReason: row.reject_reason,
    storeName: row.store_name,
    storeAddress: row.store_address,
    storePhone: row.store_phone,
    items
  };
}

function getReturnItems(db: Database, returnId: number): ReturnLine[] {
  const rows = db.handle
    .prepare('SELECT * FROM return_items WHERE return_id = ? ORDER BY id')
    .all(returnId) as ReturnItemRow[];
  return rows.map((r) => ({
    id: r.id,
    returnId: r.return_id,
    saleItemId: r.sale_item_id,
    productId: r.product_id,
    name: r.name,
    qty: r.qty,
    unitPrice: r.unit_price,
    lineTotal: r.line_total,
    batchId: r.batch_id,
    restock: !!r.restock
  }));
}

export function getReturn(db: Database, id: number): SaleReturn {
  const row = db.handle.prepare(`${SELECT_RETURN} WHERE r.id = ?`).get(id) as ReturnRow | undefined;
  if (!row) throw notFound('Return');
  return mapReturn(row, getReturnItems(db, id));
}

export interface ReturnQuery {
  from?: string;
  to?: string;
  status?: 'PENDING' | 'COMPLETED' | 'REJECTED';
  limit?: number;
}

export function listReturns(db: Database, query: ReturnQuery = {}): SaleReturn[] {
  const { start, end } = rangeBounds(query.from, query.to);
  const clauses = ['r.requested_at BETWEEN ? AND ?'];
  const params: unknown[] = [start, end];
  if (query.status) {
    clauses.push('r.status = ?');
    params.push(query.status);
  }
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const rows = db.handle
    .prepare(`${SELECT_RETURN} WHERE ${clauses.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
    .all(...params, limit) as ReturnRow[];
  return rows.map((r) => mapReturn(r, getReturnItems(db, r.id)));
}

/** Puts returned goods back into the batch they were sold from. */
function restockReturn(db: Database, ret: SaleReturn, actor: Actor): void {
  for (const item of ret.items ?? []) {
    if (!item.restock) continue;
    const batch = item.batchId
      ? (db.handle
          .prepare('SELECT batch_no, expiry_date FROM stock_batches WHERE id = ?')
          .get(item.batchId) as { batch_no: string; expiry_date: string | null } | undefined)
      : undefined;
    receiveStock(db, item.productId, item.qty, {
      batchNo: batch?.batch_no ?? undefined,
      expiryDate: batch?.expiry_date ?? null,
      type: 'RETURN',
      refType: 'return',
      refId: ret.id,
      note: ret.reason,
      userId: actor.userId
    });
  }
}

function completeReturn(db: Database, ret: SaleReturn, actor: Actor): SaleReturn {
  if (ret.status === 'COMPLETED') throw new AppError('CONFLICT', 'This return is already completed.');
  if (ret.status === 'REJECTED') throw new AppError('CONFLICT', 'This return was rejected.');
  restockReturn(db, ret, actor);
  const creditNoteNo = ret.creditNoteNo ?? nextDocumentNumber(db, 'CN');
  db.handle
    .prepare(
      `UPDATE returns SET status = 'COMPLETED', credit_note_no = ?, approved_by = ?, approved_at = ?
       WHERE id = ?`
    )
    .run(creditNoteNo, actor.userId, nowIso(), ret.id);
  audit(db, {
    action: 'return.complete',
    entity: 'return',
    entityId: ret.id,
    userId: actor.userId,
    username: actor.username,
    severity: 'WARN',
    details: { creditNoteNo, total: ret.total, saleReceiptNo: ret.saleReceiptNo, reason: ret.reason }
  });
  return getReturn(db, ret.id);
}

export interface ReturnOutcome {
  value: SaleReturn;
  pending: boolean;
  message: string;
}

/**
 * Returns within the cashier limit and window complete immediately; anything
 * bigger or older becomes a PENDING credit note that a supervisor/admin must
 * approve. Approvers complete immediately.
 */
export function createReturn(
  db: Database,
  input: ReturnInput,
  actor: SalesActor,
  store: StoreProfile
): ReturnOutcome {
  if (!input.reason || input.reason.trim().length < 3) {
    throw validation('Give a reason for the return.');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Select at least one item to return.');
  }
  const sale = getSale(db, input.saleId);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'Voided sales cannot be returned.');
  if (sale.docType === 'INVOICE' && !actor.permissions.includes('wholesale.sell')) {
    throw new AppError('FORBIDDEN', 'You cannot process returns against wholesale invoices.');
  }

  const saleAgeDays = (Date.now() - Date.parse(sale.createdAt)) / 86_400_000;
  const requestedAt = nowIso();

  const prepared = input.lines.map((line) => {
    const saleItem = (sale.items ?? []).find((i) => i.id === line.saleItemId);
    if (!saleItem) throw validation('One of the selected items is not on this receipt.');
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw validation('Return quantities must be positive whole numbers.');
    }
    const already = returnedQtyForItem(db, saleItem.id);
    const remaining = saleItem.qty - already;
    if (line.qty > remaining) {
      throw validation(
        `You can return at most ${remaining} of ${saleItem.name} (${already} already returned).`
      );
    }
    return { saleItem, qty: line.qty, restock: line.restock ?? input.restock ?? true };
  });

  const total = prepared.reduce((sum, p) => sum + p.qty * p.saleItem.unitPrice, 0);
  const canApprove = actor.permissions.includes('returns.approve');
  const withinLimit = total <= store.returnLimit;
  const withinWindow = saleAgeDays <= store.returnWindowDays;
  const pending = !canApprove && !(withinLimit && withinWindow);

  const created = db.transaction(() => {
    const result = db.handle
      .prepare(
        `INSERT INTO returns
          (sale_id, customer_name, reason, total, status, requested_by, requested_at, store_name, store_address, store_phone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sale.id,
        sale.customerName,
        input.reason.trim(),
        total,
        'PENDING',
        actor.userId,
        requestedAt,
        store.storeName,
        store.storeAddress,
        store.storePhone
      );
    const returnId = Number(result.lastInsertRowid);
    const insertItem = db.handle.prepare(
      `INSERT INTO return_items (return_id, sale_item_id, product_id, name, qty, unit_price, line_total, batch_id, cost_price, restock)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of prepared) {
      insertItem.run(
        returnId,
        p.saleItem.id,
        p.saleItem.productId,
        p.saleItem.name,
        p.qty,
        p.saleItem.unitPrice,
        p.qty * p.saleItem.unitPrice,
        p.saleItem.batchId,
        p.saleItem.costPrice,
        p.restock ? 1 : 0
      );
    }
    audit(db, {
      action: pending ? 'return.request' : 'return.create',
      entity: 'return',
      entityId: returnId,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { saleReceiptNo: sale.receiptNo, total, reason: input.reason.trim(), pending }
    });
    const draft = getReturn(db, returnId);
    return pending ? draft : completeReturn(db, draft, actor);
  });

  return {
    value: created,
    pending,
    message: pending
      ? `Credit note ${created.id} recorded and waiting for supervisor approval.`
      : `Credit note ${created.creditNoteNo} issued.`
  };
}

export function approveReturn(db: Database, returnId: number, actor: SalesActor): SaleReturn {
  if (!actor.permissions.includes('returns.approve')) {
    throw new AppError('FORBIDDEN', 'Only a supervisor or administrator can approve returns.');
  }
  return db.transaction(() => {
    const ret = getReturn(db, returnId);
    if (ret.status !== 'PENDING') throw new AppError('CONFLICT', 'This return is not pending.');
    return completeReturn(db, ret, actor);
  });
}

export function rejectReturn(
  db: Database,
  returnId: number,
  reason: string,
  actor: SalesActor
): SaleReturn {
  if (!actor.permissions.includes('returns.approve')) {
    throw new AppError('FORBIDDEN', 'Only a supervisor or administrator can reject returns.');
  }
  if (!reason?.trim()) throw validation('Give a reason for rejecting the return.');
  return db.transaction(() => {
    const ret = getReturn(db, returnId);
    if (ret.status !== 'PENDING') throw new AppError('CONFLICT', 'This return is not pending.');
    db.handle
      .prepare(
        `UPDATE returns SET status = 'REJECTED', approved_by = ?, approved_at = ?, reject_reason = ? WHERE id = ?`
      )
      .run(actor.userId, nowIso(), reason.trim(), returnId);
    audit(db, {
      action: 'return.reject',
      entity: 'return',
      entityId: returnId,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { reason: reason.trim(), total: ret.total }
    });
    return getReturn(db, returnId);
  });
}
