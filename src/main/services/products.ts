import type { Database } from '../core/db';
import { nowIso } from '../core/db';
import type { Product, ProductInput, StockReceiveInput } from '../../shared/types';
import { AppError, conflict, notFound, validation } from '../core/errors';
import { audit } from '../core/audit';
import type { Actor } from './stock';
import { listBatches, receiveStock } from './stock';
import { nextDocumentNumber } from './helpers';

interface ProductRow {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  category: string | null;
  unit: string;
  cost_price: number;
  price: number;
  wholesale_price: number;
  reorder_level: number;
  rx_required: number;
  active: number;
  stock_qty: number;
  nearest_expiry: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_PRODUCT = `
  SELECT p.*,
    (SELECT COALESCE(SUM(qty), 0) FROM stock_batches b WHERE b.product_id = p.id) AS stock_qty,
    (SELECT MIN(expiry_date) FROM stock_batches b WHERE b.product_id = p.id AND b.qty > 0 AND b.expiry_date IS NOT NULL) AS nearest_expiry
  FROM products p
`;

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    category: row.category,
    unit: row.unit,
    costPrice: row.cost_price,
    price: row.price,
    wholesalePrice: row.wholesale_price,
    reorderLevel: row.reorder_level,
    rxRequired: !!row.rx_required,
    active: !!row.active,
    stockQty: row.stock_qty,
    nearestExpiry: row.nearest_expiry,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface ProductQuery {
  search?: string;
  category?: string;
  includeInactive?: boolean;
  lowStock?: boolean;
  limit?: number;
}

export function listProducts(db: Database, query: ProductQuery = {}): Product[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (!query.includeInactive) clauses.push('p.active = 1');
  if (query.search && query.search.trim()) {
    clauses.push('(p.name LIKE ? OR p.sku LIKE ? OR IFNULL(p.barcode, \'\') LIKE ? OR IFNULL(p.category, \'\') LIKE ?)');
    const like = `%${query.search.trim()}%`;
    params.push(like, like, like, like);
  }
  if (query.category) {
    clauses.push('p.category = ?');
    params.push(query.category);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 300, 1), 2000);
  // Low-stock filtering happens on the computed stock totals, so the aggregate
  // query is wrapped in a sub-select (SQLite has no HAVING without GROUP BY).
  const sql = query.lowStock
    ? `SELECT * FROM (${SELECT_PRODUCT} ${where}) WHERE stock_qty <= reorder_level
       ORDER BY name COLLATE NOCASE LIMIT ?`
    : `${SELECT_PRODUCT} ${where} ORDER BY p.name COLLATE NOCASE LIMIT ?`;
  const rows = db.handle.prepare(sql).all(...params, limit) as ProductRow[];
  return rows.map(mapProduct);
}

export function getProduct(db: Database, id: number): Product {
  const row = db.handle.prepare(`${SELECT_PRODUCT} WHERE p.id = ?`).get(id) as ProductRow | undefined;
  if (!row) throw notFound('Product');
  return mapProduct(row);
}

export function findProductByCode(db: Database, code: string): Product | null {
  const trimmed = code.trim();
  if (!trimmed) return null;
  const row = db.handle
    .prepare(`${SELECT_PRODUCT} WHERE p.barcode = ? OR p.sku = ? COLLATE NOCASE LIMIT 1`)
    .get(trimmed, trimmed) as ProductRow | undefined;
  return row ? mapProduct(row) : null;
}

export function listCategories(db: Database): string[] {
  const rows = db.handle
    .prepare(
      `SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND TRIM(category) <> '' ORDER BY category COLLATE NOCASE`
    )
    .all() as { category: string }[];
  return rows.map((r) => r.category);
}

function validateProductInput(input: ProductInput): void {
  if (!input.name || !input.name.trim()) throw validation('Product name is required.');
  if (!Number.isInteger(input.price) || input.price < 0) throw validation('Selling price is invalid.');
  if (!Number.isInteger(input.costPrice) || input.costPrice < 0) throw validation('Cost price is invalid.');
  if (input.wholesalePrice !== undefined && (!Number.isInteger(input.wholesalePrice) || input.wholesalePrice < 0)) {
    throw validation('Wholesale price is invalid.');
  }
  if (input.reorderLevel !== undefined && (!Number.isInteger(input.reorderLevel) || input.reorderLevel < 0)) {
    throw validation('Reorder level must be zero or more.');
  }
  if (input.openingStock !== undefined && (!Number.isInteger(input.openingStock) || input.openingStock < 0)) {
    throw validation('Opening stock must be zero or more.');
  }
}

export function createProduct(db: Database, input: ProductInput, actor: Actor): Product {
  validateProductInput(input);
  return db.transaction(() => {
    const now = nowIso();
    const sku = (input.sku?.trim() || nextDocumentNumber(db, 'SKU')).toUpperCase();
    const duplicate = db.handle
      .prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE')
      .get(sku) as { id: number } | undefined;
    if (duplicate) throw conflict(`Product code ${sku} is already in use.`);

    const result = db.handle
      .prepare(
        `INSERT INTO products
          (sku, barcode, name, category, unit, cost_price, price, wholesale_price, reorder_level, rx_required, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        sku,
        input.barcode?.trim() || null,
        input.name.trim(),
        input.category?.trim() || null,
        input.unit?.trim() || 'unit',
        input.costPrice,
        input.price,
        input.wholesalePrice ?? input.price,
        input.reorderLevel ?? 0,
        input.rxRequired ? 1 : 0,
        now,
        now
      );
    const productId = Number(result.lastInsertRowid);

    if (input.openingStock && input.openingStock > 0) {
      receiveStock(db, productId, input.openingStock, {
        batchNo: input.openingBatchNo,
        expiryDate: input.openingExpiry,
        costPrice: input.costPrice,
        type: 'OPENING',
        note: 'Opening stock',
        userId: actor.userId
      });
    }

    audit(db, {
      action: 'product.create',
      entity: 'product',
      entityId: productId,
      userId: actor.userId,
      username: actor.username,
      details: {
        name: input.name.trim(),
        sku,
        price: input.price,
        costPrice: input.costPrice,
        openingStock: input.openingStock ?? 0
      }
    });
    return getProduct(db, productId);
  });
}

export function updateProduct(db: Database, input: ProductInput, actor: Actor): Product {
  if (!input.id) throw validation('A product id is required.');
  validateProductInput(input);
  return db.transaction(() => {
    const existing = getProduct(db, input.id!);
    const now = nowIso();
    const sku = (input.sku?.trim() || existing.sku).toUpperCase();
    const duplicate = db.handle
      .prepare('SELECT id FROM products WHERE sku = ? COLLATE NOCASE AND id <> ?')
      .get(sku, existing.id) as { id: number } | undefined;
    if (duplicate) throw conflict(`Product code ${sku} is already in use.`);

    db.handle
      .prepare(
        `UPDATE products SET sku = ?, barcode = ?, name = ?, category = ?, unit = ?, cost_price = ?, price = ?,
           wholesale_price = ?, reorder_level = ?, rx_required = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        sku,
        input.barcode?.trim() || null,
        input.name.trim(),
        input.category?.trim() || null,
        input.unit?.trim() || 'unit',
        input.costPrice,
        input.price,
        input.wholesalePrice ?? input.price,
        input.reorderLevel ?? 0,
        input.rxRequired ? 1 : 0,
        now,
        existing.id
      );

    const priceChanged = existing.price !== input.price || existing.wholesalePrice !== (input.wholesalePrice ?? input.price);
    audit(db, {
      action: priceChanged ? 'product.update.price' : 'product.update',
      entity: 'product',
      entityId: existing.id,
      userId: actor.userId,
      username: actor.username,
      severity: priceChanged ? 'WARN' : 'INFO',
      details: priceChanged
        ? {
            name: input.name.trim(),
            price: { from: existing.price, to: input.price },
            wholesalePrice: { from: existing.wholesalePrice, to: input.wholesalePrice ?? input.price }
          }
        : { name: input.name.trim() }
    });
    return getProduct(db, existing.id);
  });
}

export function setProductActive(
  db: Database,
  productId: number,
  active: boolean,
  actor: Actor
): Product {
  const product = getProduct(db, productId);
  db.handle
    .prepare('UPDATE products SET active = ?, updated_at = ? WHERE id = ?')
    .run(active ? 1 : 0, nowIso(), productId);
  audit(db, {
    action: active ? 'product.activate' : 'product.deactivate',
    entity: 'product',
    entityId: productId,
    userId: actor.userId,
    username: actor.username,
    severity: 'WARN',
    details: { name: product.name }
  });
  return getProduct(db, productId);
}

export function receiveProductStock(
  db: Database,
  input: StockReceiveInput,
  actor: Actor
): { product: Product; batches: ReturnType<typeof listBatches> } {
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw validation('Quantity received must be a positive whole number.');
  }
  if (input.costPrice !== undefined && (!Number.isInteger(input.costPrice) || input.costPrice < 0)) {
    throw validation('Cost price is invalid.');
  }
  return db.transaction(() => {
    const product = getProduct(db, input.productId);
    receiveStock(db, product.id, input.qty, {
      batchNo: input.batchNo,
      expiryDate: input.expiryDate ?? null,
      costPrice: input.costPrice ?? product.costPrice,
      type: 'PURCHASE',
      note: input.note,
      userId: actor.userId
    });
    audit(db, {
      action: 'stock.receive',
      entity: 'product',
      entityId: product.id,
      userId: actor.userId,
      username: actor.username,
      details: {
        name: product.name,
        qty: input.qty,
        batchNo: input.batchNo ?? null,
        expiryDate: input.expiryDate ?? null,
        costPrice: input.costPrice ?? product.costPrice
      }
    });
    return { product: getProduct(db, product.id), batches: listBatches(db, product.id) };
  });
}

export function requireProduct(db: Database, id: number): Product {
  const product = getProduct(db, id);
  if (!product.active) throw new AppError('CONFLICT', `${product.name} is no longer available.`);
  return product;
}
