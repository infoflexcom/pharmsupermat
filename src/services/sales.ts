import type { Database } from '../db';
import { nowIso } from '../db';
import type {
  FeatureFlags,
  PaymentMethod,
  Sale,
  SaleInput,
  SaleItem,
  SaleSummary,
  StoreProfile
} from '../shared/types';
import { AppError, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { allocateStock, commitSaleAllocation, receiveStock, type Actor } from './stock';
import { requireProduct } from './products';
import { nextDocumentNumber, rangeBounds } from './helpers';
import { getStoreProfile } from './settings';

export interface SalesActor extends Actor {
  permissions: readonly string[];
}

interface SaleRow {
  id: number;
  receipt_no: string;
  doc_type: 'RECEIPT' | 'INVOICE';
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  prescription_ref: string | null;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  amount_paid: number;
  change_due: number;
  payment_method: PaymentMethod;
  status: 'COMPLETED' | 'VOIDED';
  void_reason: string | null;
  void_requested_by: number | null;
  void_requested_at: string | null;
  voided_by: number | null;
  voided_at: string | null;
  approved_by: number | null;
  user_id: number;
  username: string;
  store_name: string;
  store_address: string;
  store_phone: string;
  note: string | null;
  created_at: string;
  customer_id: number | null;
  loyalty_member_id: number | null;
  shift_id: number | null;
}

interface SaleItemRow {
  id: number;
  sale_id: number;
  product_id: number;
  sku: string;
  name: string;
  qty: number;
  unit_price: number;
  list_price: number;
  cost_price: number;
  line_total: number;
  batch_id: number | null;
  batch_no: string | null;
  rx_required: number;
  is_weighed: number;
}

function mapItem(row: SaleItemRow): SaleItem {
  return {
    id: row.id,
    saleId: row.sale_id,
    productId: row.product_id,
    sku: row.sku,
    name: row.name,
    qty: row.qty,
    unitPrice: row.unit_price,
    listPrice: row.list_price,
    costPrice: row.cost_price,
    lineTotal: row.line_total,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    rxRequired: !!row.rx_required,
    isWeighed: !!row.is_weighed
  };
}

function mapSale(
  row: SaleRow,
  items?: SaleItem[],
  payments: { id: number; method: string; amount: number; reference: string | null }[] = []
): Sale {
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    docType: row.doc_type,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
    prescriptionRef: row.prescription_ref,
    subtotal: row.subtotal,
    discount: row.discount,
    tax: row.tax,
    total: row.total,
    amountPaid: row.amount_paid,
    changeDue: row.change_due,
    paymentMethod: row.payment_method,
    status: row.status,
    voidReason: row.void_reason,
    voidRequestedBy: row.void_requested_by,
    voidRequestedAt: row.void_requested_at,
    voidedBy: row.voided_by,
    voidedAt: row.voided_at,
    approvedBy: row.approved_by,
    userId: row.user_id,
    username: row.username,
    storeName: row.store_name,
    storeAddress: row.store_address,
    storePhone: row.store_phone,
    note: row.note,
    createdAt: row.created_at,
    customerId: row.customer_id,
    loyaltyMemberId: row.loyalty_member_id,
    shiftId: row.shift_id,
    payments,
    items
  };
}

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'POS', 'SPLIT'];

export function createSale(
  db: Database,
  input: SaleInput,
  actor: SalesActor,
  features: FeatureFlags
): Sale {
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw validation('Add at least one item to the sale.');
  }
  if (!PAYMENT_METHODS.includes(input.paymentMethod)) {
    throw validation('Choose a valid payment method.');
  }
  if (input.docType === 'INVOICE' && !features.wholesale) {
    throw new AppError('EDITION_RESTRICTED', 'Wholesale invoicing is not enabled for this edition.');
  }
  if (input.docType === 'INVOICE' && !actor.permissions.includes('wholesale.sell')) {
    throw new AppError('FORBIDDEN', 'You are not allowed to raise wholesale invoices.');
  }
  if (!Number.isInteger(input.amountPaid) || input.amountPaid < 0) {
    throw validation('Amount paid is invalid.');
  }
  const splitPayments = input.payments ?? [];
  if (splitPayments.length) {
    if (splitPayments.some((p) => !PAYMENT_METHODS.includes(p.method) || !Number.isInteger(p.amount) || p.amount <= 0)) {
      throw validation('Each split payment needs a valid method and a positive amount.');
    }
    const splitTotal = splitPayments.reduce((sum, p) => sum + p.amount, 0);
    if (splitTotal !== input.amountPaid) {
      throw validation('Split payments must add up to the amount tendered.');
    }
  }

  const store: StoreProfile = getStoreProfile(db);
  if (!store.storeName) {
    throw new AppError('SETUP_REQUIRED', 'Complete first-run setup before making sales.');
  }

  return db.transaction(() => {
    const now = nowIso();
    const created: { productId: number; allocation: ReturnType<typeof allocateStock>[number]; row: SaleItemRow }[] = [];
    let priceOverridden = false;
    let needsPrescription = false;

    for (const line of input.lines) {
      if (!Number.isInteger(line.qty) || line.qty <= 0) {
        throw validation('Quantities must be positive whole numbers.');
      }
      const product = requireProduct(db, line.productId);
      // Weighed goods are sold per kilogram. The cart sends the weight in grams
      // (an integer) so the ledger and the line maths stay exact.
      const weighed = product.isWeighed && product.pricePerKg !== null;
      if (product.isWeighed && product.pricePerKg === null) {
        throw validation(`${product.name} is set up as a weighed item but has no price per kg.`);
      }
      const listPrice = weighed
        ? (product.pricePerKg as number)
        : input.docType === 'INVOICE'
          ? product.wholesalePrice
          : product.price;
      const unitPrice = line.unitPrice ?? listPrice;
      if (!Number.isInteger(unitPrice) || unitPrice < 0) throw validation('Unit price is invalid.');
      if (unitPrice !== listPrice) {
        if (!actor.permissions.includes('prices.override')) {
          throw new AppError(
            'APPROVAL_REQUIRED',
            `${product.name}: price override on ${(listPrice / 100).toFixed(2)} needs a supervisor.`
          );
        }
        priceOverridden = true;
      }
      if (product.rxRequired) needsPrescription = true;

      const allocation = allocateStock(db, product.id, line.qty, product.name);
      // Placeholder salId (0) is patched when writing the line rows below.
      for (const part of allocation) {
        created.push({
          productId: product.id,
          allocation: part,
          row: {
            id: 0,
            sale_id: 0,
            product_id: product.id,
            sku: product.sku,
            name: product.name,
            qty: part.qty,
            unit_price: unitPrice,
            list_price: listPrice,
            cost_price: part.costPrice,
            line_total: weighed ? Math.round((part.qty * unitPrice) / 1000) : part.qty * unitPrice,
            batch_id: part.batchId,
            batch_no: part.batchNo,
            rx_required: product.rxRequired ? 1 : 0,
            is_weighed: weighed ? 1 : 0
          }
        });
      }
    }

    if (features.prescriptions && needsPrescription && !input.prescriptionRef?.trim()) {
      throw validation('A prescription reference is required for prescription-only items.', {
        rxRequired: true
      });
    }

    const subtotal = created.reduce((sum, item) => sum + item.row.line_total, 0);
    const discount = input.discount ?? 0;
    if (!Number.isInteger(discount) || discount < 0) throw validation('Discount is invalid.');
    if (discount > subtotal) throw validation('Discount cannot be more than the subtotal.');
    const total = subtotal - discount;

    if (input.amountPaid < total) {
      throw validation('Amount paid is less than the total due.');
    }
    const changeDue = input.amountPaid - total;

    const receiptNo = nextDocumentNumber(db, input.docType === 'INVOICE' ? 'INV' : 'RCP');

    const result = db.handle
      .prepare(
        `INSERT INTO sales
          (receipt_no, doc_type, customer_name, customer_phone, customer_address, prescription_ref,
           subtotal, discount, tax, total, amount_paid, change_due, payment_method, status,
           price_override_by, user_id, username, store_name, store_address, store_phone, note, created_at,
           customer_id, loyalty_member_id, shift_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        receiptNo,
        input.docType,
        input.customerName?.trim() || null,
        input.customerPhone?.trim() || null,
        input.customerAddress?.trim() || null,
        input.prescriptionRef?.trim() || null,
        subtotal,
        discount,
        total,
        input.amountPaid,
        changeDue,
        input.paymentMethod,
        priceOverridden ? actor.userId : null,
        actor.userId,
        actor.username,
        store.storeName,
        store.storeAddress,
        store.storePhone,
        input.note?.trim() || null,
        now,
        input.customerId ?? null,
        input.loyaltyMemberId ?? null,
        input.shiftId ?? null
      );
    const saleId = Number(result.lastInsertRowid);

    const insertPayment = db.handle.prepare(
      'INSERT INTO payments (sale_id, method, amount, reference, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    if (splitPayments.length) {
      for (const payment of splitPayments) {
        insertPayment.run(saleId, payment.method, payment.amount, payment.reference?.trim() || null, actor.userId, now);
      }
    } else {
      insertPayment.run(saleId, input.paymentMethod, total, null, actor.userId, now);
    }

    const insertItem = db.handle.prepare(
      `INSERT INTO sale_items
        (sale_id, product_id, sku, name, qty, unit_price, list_price, cost_price, line_total, batch_id, batch_no,
         rx_required, is_weighed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of created) {
      insertItem.run(
        saleId,
        item.row.product_id,
        item.row.sku,
        item.row.name,
        item.row.qty,
        item.row.unit_price,
        item.row.list_price,
        item.row.cost_price,
        item.row.line_total,
        item.row.batch_id,
        item.row.batch_no,
        item.row.rx_required,
        item.row.is_weighed
      );
      commitSaleAllocation(db, item.productId, item.allocation, {
        refType: 'sale',
        refId: saleId,
        userId: actor.userId
      });
    }

    audit(db, {
      action: input.docType === 'INVOICE' ? 'sale.invoice' : 'sale.create',
      entity: 'sale',
      entityId: saleId,
      userId: actor.userId,
      username: actor.username,
      severity: priceOverridden ? 'WARN' : 'INFO',
      details: {
        receiptNo,
        total,
        discount,
        items: created.length,
        paymentMethod: input.paymentMethod,
        priceOverridden,
        customer: input.customerName ?? null,
        prescriptionRef: input.prescriptionRef ?? null
      }
    });

    return getSale(db, saleId);
  });
}

export function getSale(db: Database, id: number): Sale {
  const row = db.handle.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SaleRow | undefined;
  if (!row) throw notFound('Sale');
  const items = db.handle
    .prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id')
    .all(id) as SaleItemRow[];
  const payments = db.handle
    .prepare('SELECT id, method, amount, reference FROM payments WHERE sale_id = ? ORDER BY id')
    .all(id) as { id: number; method: string; amount: number; reference: string | null }[];
  return mapSale(row, items.map(mapItem), payments);
}

export interface SaleQuery {
  from?: string;
  to?: string;
  userId?: number;
  search?: string;
  status?: 'COMPLETED' | 'VOIDED';
  docType?: 'RECEIPT' | 'INVOICE';
  pendingVoids?: boolean;
  limit?: number;
}

export function listSales(db: Database, query: SaleQuery = {}): SaleSummary[] {
  const { start, end } = rangeBounds(query.from, query.to);
  const clauses: string[] = ['s.created_at BETWEEN ? AND ?'];
  const params: unknown[] = [start, end];
  if (query.userId) {
    clauses.push('s.user_id = ?');
    params.push(query.userId);
  }
  if (query.status) {
    clauses.push('s.status = ?');
    params.push(query.status);
  }
  if (query.docType) {
    clauses.push('s.doc_type = ?');
    params.push(query.docType);
  }
  if (query.pendingVoids) clauses.push('s.void_requested_at IS NOT NULL AND s.status = \'COMPLETED\'');
  if (query.search && query.search.trim()) {
    const like = `%${query.search.trim()}%`;
    clauses.push('(s.receipt_no LIKE ? OR IFNULL(s.customer_name, \'\') LIKE ? OR s.username LIKE ?)');
    params.push(like, like, like);
  }
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 2000);
  const rows = db.handle
    .prepare(
      `SELECT s.id, s.receipt_no, s.doc_type, s.customer_name, s.total, s.payment_method, s.status,
              s.username, s.created_at, s.void_requested_at,
              (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS items_count
       FROM sales s WHERE ${clauses.join(' AND ')} ORDER BY s.id DESC LIMIT ?`
    )
    .all(...params, limit) as {
    id: number;
    receipt_no: string;
    doc_type: 'RECEIPT' | 'INVOICE';
    customer_name: string | null;
    total: number;
    payment_method: PaymentMethod;
    status: 'COMPLETED' | 'VOIDED';
    username: string;
    created_at: string;
    void_requested_at: string | null;
    items_count: number;
  }[];
  return rows.map((r) => ({
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
  }));
}

/** Reverses stock for every line of a sale (used by void and restore paths). */
function restockSale(db: Database, sale: Sale, actor: Actor, reason: string): void {
  for (const item of sale.items ?? []) {
    // Return the goods to the exact batch (and expiry) they came from.
    const batch = item.batchId
      ? (db.handle
          .prepare('SELECT batch_no, expiry_date FROM product_batches WHERE id = ?')
          .get(item.batchId) as { batch_no: string; expiry_date: string | null } | undefined)
      : undefined;
    receiveStock(db, item.productId, item.qty, {
      batchNo: batch?.batch_no ?? item.batchNo ?? undefined,
      expiryDate: batch?.expiry_date ?? null,
      costPrice: item.costPrice,
      type: 'SALE_VOID',
      refType: 'sale',
      refId: sale.id,
      note: reason,
      userId: actor.userId
    });
  }
}

function applyVoid(db: Database, sale: Sale, reason: string, actor: Actor, approvedBy?: number): Sale {
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'This sale is already voided.');
  restockSale(db, sale, actor, reason);
  db.handle
    .prepare(
      `UPDATE sales SET status = 'VOIDED', void_reason = ?, voided_by = ?, voided_at = ?,
         approved_by = ?, void_requested_by = NULL, void_requested_at = NULL WHERE id = ?`
    )
    .run(reason, actor.userId, nowIso(), approvedBy ?? actor.userId, sale.id);
  audit(db, {
    action: 'sale.void',
    entity: 'sale',
    entityId: sale.id,
    userId: actor.userId,
    username: actor.username,
    severity: 'WARN',
    details: { receiptNo: sale.receiptNo, total: sale.total, reason, approvedBy: approvedBy ?? actor.userId }
  });
  return getSale(db, sale.id);
}

/**
 * A cashier can only *request* a void; an approver (admin or supermarket
 * supervisor) voids immediately. Completed sales are never deleted.
 */
export function voidSale(
  db: Database,
  saleId: number,
  reason: string,
  actor: SalesActor
): { sale: Sale; applied: boolean } {
  if (!reason || reason.trim().length < 3) throw validation('Give a reason for voiding the sale.');
  const sale = getSale(db, saleId);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'This sale is already voided.');
  const canApprove = actor.permissions.includes('sales.void.approve');
  if (canApprove) {
    return { sale: db.transaction(() => applyVoid(db, sale, reason.trim(), actor)), applied: true };
  }
  if (!actor.permissions.includes('sales.void.request')) {
    throw new AppError('FORBIDDEN', 'You are not allowed to request a void.');
  }
  if (sale.voidRequestedAt) {
    throw new AppError('CONFLICT', 'A void request is already waiting for approval.');
  }
  db.transaction(() => {
    db.handle
      .prepare('UPDATE sales SET void_requested_by = ?, void_requested_at = ?, void_reason = ? WHERE id = ?')
      .run(actor.userId, nowIso(), reason.trim(), saleId);
    audit(db, {
      action: 'sale.void.request',
      entity: 'sale',
      entityId: saleId,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { receiptNo: sale.receiptNo, reason: reason.trim() }
    });
  });
  return { sale: getSale(db, saleId), applied: false };
}

export function approveVoid(db: Database, saleId: number, actor: SalesActor): Sale {
  if (!actor.permissions.includes('sales.void.approve')) {
    throw new AppError('FORBIDDEN', 'Only a supervisor or administrator can approve a void.');
  }
  const sale = getSale(db, saleId);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'This sale is already voided.');
  const reason = sale.voidReason ?? 'Void approved';
  return db.transaction(() => applyVoid(db, sale, reason, actor, actor.userId));
}

export function rejectVoid(db: Database, saleId: number, actor: SalesActor): Sale {
  if (!actor.permissions.includes('sales.void.approve')) {
    throw new AppError('FORBIDDEN', 'Only a supervisor or administrator can reject a void.');
  }
  const sale = getSale(db, saleId);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'This sale is already voided.');
  if (!sale.voidRequestedAt) throw new AppError('CONFLICT', 'There is no pending void request.');
  db.transaction(() => {
    db.handle
      .prepare(
        'UPDATE sales SET void_requested_by = NULL, void_requested_at = NULL, void_reason = NULL WHERE id = ?'
      )
      .run(saleId);
    audit(db, {
      action: 'sale.void.reject',
      entity: 'sale',
      entityId: saleId,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { receiptNo: sale.receiptNo }
    });
  });
  return getSale(db, saleId);
}

/** Quantity already returned (pending or completed) for a sale item. */
export function returnedQtyForItem(db: Database, saleItemId: number): number {
  const row = db.handle
    .prepare(
      `SELECT COALESCE(SUM(ri.qty), 0) AS qty
       FROM return_items ri
       JOIN returns r ON r.id = ri.return_id
       WHERE ri.sale_item_id = ? AND r.status IN ('PENDING','COMPLETED')`
    )
    .get(saleItemId) as { qty: number };
  return row.qty;
}
