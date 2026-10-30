import type { Database } from '../db';
import { nowIso } from '../db';
import type { Batch } from '../shared/types';
import { AppError, notFound, validation } from '../shared/errors';
import { getProduct } from './products';
import { audit } from './audit';

export const DEFAULT_BATCH = 'DEFAULT';

export interface Actor {
  userId: number;
  username: string;
}

export function stockQty(db: Database, productId: number): number {
  const row = db.handle
    .prepare('SELECT COALESCE(SUM(qty), 0) AS qty FROM product_batches WHERE product_id = ?')
    .get(productId) as { qty: number };
  return row.qty;
}

export function listBatches(db: Database, productId: number): Batch[] {
  const rows = db.handle
    .prepare(
      `SELECT id, product_id, batch_no, expiry_date, qty, cost_price, created_at
       FROM product_batches WHERE product_id = ? ORDER BY
         CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id`
    )
    .all(productId) as {
    id: number;
    product_id: number;
    batch_no: string;
    expiry_date: string | null;
    qty: number;
    cost_price: number;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    batchNo: r.batch_no,
    expiryDate: r.expiry_date,
    qty: r.qty,
    costPrice: r.cost_price,
    createdAt: r.created_at
  }));
}

function findBatch(
  db: Database,
  productId: number,
  batchNo: string,
  expiryDate: string | null
): { id: number; qty: number } | undefined {
  return db.handle
    .prepare(
      `SELECT id, qty FROM product_batches
       WHERE product_id = ? AND batch_no = ? AND IFNULL(expiry_date, '') = IFNULL(?, '')`
    )
    .get(productId, batchNo, expiryDate) as { id: number; qty: number } | undefined;
}

/**
 * Adds stock to a batch (creating it when needed) and records the movement.
 * Callers must already be inside a transaction.
 */
export function receiveStock(
  db: Database,
  productId: number,
  qty: number,
  options: {
    batchNo?: string;
    expiryDate?: string | null;
    costPrice?: number;
    type?: 'PURCHASE' | 'RETURN' | 'ADJUSTMENT' | 'OPENING' | 'SALE_VOID';
    refType?: string | null;
    refId?: number | null;
    note?: string | null;
    userId?: number | null;
  } = {}
): number {
  if (!Number.isInteger(qty) || qty <= 0) throw validation('Quantity to add must be a positive number.');
  const product = db.handle
    .prepare('SELECT id, cost_price FROM products WHERE id = ?')
    .get(productId) as { id: number; cost_price: number } | undefined;
  if (!product) throw notFound('Product');

  const batchNo = (options.batchNo || DEFAULT_BATCH).trim() || DEFAULT_BATCH;
  const expiryDate = options.expiryDate ? options.expiryDate.slice(0, 10) : null;
  const costPrice = options.costPrice ?? product.cost_price;
  const now = nowIso();

  let batch = findBatch(db, productId, batchNo, expiryDate);
  if (batch) {
    db.handle
      .prepare('UPDATE product_batches SET qty = qty + ?, cost_price = ?, updated_at = ? WHERE id = ?')
      .run(qty, costPrice, now, batch.id);
  } else {
    const result = db.handle
      .prepare(
        `INSERT INTO product_batches (product_id, batch_no, expiry_date, qty, cost_price, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(productId, batchNo, expiryDate, qty, costPrice, now, now);
    batch = { id: Number(result.lastInsertRowid), qty };
  }

  db.handle
    .prepare(
      `INSERT INTO stock_movements (product_id, batch_id, qty_change, type, ref_type, ref_id, note, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      productId,
      batch.id,
      qty,
      options.type ?? 'PURCHASE',
      options.refType ?? null,
      options.refId ?? null,
      options.note ?? null,
      options.userId ?? null,
      now
    );

  return batch.id;
}

export interface Allocation {
  batchId: number;
  batchNo: string;
  qty: number;
  costPrice: number;
}

/**
 * FEFO allocation (first-expiry-first-out). Expired batches are never sold.
 * Throws INSUFFICIENT_STOCK when the sellable quantity is too low.
 */
export function allocateStock(
  db: Database,
  productId: number,
  qty: number,
  productName = 'Item',
  asOf = new Date()
): Allocation[] {
  if (!Number.isInteger(qty) || qty <= 0) throw validation('Quantity must be a positive whole number.');
  const today = asOf.toISOString().slice(0, 10);
  const batches = db.handle
    .prepare(
      `SELECT id, batch_no, qty, cost_price, expiry_date FROM product_batches
       WHERE product_id = ? AND qty > 0
       ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id`
    )
    .all(productId) as {
    id: number;
    batch_no: string;
    qty: number;
    cost_price: number;
    expiry_date: string | null;
  }[];

  const sellable = batches.filter((b) => !b.expiry_date || b.expiry_date >= today);
  const available = sellable.reduce((sum, b) => sum + b.qty, 0);
  if (available < qty) {
    const expired = batches
      .filter((b) => b.expiry_date && b.expiry_date < today)
      .reduce((sum, b) => sum + b.qty, 0);
    throw new AppError(
      'INSUFFICIENT_STOCK',
      available === 0 && expired > 0
        ? `${productName}: only expired stock is available. Receive a new batch before selling.`
        : `${productName}: only ${available} in stock (${qty} requested).`,
      { productId, available, requested: qty }
    );
  }

  const allocations: Allocation[] = [];
  let remaining = qty;
  for (const batch of sellable) {
    if (remaining <= 0) break;
    const take = Math.min(batch.qty, remaining);
    allocations.push({
      batchId: batch.id,
      batchNo: batch.batch_no,
      qty: take,
      costPrice: batch.cost_price
    });
    remaining -= take;
  }
  return allocations;
}

/** Decrements batch quantities for an allocation and records one movement row. */
export function commitSaleAllocation(
  db: Database,
  productId: number,
  allocation: Allocation,
  meta: { refType: string; refId: number; userId: number; note?: string }
): void {
  const now = nowIso();
  db.handle
    .prepare('UPDATE product_batches SET qty = qty - ?, updated_at = ? WHERE id = ?')
    .run(allocation.qty, now, allocation.batchId);
  db.handle
    .prepare(
      `INSERT INTO stock_movements (product_id, batch_id, qty_change, type, ref_type, ref_id, note, user_id, created_at)
       VALUES (?, ?, ?, 'SALE', ?, ?, ?, ?, ?)`
    )
    .run(
      productId,
      allocation.batchId,
      -allocation.qty,
      meta.refType,
      meta.refId,
      meta.note ?? null,
      meta.userId,
      now
    );
}

export function adjustStock(
  db: Database,
  input: {
    productId: number;
    batchId?: number;
    newQty?: number;
    removeQty?: number;
    reason: string;
    reasonType?: 'DAMAGED' | 'LOST' | 'CORRECTION' | 'COUNT';
  },
  actor: Actor
): { productId: number; batchId: number; before: number; after: number; delta: number; reasonType: string } {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw validation('A reason is required for a stock adjustment.');
  if (reason.length > 240) throw validation('The adjustment reason is too long.');
  const reasonType = input.reasonType ?? 'CORRECTION';
  if (!['DAMAGED', 'LOST', 'CORRECTION', 'COUNT'].includes(reasonType)) {
    throw validation('Choose a valid adjustment type.');
  }

  const product = getProduct(db, input.productId);
  if (input.newQty !== undefined && (!Number.isInteger(input.newQty) || input.newQty < 0)) {
    throw validation('Stock count must be zero or more.');
  }
  if (input.removeQty !== undefined && (!Number.isInteger(input.removeQty) || input.removeQty <= 0)) {
    throw validation('The quantity removed must be a positive whole number.');
  }
  if (input.newQty === undefined && input.removeQty === undefined) {
    throw validation('Enter the counted quantity or the quantity to remove.');
  }

  return db.transaction(() => {
    const batch = input.batchId
      ? (db.handle
          .prepare('SELECT id, qty FROM product_batches WHERE id = ? AND product_id = ?')
          .get(input.batchId, input.productId) as { id: number; qty: number } | undefined)
      : (db.handle
          .prepare('SELECT id, qty FROM product_batches WHERE product_id = ? ORDER BY qty DESC LIMIT 1')
          .get(input.productId) as { id: number; qty: number } | undefined);
    if (!batch) throw notFound('Stock batch');

    const before = batch.qty;
    const after = input.newQty !== undefined ? input.newQty : Math.max(0, before - (input.removeQty ?? 0));
    if (input.removeQty !== undefined && input.removeQty > before) {
      throw validation(`${product.name}: only ${before} in stock, cannot remove ${input.removeQty}.`);
    }
    if (after === before) {
      return { productId: product.id, batchId: batch.id, before, after, delta: 0, reasonType };
    }

    const now = nowIso();
    db.handle
      .prepare('UPDATE product_batches SET qty = ?, updated_at = ? WHERE id = ?')
      .run(after, now, batch.id);
    db.handle
      .prepare(
        `INSERT INTO stock_movements (product_id, batch_id, qty_change, type, reason_type, note, user_id, created_at)
         VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?)`
      )
      .run(product.id, batch.id, after - before, reasonType, reason, actor.userId, now);

    audit(db, {
      action: 'stock.adjust',
      entity: 'product',
      entityId: product.id,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: {
        name: product.name,
        reasonType,
        reason,
        qty: { from: before, to: after },
        delta: after - before,
        costValue: Math.abs(after - before) * product.costPrice
      }
    });
    return { productId: product.id, batchId: batch.id, before, after, delta: after - before, reasonType };
  });
}
