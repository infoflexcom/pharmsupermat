/**
 * Stocktake (stock counts) — supermarket module.
 *
 * A count snapshots the system quantity per product/batch, lets a supervisor or
 * administrator type what was actually on the shelf, and posts the differences
 * as stock movements with the counted quantity and the variance recorded. The
 * variance report is the same data, shown before and after posting, so nothing
 * is adjusted until a human confirms it.
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import type { Money, StockCountDetail, StockCountItemRow, StockCountRow } from '../shared/types';
import { AppError, conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { nextDocumentNumber } from './helpers';
import type { Actor } from './stock';

interface CountRow extends StockCountRow {}

interface CountItemRow extends StockCountItemRow {}

function mapCount(row: CountRow): StockCountRow {
  return { ...row };
}

export function listStockCounts(db: Database, limit = 40): StockCountRow[] {
  const rows = db.handle
    .prepare('SELECT * FROM stock_counts ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 200)) as StockCountRow[];
  return rows.map(mapCount);
}

export function getStockCount(db: Database, id: number): StockCountDetail {
  const count = db.handle.prepare('SELECT * FROM stock_counts WHERE id = ?').get(id) as
    | StockCountRow
    | undefined;
  if (!count) throw notFound('Stock count');
  const items = db.handle
    .prepare('SELECT * FROM stock_count_items WHERE count_id = ? ORDER BY name COLLATE NOCASE')
    .all(id) as CountItemRow[];
  const counted = items.reduce((sum, item) => sum + (item.counted_qty ?? item.system_qty), 0);
  return {
    count,
    items,
    totals: {
      counted,
      varianceQty: items.reduce((sum, item) => sum + item.variance, 0),
      varianceValue: items.reduce((sum, item) => sum + item.variance * item.cost_price, 0) as Money
    }
  };
}

/**
 * Snapshots every active product. Weighed products are counted in kilograms in
 * the UI and stored here in grams, the same base unit the ledger uses.
 */
export function createStockCount(
  db: Database,
  input: { note?: string; scope?: string; includeEmptyStock?: boolean } = {},
  actor: Actor
): StockCountDetail {
  return db.transaction(() => {
    const now = nowIso();
    const countNo = nextDocumentNumber(db, 'CNT');
    const result = db.handle
      .prepare(
        `INSERT INTO stock_counts (count_no, status, scope, note, created_by, username, created_at)
         VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)`
      )
      .run(
        countNo,
        input.scope?.trim() || 'ALL',
        input.note?.trim() || null,
        actor.userId,
        actor.username,
        now
      );
    const countId = Number(result.lastInsertRowid);

    const rows = db.handle
      .prepare(
        `SELECT p.id AS product_id, p.sku, p.name, p.cost_price, b.id AS batch_id,
                COALESCE(b.qty, 0) AS system_qty
           FROM products p
           LEFT JOIN product_batches b ON b.product_id = p.id
          WHERE p.active = 1
          ORDER BY p.name COLLATE NOCASE, b.id`
      )
      .all() as Array<{
      product_id: number;
      sku: string;
      name: string;
      cost_price: number;
      batch_id: number | null;
      system_qty: number;
    }>;

    const insert = db.handle.prepare(
      `INSERT INTO stock_count_items
         (count_id, product_id, batch_id, sku, name, system_qty, counted_qty, variance, cost_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`
    );
    // A product with no batch yet still gets one row so it can be counted in.
    const seen = new Set<string>();
    for (const row of rows) {
      const key = `${row.product_id}:${row.batch_id ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!row.batch_id && !input.includeEmptyStock) continue;
      if (row.system_qty <= 0 && !row.batch_id) continue;
      insert.run(
        countId,
        row.product_id,
        row.batch_id,
        row.sku,
        row.name,
        row.system_qty,
        row.cost_price ?? 0,
        now,
        now
      );
    }

    audit(db, {
      action: 'stocktake.create',
      entity: 'stock_count',
      entityId: countId,
      userId: actor.userId,
      username: actor.username,
      details: { countNo, scope: input.scope ?? 'ALL' }
    });
    return getStockCount(db, countId);
  });
}

function requireDraft(db: Database, countId: number): StockCountRow {
  const count = db.handle.prepare('SELECT * FROM stock_counts WHERE id = ?').get(countId) as
    | StockCountRow
    | undefined;
  if (!count) throw notFound('Stock count');
  if (count.status !== 'DRAFT') {
    throw new AppError('CONFLICT', 'This count has already been posted. Start a new count to adjust stock.');
  }
  return count;
}

/** Saves counted quantities. `null` clears a line back to "not counted". */
export function saveStockCountEntries(
  db: Database,
  input: { countId: number; entries: Array<{ itemId: number; countedQty: number | null }> },
  actor: Actor
): StockCountDetail {
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw validation('Enter at least one counted quantity.');
  }
  return db.transaction(() => {
    requireDraft(db, input.countId);
    const now = nowIso();
    const update = db.handle.prepare(
      `UPDATE stock_count_items
          SET counted_qty = ?, variance = COALESCE(?, system_qty) - system_qty, updated_at = ?
        WHERE id = ? AND count_id = ?`
    );
    for (const entry of input.entries) {
      if (entry.countedQty !== null && (!Number.isInteger(entry.countedQty) || entry.countedQty < 0)) {
        throw validation('Counted quantities must be zero or more.');
      }
      const exists = db.handle
        .prepare('SELECT id FROM stock_count_items WHERE id = ? AND count_id = ?')
        .get(entry.itemId, input.countId) as { id: number } | undefined;
      if (!exists) throw notFound('Stock count line');
      update.run(entry.countedQty, entry.countedQty, now, entry.itemId, input.countId);
    }
    refreshTotals(db, input.countId);
    audit(db, {
      action: 'stocktake.save',
      entity: 'stock_count',
      entityId: input.countId,
      userId: actor.userId,
      username: actor.username,
      details: { lines: input.entries.length }
    });
    return getStockCount(db, input.countId);
  });
}

function refreshTotals(db: Database, countId: number): void {
  const totals = db.handle
    .prepare(
      `SELECT COUNT(counted_qty) AS items_counted,
              COALESCE(SUM(variance), 0) AS variance_qty,
              COALESCE(SUM(variance * cost_price), 0) AS variance_value
         FROM stock_count_items WHERE count_id = ?`
    )
    .get(countId) as { items_counted: number; variance_qty: number; variance_value: number };
  db.handle
    .prepare('UPDATE stock_counts SET items_counted = ?, variance_qty = ?, variance_value = ? WHERE id = ?')
    .run(totals.items_counted, totals.variance_qty, totals.variance_value, countId);
}

/**
 * Posts the count: every counted line with a variance becomes a stock movement
 * (type COUNT) and the batch quantities are updated in one transaction.
 */
export function postStockCount(db: Database, input: { countId: number }, actor: Actor): StockCountDetail {
  return db.transaction(() => {
    const count = requireDraft(db, input.countId);
    const items = db.handle
      .prepare('SELECT * FROM stock_count_items WHERE count_id = ? AND counted_qty IS NOT NULL')
      .all(input.countId) as CountItemRow[];
    if (items.length === 0) throw conflict('Nothing has been counted yet.');
    if (items.some((item) => item.batch_id === null)) {
      throw conflict('Every counted line needs a stock batch. Receive the stock first, then count it.');
    }

    const now = nowIso();
    let adjusted = 0;
    for (const item of items) {
      if (!item.batch_id || item.counted_qty === null) continue;
      if (item.variance === 0) continue;
      db.handle
        .prepare('UPDATE product_batches SET qty = ?, updated_at = ? WHERE id = ?')
        .run(item.counted_qty, now, item.batch_id);
      db.handle
        .prepare(
          `INSERT INTO stock_movements
             (product_id, batch_id, qty_change, type, reason_type, ref_type, ref_id, note, user_id, created_at)
           VALUES (?, ?, ?, 'ADJUSTMENT', 'COUNT', 'STOCK_COUNT', ?, ?, ?, ?)`
        )
        .run(
          item.product_id,
          item.batch_id,
          item.variance,
          count.id,
          `Stock count ${count.count_no}`,
          actor.userId,
          now
        );
      adjusted += 1;
    }

    db.handle
      .prepare(
        "UPDATE stock_counts SET status = 'POSTED', posted_at = ?, posted_by = ?, items_counted = ?, variance_qty = ?, variance_value = ? WHERE id = ?"
      )
      .run(
        now,
        actor.username,
        items.length,
        items.reduce((sum, item) => sum + item.variance, 0),
        items.reduce((sum, item) => sum + item.variance * item.cost_price, 0),
        count.id
      );

    audit(db, {
      action: 'stocktake.post',
      entity: 'stock_count',
      entityId: count.id,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: {
        countNo: count.count_no,
        lines: items.length,
        adjustedLines: adjusted,
        varianceQty: items.reduce((sum, item) => sum + item.variance, 0),
        varianceValue: items.reduce((sum, item) => sum + item.variance * item.cost_price, 0)
      }
    });
    return getStockCount(db, count.id);
  });
}
