/**
 * Returns, refunds and credit notes.
 *
 * The shape of a return is fixed by the receipt it comes from:
 *   - every line is capped at what was sold minus what already came back;
 *   - the money given back is the line's share of what the customer actually
 *     paid, so line discounts, promotions, sale-level discounts, VAT and
 *     loyalty redemption are all reversed in proportion;
 *   - resellable goods go back to the exact batch they were sold from,
 *     everything else is recorded as a write-off at cost;
 *   - the store name, address and phone are copied from the SALE snapshot, so
 *     a credit note reprinted years later still shows the shop as it was.
 *
 * A return is a record, never a deletion: the original sale stays untouched
 * apart from nothing at all — the credit note links back to it by `sale_id`.
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import { repositoriesFor, type StockWriteoffRow } from '../db/repositories';
import type {
  FeatureFlags,
  ItemCondition,
  RefundMethod,
  ReturnableSale,
  ReturnInput,
  ReturnLine,
  ReturnReasonCode,
  ReturnType,
  Sale,
  SaleReturn,
  StoreProfile,
  StockWriteoff
} from '../shared/types';
import { RETURN_REASONS, RETURN_TYPES } from '../shared/types';
import { AppError, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { receiveStock, type Actor } from './stock';
import { getSale, returnedQtyForItem, type SalesActor } from './sales';
import { nextDocumentNumber, rangeBounds } from './helpers';
import { buildCreditNoteDocument } from './documents';
import { consumeApproval } from './approvals';
import { adjustLoyaltyPoints } from './marketing';

interface ReturnRow {
  id: number;
  credit_note_no: string | null;
  sale_id: number;
  customer_name: string | null;
  reason: string;
  total: number;
  status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  requested_by: number;
  requested_at: string;
  approved_by: number | null;
  approved_at: string | null;
  reject_reason: string | null;
  store_name: string;
  store_address: string;
  store_phone: string;
  return_type: ReturnType;
  reason_code: ReturnReasonCode;
  sale_receipt_no: string | null;
  refund_method: RefundMethod | null;
  exchange_note: string | null;
  discount_reversed: number;
  promo_reversed: number;
  loyalty_points_reversed: number;
  loyalty_value_reversed: number;
  window_override: number;
  approved_via: 'PIN' | 'PERMISSION' | null;
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
  net_total: number;
  batch_id: number | null;
  cost_price: number;
  restock: number;
  resellable: number;
  reason_code: ReturnReasonCode;
  writeoff_id: number | null;
  is_weighed?: number;
}

const REASON_CODES: ReturnReasonCode[] = RETURN_REASONS.map((r) => r.value);
const RETURN_TYPE_VALUES: ReturnType[] = RETURN_TYPES.map((t) => t.value);
const REFUND_METHODS: RefundMethod[] = ['CASH', 'TRANSFER', 'POS', 'STORE_CREDIT'];

const SELECT_RETURN = `
  SELECT r.*, s.receipt_no AS sale_receipt_no_joined,
    COALESCE(u1.full_name, 'Unknown') AS requested_by_name,
    u2.full_name AS approved_by_name
  FROM returns r
  JOIN sales s ON s.id = r.sale_id
  LEFT JOIN users u1 ON u1.id = r.requested_by
  LEFT JOIN users u2 ON u2.id = r.approved_by
`;

type ReturnRowJoined = ReturnRow & {
  sale_receipt_no_joined: string;
  requested_by_name: string;
  approved_by_name: string | null;
};

function mapReturn(row: ReturnRowJoined, items?: ReturnLine[]): SaleReturn {
  return {
    id: row.id,
    creditNoteNo: row.credit_note_no,
    saleId: row.sale_id,
    saleReceiptNo: row.sale_receipt_no || row.sale_receipt_no_joined,
    customerName: row.customer_name,
    reason: row.reason,
    reasonCode: (row.reason_code as ReturnReasonCode) ?? 'OTHER',
    returnType: (row.return_type as ReturnType) ?? 'REFUND',
    refundMethod: (row.refund_method as RefundMethod) ?? null,
    exchangeNote: row.exchange_note,
    total: row.total,
    discountReversed: row.discount_reversed ?? 0,
    promoReversed: row.promo_reversed ?? 0,
    loyaltyPointsReversed: row.loyalty_points_reversed ?? 0,
    loyaltyValueReversed: row.loyalty_value_reversed ?? 0,
    windowOverride: !!row.window_override,
    approvedVia: row.approved_via,
    status: row.status,
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name ?? '',
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
    .prepare(
      `SELECT ri.*, COALESCE(si.is_weighed, 0) AS is_weighed
         FROM return_items ri
         LEFT JOIN sale_items si ON si.id = ri.sale_item_id
        WHERE ri.return_id = ? ORDER BY ri.id`
    )
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
    netTotal: r.net_total ?? r.line_total,
    batchId: r.batch_id,
    costPrice: r.cost_price ?? 0,
    restock: !!r.restock,
    resellable: !!r.resellable,
    reasonCode: (r.reason_code as ReturnReasonCode) ?? 'OTHER',
    writeoffId: r.writeoff_id,
    isWeighed: !!r.is_weighed
  }));
}

export function getReturn(db: Database, id: number): SaleReturn {
  const row = db.handle.prepare(`${SELECT_RETURN} WHERE r.id = ?`).get(id) as ReturnRowJoined | undefined;
  if (!row) throw notFound('Return');
  return mapReturn(row, getReturnItems(db, id));
}

export interface ReturnQuery {
  from?: string;
  to?: string;
  status?: 'PENDING' | 'COMPLETED' | 'REJECTED';
  saleId?: number;
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
  if (query.saleId) {
    clauses.push('r.sale_id = ?');
    params.push(query.saleId);
  }
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const rows = db.handle
    .prepare(`${SELECT_RETURN} WHERE ${clauses.join(' AND ')} ORDER BY r.id DESC LIMIT ?`)
    .all(...params, limit) as ReturnRowJoined[];
  return rows.map((r) => mapReturn(r, getReturnItems(db, r.id)));
}

/* ------------------------------------------------------------------ */
/* Eligibility: what can still come back, and what it is worth         */
/* ------------------------------------------------------------------ */

const today = (): string => new Date().toISOString().slice(0, 10);

function basisOf(item: { lineTotal: number; lineDiscount: number }): number {
  return Math.max(0, item.lineTotal - item.lineDiscount);
}

/**
 * The money one returned line is worth: its share of the gross line, scaled by
 * what the customer actually paid (so promotions, the sale-level discount,
 * VAT and points spent all come back in proportion).
 */
export function moneyForReturnQty(
  sale: Sale,
  item: { lineTotal: number; lineDiscount: number; qty: number },
  qty: number
): number {
  const allBasis = (sale.items ?? []).reduce((sum, i) => sum + basisOf(i), 0);
  if (allBasis <= 0 || qty <= 0) return 0;
  const lineBasis = basisOf(item);
  if (lineBasis <= 0) return 0;
  return Math.round((lineBasis * qty * sale.total) / (item.qty * allBasis));
}

function batchInfo(db: Database, batchId: number | null): { batchNo: string | null; expiry: string | null } {
  if (!batchId) return { batchNo: null, expiry: null };
  const row = db.handle.prepare('SELECT batch_no, expiry_date FROM product_batches WHERE id = ?').get(batchId) as
    | { batch_no: string; expiry_date: string | null }
    | undefined;
  return { batchNo: row?.batch_no ?? null, expiry: row?.expiry_date ?? null };
}

/** Opens a receipt at the returns desk and explains what the cashier may do. */
export function lookupSaleForReturn(
  db: Database,
  input: { saleId?: number; receiptNo?: string },
  actor: SalesActor,
  settings: { returnLimit: number; returnWindowDays: number }
): ReturnableSale {
  let sale: Sale;
  if (input.saleId) {
    sale = getSale(db, input.saleId);
  } else if (input.receiptNo?.trim()) {
    const row = db.handle
      .prepare('SELECT id FROM sales WHERE UPPER(receipt_no) = UPPER(?) LIMIT 1')
      .get(input.receiptNo.trim()) as { id: number } | undefined;
    if (!row) throw notFound('Receipt');
    sale = getSale(db, row.id);
  } else {
    throw validation('Enter the receipt number printed on the customer’s slip.');
  }
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'Voided sales cannot be returned.');

  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(sale.createdAt)) / 86_400_000));
  const withinWindow = ageDays <= settings.returnWindowDays;

  const items = (sale.items ?? []).map((item) => {
    const alreadyReturned = returnedQtyForItem(db, item.id);
    const returnableQty = Math.max(0, item.qty - alreadyReturned);
    const perUnit = returnableQty > 0 ? moneyForReturnQty(sale, item, 1) : 0;
    const batch = batchInfo(db, item.batchId);
    return {
      saleItemId: item.id,
      name: item.name,
      sku: item.sku,
      qty: item.qty,
      alreadyReturned,
      returnableQty,
      unitPrice: item.unitPrice,
      isWeighed: item.isWeighed,
      refundPerUnit: item.isWeighed ? 0 : perUnit,
      refundPerKg: item.isWeighed ? moneyForReturnQty(sale, item, 1000) : null,
      batchId: item.batchId,
      batchNo: batch.batchNo,
      batchExpired: Boolean(batch.expiry && batch.expiry < today()),
      rxRequired: item.rxRequired
    };
  });

  // Exact value of returning every remaining unit (no rounding drift).
  const allItems = sale.items ?? [];
  const returnableValue = allItems.reduce((sum, item) => {
    const remaining = Math.max(0, item.qty - returnedQtyForItem(db, item.id));
    return sum + (remaining > 0 ? moneyForReturnQty(sale, item, remaining) : 0);
  }, 0);

  const overLimit = returnableValue > settings.returnLimit;
  const canApprove = actor.permissions.includes('returns.approve');

  return {
    sale,
    ageDays,
    windowDays: settings.returnWindowDays,
    withinWindow,
    returnableValue,
    returnLimit: settings.returnLimit,
    overLimit,
    canApprove,
    needsApproval: overLimit && !canApprove,
    needsWindowOverride: !withinWindow,
    loyaltyPointsReversedSoFar: (
      db.handle
        .prepare(
          `SELECT COALESCE(SUM(loyalty_points_reversed), 0) AS points FROM returns
           WHERE sale_id = ? AND status = 'COMPLETED'`
        )
        .get(sale.id) as { points: number }
    ).points,
    items
  };
}

/* ------------------------------------------------------------------ */
/* Creating and completing a return                                    */
/* ------------------------------------------------------------------ */

interface PreparedLine {
  saleItem: NonNullable<Sale['items']>[number];
  qty: number;
  reasonCode: ReturnReasonCode;
  resellable: boolean;
  condition: ItemCondition;
  net: number;
}

function resolveSale(db: Database, input: ReturnInput): Sale {
  if (input.saleId) return getSale(db, input.saleId);
  if (input.receiptNo?.trim()) {
    const row = db.handle
      .prepare('SELECT id FROM sales WHERE UPPER(receipt_no) = UPPER(?) LIMIT 1')
      .get(input.receiptNo.trim()) as { id: number } | undefined;
    if (!row) throw notFound('Receipt');
    return getSale(db, row.id);
  }
  throw validation('Choose the receipt this return belongs to.');
}

/** The batch's expiry date decides whether goods may go back on the shelf. */
function resellableFor(
  features: FeatureFlags,
  reasonCode: ReturnReasonCode,
  condition: ItemCondition,
  batchExpiry: string | null,
  requested: boolean
): boolean {
  if (!requested) return false;
  // An expired reason means the goods have expired, whatever the batch says.
  if (reasonCode === 'EXPIRED') return false;
  if (features.pharmacy && condition === 'OPENED') return false;
  if (batchExpiry && batchExpiry < today()) return false;
  return true;
}

/**
 * Records a return. Within the window and under the limit, a cashier's return
 * completes at once. Outside the window needs an administrator's approval
 * token (purpose RETURN_WINDOW); above the limit either the actor holds
 * `returns.approve` or an approver's token (purpose RETURN) completes it
 * immediately — without one the return waits as PENDING for the approvals
 * queue, exactly as before.
 */
export function createReturn(
  db: Database,
  input: ReturnInput,
  actor: SalesActor,
  store: StoreProfile,
  features: FeatureFlags
): { value: SaleReturn; pending: boolean; message: string } {
  const settingRows = db.handle
    .prepare("SELECT key, value FROM settings WHERE key IN ('return_limit','return_window_days')")
    .all() as { key: string; value: string }[];
  const settingsMap = new Map(settingRows.map((r) => [r.key, Number(r.value)]));
  const returnLimit = Number.isFinite(settingsMap.get('return_limit')) ? (settingsMap.get('return_limit') as number) : 2_000_000;
  const windowDays = Number.isFinite(settingsMap.get('return_window_days')) ? (settingsMap.get('return_window_days') as number) : 7;

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Select at least one item to return.');
  }
  const returnType: ReturnType = input.returnType ?? 'REFUND';
  if (!RETURN_TYPE_VALUES.includes(returnType)) throw validation('Choose a valid return type.');

  const reasonCode: ReturnReasonCode =
    input.reasonCode ?? (input.lines.find((l) => l.reasonCode)?.reasonCode as ReturnReasonCode) ?? 'OTHER';
  if (!REASON_CODES.includes(reasonCode)) throw validation('Choose a valid return reason.');

  const reasonText = (input.reason ?? '').trim();
  const reasonLabel = RETURN_REASONS.find((r) => r.value === reasonCode)?.label ?? 'Return';
  if (reasonText.length < 3 && reasonCode === 'OTHER') {
    throw validation('Give a reason for the return.');
  }

  const refundMethod: RefundMethod | null =
    returnType === 'STORE_CREDIT'
      ? 'STORE_CREDIT'
      : returnType === 'EXCHANGE'
        ? null
        : (input.refundMethod ?? 'CASH');
  if (refundMethod && !REFUND_METHODS.includes(refundMethod)) {
    throw validation('Choose how the customer is refunded.');
  }
  if (returnType === 'EXCHANGE' && !(input.exchangeNote ?? '').trim()) {
    throw validation('Say what the customer is taking in exchange.');
  }

  const sale = resolveSale(db, input);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'Voided sales cannot be returned.');
  if (sale.docType === 'INVOICE' && !actor.permissions.includes('wholesale.sell')) {
    throw new AppError('FORBIDDEN', 'You cannot process returns against wholesale invoices.');
  }

  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(sale.createdAt)) / 86_400_000));
  const withinWindow = ageDays <= windowDays;

  const prepared: PreparedLine[] = input.lines.map((line) => {
    const saleItem = (sale.items ?? []).find((i) => i.id === line.saleItemId);
    if (!saleItem) throw validation('One of the selected items is not on this receipt.');
    if (!Number.isInteger(line.qty) || line.qty <= 0) {
      throw validation('Return quantities must be positive whole numbers.');
    }
    const already = returnedQtyForItem(db, saleItem.id);
    const remaining = saleItem.qty - already;
    if (line.qty > remaining) {
      throw validation(`You can return at most ${remaining} of ${saleItem.name} (${already} already returned).`);
    }
    const lineReason = line.reasonCode ?? reasonCode;
    if (!REASON_CODES.includes(lineReason)) throw validation('Choose a valid return reason.');
    const condition: ItemCondition = line.condition === 'OPENED' ? 'OPENED' : 'SEALED';
    const batch = batchInfo(db, saleItem.batchId);
    const requested = line.resellable ?? line.restock ?? input.restock ?? true;
    return {
      saleItem,
      qty: line.qty,
      reasonCode: lineReason,
      resellable: resellableFor(features, lineReason, condition, batch.expiry, requested),
      condition,
      net: moneyForReturnQty(sale, saleItem, line.qty)
    };
  });

  const total = prepared.reduce((sum, p) => sum + p.net, 0);
  const canApprove = actor.permissions.includes('returns.approve');
  const overLimit = total > returnLimit;

  /* ---- approvals ---- */
  let approvedVia: 'PIN' | 'PERMISSION' | null = canApprove ? 'PERMISSION' : null;
  let windowOverride = false;
  let tokenSpent = false;

  if (!withinWindow) {
    if (!input.approvalToken) {
      throw new AppError(
        'APPROVAL_REQUIRED',
        `This sale is ${ageDays} day(s) old and returns are accepted within ${windowDays} day(s). An administrator can override the window.`
      );
    }
    const grant = consumeApproval(db, input.approvalToken, 'RETURN_WINDOW');
    if (!grant) throw new AppError('APPROVAL_REQUIRED', 'The return window needs an administrator’s approval.');
    windowOverride = true;
    approvedVia = 'PIN';
    tokenSpent = true;
  }

  let pending = false;
  if (overLimit && !canApprove) {
    if (input.approvalToken && !tokenSpent) {
      const grant = consumeApproval(db, input.approvalToken, 'RETURN');
      if (!grant) throw new AppError('APPROVAL_REQUIRED', 'This return is above the limit and needs approval.');
      approvedVia = 'PIN';
    } else {
      // No PIN at the counter: queue it for the approvals tab.
      pending = true;
      approvedVia = null;
    }
  }

  /* ---- proportional reversals ---- */
  const allBasis = (sale.items ?? []).reduce((sum, item) => sum + basisOf(item), 0);
  const returnedBasis = prepared.reduce((sum, p) => sum + basisOf(p.saleItem) * (p.qty / p.saleItem.qty), 0);
  const share = allBasis > 0 ? returnedBasis / allBasis : 0;
  const lineDiscountReversed = prepared.reduce(
    (sum, p) => sum + Math.round(p.saleItem.lineDiscount * (p.qty / p.saleItem.qty)),
    0
  );
  const saleLevelManual = Math.max(0, sale.discount - sale.itemDiscount - sale.promoDiscount);
  const discountReversed = lineDiscountReversed + Math.round(saleLevelManual * share);
  const promoReversed = Math.round(sale.promoDiscount * share);
  const loyaltyPointsReversed = features.supermarket ? Math.round(sale.loyaltyPoints * share) : 0;
  const loyaltyValueReversed = Math.round(sale.loyaltyValue * share);

  const requestedAt = nowIso();
  const storeName = sale.storeName || store.storeName;
  const storeAddress = sale.storeAddress || store.storeAddress;
  const storePhone = sale.storePhone || store.storePhone;

  const outcome = db.transaction(() => {
    const result = db.handle
      .prepare(
        `INSERT INTO returns
          (sale_id, sale_receipt_no, customer_name, reason, reason_code, return_type, refund_method, exchange_note,
           total, status, requested_by, requested_at, store_name, store_address, store_phone,
           discount_reversed, promo_reversed, loyalty_points_reversed, loyalty_value_reversed,
           window_override, approved_via)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sale.id,
        sale.receiptNo,
        sale.customerName,
        reasonText || reasonLabel,
        reasonCode,
        returnType,
        refundMethod,
        input.exchangeNote?.trim() || null,
        total,
        actor.userId,
        requestedAt,
        storeName,
        storeAddress,
        storePhone,
        discountReversed,
        promoReversed,
        loyaltyPointsReversed,
        loyaltyValueReversed,
        windowOverride ? 1 : 0,
        approvedVia
      );
    const returnId = Number(result.lastInsertRowid);

    const insertItem = db.handle.prepare(
      `INSERT INTO return_items
        (return_id, sale_item_id, product_id, name, qty, unit_price, line_total, net_total, batch_id, cost_price,
         restock, resellable, reason_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of prepared) {
      insertItem.run(
        returnId,
        p.saleItem.id,
        p.saleItem.productId,
        p.saleItem.name,
        p.qty,
        p.saleItem.unitPrice,
        p.saleItem.lineTotal,
        p.net,
        p.saleItem.batchId,
        p.saleItem.costPrice,
        p.resellable ? 1 : 0,
        p.resellable ? 1 : 0,
        p.reasonCode
      );
    }

    audit(db, {
      action: pending ? 'return.request' : 'return.create',
      entity: 'return',
      entityId: returnId,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: {
        saleReceiptNo: sale.receiptNo,
        total,
        reason: reasonText || reasonLabel,
        reasonCode,
        returnType,
        refundMethod,
        pending,
        windowOverride,
        approvedVia,
        lines: prepared.map((p) => ({
          saleItemId: p.saleItem.id,
          name: p.saleItem.name,
          qty: p.qty,
          reasonCode: p.reasonCode,
          resellable: p.resellable
        }))
      }
    });

    const draft = getReturn(db, returnId);
    return pending ? draft : completeReturn(db, draft, actor, features);
  });

  return {
    value: outcome,
    pending,
    message: pending
      ? `Return recorded and waiting for supervisor approval (${outcome.total > 0 ? 'over the limit' : 'no credit'}).`
      : `Credit note ${outcome.creditNoteNo} issued.`
  };
}

/* ------------------------------------------------------------------ */
/* Completion: stock, write-offs, loyalty, audit                        */
/* ------------------------------------------------------------------ */

function writeOff(
  db: Database,
  ret: SaleReturn,
  item: ReturnLine,
  actor: Actor
): number {
  const batch = batchInfo(db, item.batchId);
  const value = Math.round(item.costPrice ?? 0) * item.qty;
  const id = Number(
    repositoriesFor(db).stockWriteoffs.insert({
      return_id: ret.id,
      product_id: item.productId,
      batch_id: item.batchId,
      batch_no: batch.batchNo,
      qty: item.qty,
      cost_price: item.costPrice ?? 0,
      value,
      reason_code: item.reasonCode,
      reason: ret.reason,
      user_id: actor.userId,
      username: actor.username,
      created_at: nowIso()
    })
  );
  db.handle.prepare('UPDATE return_items SET writeoff_id = ?, restock = 0, resellable = 0 WHERE id = ?').run(id, item.id);
  return id;
}

function reverseLoyalty(db: Database, ret: SaleReturn, actor: Actor): void {
  const sale = getSale(db, ret.saleId);
  if (!sale.loyaltyMemberId || ret.loyaltyPointsReversed <= 0) return;
  const member = db.handle.prepare('SELECT id, points FROM loyalty_members WHERE id = ?').get(sale.loyaltyMemberId) as
    | { id: number; points: number }
    | undefined;
  if (!member) return;
  const points = Math.min(ret.loyaltyPointsReversed, member.points);
  if (points <= 0) return;
  adjustLoyaltyPoints(
    db,
    {
      memberId: member.id,
      points: -points,
      reason: `Reversed on ${ret.creditNoteNo ?? `return #${ret.id}`}`,
      saleId: ret.saleId
    },
    actor
  );
}

function completeReturn(db: Database, ret: SaleReturn, actor: Actor, features: FeatureFlags): SaleReturn {
  if (ret.status === 'COMPLETED') throw new AppError('CONFLICT', 'This return is already completed.');
  if (ret.status === 'REJECTED') throw new AppError('CONFLICT', 'This return was rejected.');

  const items = ret.items ?? [];
  for (const item of items) {
    if (item.restock) {
      const batch = batchInfo(db, item.batchId);
      receiveStock(db, item.productId, item.qty, {
        batchNo: batch.batchNo ?? undefined,
        expiryDate: batch.expiry,
        costPrice: item.costPrice ?? undefined,
        type: 'RETURN',
        refType: 'return',
        refId: ret.id,
        note: `${ret.reason} (${ret.creditNoteNo ?? 'credit note'})`,
        userId: actor.userId
      });
    } else {
      const id = writeOff(db, ret, item, actor);
      audit(db, {
        action: 'return.writeoff',
        entity: 'return',
        entityId: ret.id,
        userId: actor.userId,
        username: actor.username,
        severity: 'WARN',
        details: { writeoffId: id, productId: item.productId, qty: item.qty, reasonCode: item.reasonCode }
      });
    }
  }

  const creditNoteNo = ret.creditNoteNo ?? nextDocumentNumber(db, 'CN');
  db.handle
    .prepare(
      `UPDATE returns SET status = 'COMPLETED', credit_note_no = ?, approved_by = ?, approved_at = ?
       WHERE id = ?`
    )
    .run(creditNoteNo, actor.userId, nowIso(), ret.id);

  const completed = getReturn(db, ret.id);
  reverseLoyalty(db, completed, actor);

  audit(db, {
    action: 'return.complete',
    entity: 'return',
    entityId: ret.id,
    userId: actor.userId,
    username: actor.username,
    severity: 'WARN',
    details: {
      creditNoteNo,
      total: completed.total,
      saleReceiptNo: completed.saleReceiptNo,
      reason: completed.reason,
      reasonCode: completed.reasonCode,
      returnType: completed.returnType,
      refundMethod: completed.refundMethod,
      discountReversed: completed.discountReversed,
      promoReversed: completed.promoReversed,
      loyaltyPointsReversed: completed.loyaltyPointsReversed,
      resellable: completed.items?.filter((i) => i.resellable).length ?? 0,
      writtenOff: completed.items?.filter((i) => !i.resellable).length ?? 0,
      windowOverride: completed.windowOverride
    }
  });
  void features;
  return getReturn(db, ret.id);
}

export function approveReturn(
  db: Database,
  returnId: number,
  actor: SalesActor,
  features: FeatureFlags
): SaleReturn {
  if (!actor.permissions.includes('returns.approve')) {
    throw new AppError('FORBIDDEN', 'Only a supervisor or administrator can approve returns.');
  }
  return db.transaction(() => {
    const ret = getReturn(db, returnId);
    if (ret.status !== 'PENDING') throw new AppError('CONFLICT', 'This return is not pending.');
    db.handle.prepare("UPDATE returns SET approved_via = COALESCE(approved_via, 'PERMISSION') WHERE id = ?").run(returnId);
    return completeReturn(db, ret, actor, features);
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
      .prepare(`UPDATE returns SET status = 'REJECTED', approved_by = ?, approved_at = ?, reject_reason = ? WHERE id = ?`)
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

/* ------------------------------------------------------------------ */
/* Printing + write-off register                                       */
/* ------------------------------------------------------------------ */

/**
 * Renders the credit note and records the print. The first print is the
 * original; every later one is stamped DUPLICATE, exactly like a receipt.
 */
export function printReturnDocument(
  db: Database,
  input: { id: number; duplicate?: boolean },
  actor: Actor,
  productName = 'Infoflex',
  options: { poweredBy?: boolean; store?: StoreProfile } = {}
): { html: string; creditNote: SaleReturn; duplicate: boolean } {
  const ret = getReturn(db, input.id);
  if (!ret.storeName?.trim()) {
    throw new AppError(
      'PRINT_BLOCKED',
      'This credit note has no store name stored with it. An administrator must set the store name in Settings → Store profile.'
    );
  }
  const printed = db.handle
    .prepare("SELECT COUNT(*) AS n FROM document_prints WHERE return_id = ? AND kind = 'RETURN'")
    .get(ret.id) as { n: number };
  const duplicate = (input.duplicate ?? false) || printed.n > 0;

  return db.transaction(() => {
    const html = buildCreditNoteDocument(ret, options.store, productName, {
      duplicate,
      poweredBy: options.poweredBy
    });
    const now = nowIso();
    repositoriesFor(db).documentPrints.insert({
      sale_id: ret.saleId,
      layout: 'CREDIT_NOTE',
      duplicate: duplicate ? 1 : 0,
      user_id: actor.userId,
      username: actor.username,
      created_at: now,
      return_id: ret.id,
      kind: 'RETURN'
    });
    audit(db, {
      action: duplicate ? 'return.reprint' : 'return.print',
      entity: 'return',
      entityId: ret.id,
      userId: actor.userId,
      username: actor.username,
      severity: duplicate ? 'WARN' : 'INFO',
      details: { creditNoteNo: ret.creditNoteNo, duplicate }
    });
    return { html, creditNote: ret, duplicate };
  });
}

function mapWriteoff(row: StockWriteoffRow & { product_name?: string | null }): StockWriteoff {
  return {
    id: row.id,
    returnId: row.return_id,
    productId: row.product_id,
    productName: row.product_name ?? undefined,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    qty: row.qty,
    costPrice: row.cost_price,
    value: row.value,
    reasonCode: (row.reason_code as ReturnReasonCode) ?? 'OTHER',
    reason: row.reason,
    username: row.username,
    createdAt: row.created_at
  };
}

export function listWriteoffs(db: Database, query: { from?: string; to?: string; limit?: number } = {}): StockWriteoff[] {
  const { start, end } = rangeBounds(query.from, query.to);
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
  const rows = db.handle
    .prepare(
      `SELECT w.*, p.name AS product_name FROM stock_writeoffs w
       LEFT JOIN products p ON p.id = w.product_id
       WHERE w.created_at BETWEEN ? AND ? ORDER BY w.id DESC LIMIT ?`
    )
    .all(start, end, limit) as (StockWriteoffRow & { product_name: string | null })[];
  return rows.map(mapWriteoff);
}

export function getWriteoff(db: Database, id: number): StockWriteoff {
  const row = db.handle
    .prepare(
      `SELECT w.*, p.name AS product_name FROM stock_writeoffs w
       LEFT JOIN products p ON p.id = w.product_id WHERE w.id = ?`
    )
    .get(id) as (StockWriteoffRow & { product_name: string | null }) | undefined;
  if (!row) throw notFound('Write-off');
  return mapWriteoff(row);
}
