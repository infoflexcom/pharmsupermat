import type { Database } from '../db';
import { nowIso } from '../db';
import type { Money, Product, ProductInput, StockReceiveInput } from '../shared/types';
import { AppError, conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import type { Actor } from './stock';
import { listBatches, receiveStock } from './stock';
import { nextDocumentNumber } from './helpers';

interface ProductRow {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  unit: string;
  pack_size: number;
  pack_unit: string;
  cost_price: number;
  price: number;
  wholesale_price: number;
  reorder_level: number;
  requires_prescription: number;
  active: number;
  stock_qty: number;
  nearest_expiry: string | null;
  generic_name: string | null;
  category_id: number | null;
  supplier_id: number | null;
  department_id: number | null;
  shelf_location: string | null;
  plu_code: string | null;
  price_per_kg: number | null;
  is_weighed: number;
  wholesale_min_qty: number;
  expiry_tracking: number;
  created_at: string;
  updated_at: string;
}

const SELECT_PRODUCT = `
  SELECT p.*,
    (SELECT COALESCE(SUM(qty), 0) FROM product_batches b WHERE b.product_id = p.id) AS stock_qty,
    (SELECT MIN(expiry_date) FROM product_batches b WHERE b.product_id = p.id AND b.qty > 0 AND b.expiry_date IS NOT NULL) AS nearest_expiry
  FROM products p
`;

function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    brand: row.brand,
    category: row.category,
    unit: row.unit,
    packSize: row.pack_size,
    packUnit: row.pack_unit,
    costPrice: row.cost_price,
    price: row.price,
    wholesalePrice: row.wholesale_price,
    wholesaleMinQty: row.wholesale_min_qty,
    reorderLevel: row.reorder_level,
    rxRequired: !!row.requires_prescription,
    active: !!row.active,
    stockQty: row.stock_qty,
    nearestExpiry: row.nearest_expiry,
    genericName: row.generic_name,
    categoryId: row.category_id,
    supplierId: row.supplier_id,
    departmentId: row.department_id,
    shelfLocation: row.shelf_location,
    pluCode: row.plu_code,
    pricePerKg: row.price_per_kg,
    isWeighed: !!row.is_weighed,
    expiryTracking: !!row.expiry_tracking || !!row.nearest_expiry,
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
    clauses.push(
      `(p.name LIKE ? OR p.sku LIKE ? OR IFNULL(p.barcode, '') LIKE ? OR IFNULL(p.category, '') LIKE ?
        OR IFNULL(p.generic_name, '') LIKE ? OR IFNULL(p.plu_code, '') LIKE ?
        OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode LIKE ?))`
    );
    const like = `%${query.search.trim()}%`;
    params.push(like, like, like, like, like, like, like);
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
    .prepare(
      `${SELECT_PRODUCT}
       WHERE p.barcode = ? OR p.sku = ? COLLATE NOCASE OR p.plu_code = ?
          OR EXISTS (SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id AND pb.barcode = ?)
       LIMIT 1`
    )
    .get(trimmed, trimmed, trimmed, trimmed) as ProductRow | undefined;
  return row ? mapProduct(row) : null;
}

export function listCategories(db: Database): string[] {
  const rows = db.handle
    .prepare(
      `SELECT name FROM categories WHERE active = 1
       UNION
       SELECT DISTINCT TRIM(category) FROM products WHERE category IS NOT NULL AND TRIM(category) <> ''
       ORDER BY 1 COLLATE NOCASE`
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** Finds or creates the category row behind a product's display category. */
function ensureCategory(db: Database, name: string | null): number | null {
  if (!name || !name.trim()) return null;
  const now = nowIso();
  db.handle
    .prepare('INSERT INTO categories (name, sort_order, active, created_at, updated_at) VALUES (?, 0, 1, ?, ?) ON CONFLICT(name) DO NOTHING')
    .run(name.trim(), now, now);
  const row = db.handle.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
  return row ? row.id : null;
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
  if (input.packSize !== undefined && (!Number.isInteger(input.packSize) || input.packSize < 1 || input.packSize > 10_000)) {
    throw validation('Pack size must be a whole number between 1 and 10,000.');
  }
  if (input.wholesaleMinQty !== undefined && (!Number.isInteger(input.wholesaleMinQty) || input.wholesaleMinQty < 1)) {
    throw validation('Wholesale minimum quantity must be one or more.');
  }
  if (input.brand !== undefined && input.brand !== null && input.brand.length > 80) {
    throw validation('Brand name is too long.');
  }
  if (input.openingStock !== undefined && (!Number.isInteger(input.openingStock) || input.openingStock < 0)) {
    throw validation('Opening stock must be zero or more.');
  }
  if (input.pricePerKg !== undefined && input.pricePerKg !== null && (!Number.isInteger(input.pricePerKg) || input.pricePerKg < 0)) {
    throw validation('Price per kilogram is invalid.');
  }
  if (input.isWeighed && !input.pricePerKg) {
    throw validation('Weighed items need a price per kilogram.');
  }
  if (input.isWeighed && !input.pluCode && !input.barcode) {
    throw validation('Weighed items need a PLU code (or a barcode) for the scale label.');
  }
}

/** Keeps product_barcodes in step with products.barcode (multi-barcode support). */
function syncPrimaryBarcode(db: Database, productId: number, barcode: string | null): void {
  if (barcode) {
    db.handle
      .prepare(
        `INSERT INTO product_barcodes (product_id, barcode, pack_qty, is_primary, created_at)
         VALUES (?, ?, 1, 1, ?)
         ON CONFLICT(barcode) DO UPDATE SET product_id = excluded.product_id, is_primary = 1`
      )
      .run(productId, barcode, nowIso());
  }
  db.handle.prepare('UPDATE product_barcodes SET is_primary = 0 WHERE product_id = ? AND barcode <> ?').run(productId, barcode ?? '');
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
          (sku, barcode, name, brand, category, category_id, unit, pack_size, pack_unit, cost_price, price,
           wholesale_price, wholesale_min_qty, reorder_level, requires_prescription, generic_name, supplier_id,
           department_id, shelf_location, plu_code, price_per_kg, is_weighed, expiry_tracking, active,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        sku,
        input.barcode?.trim() || null,
        input.name.trim(),
        input.brand?.trim() || null,
        input.category?.trim() || null,
        input.categoryId ?? ensureCategory(db, input.category ?? null),
        input.unit?.trim() || 'unit',
        input.packSize ?? 1,
        input.packUnit?.trim() || 'pack',
        input.costPrice,
        input.price,
        input.wholesalePrice ?? input.price,
        input.wholesaleMinQty ?? 1,
        input.reorderLevel ?? 0,
        input.rxRequired ? 1 : 0,
        input.genericName?.trim() || null,
        input.supplierId ?? null,
        input.departmentId ?? null,
        input.shelfLocation?.trim() || null,
        input.pluCode?.trim() || null,
        input.pricePerKg ?? null,
        input.isWeighed ? 1 : 0,
        input.expiryTracking || input.openingExpiry ? 1 : 0,
        now,
        now
      );
    const productId = Number(result.lastInsertRowid);

    syncPrimaryBarcode(db, productId, input.barcode?.trim() || null);

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
        `UPDATE products SET sku = ?, barcode = ?, name = ?, brand = ?, category = ?, category_id = ?, unit = ?,
           pack_size = ?, pack_unit = ?, cost_price = ?, price = ?, wholesale_price = ?, wholesale_min_qty = ?,
           reorder_level = ?, requires_prescription = ?, generic_name = ?, supplier_id = ?, department_id = ?,
           shelf_location = ?, plu_code = ?, price_per_kg = ?, is_weighed = ?, expiry_tracking = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        sku,
        input.barcode?.trim() || null,
        input.name.trim(),
        input.brand?.trim() || null,
        input.category?.trim() || null,
        input.categoryId ?? ensureCategory(db, input.category ?? null),
        input.unit?.trim() || 'unit',
        input.packSize ?? existing.packSize,
        input.packUnit?.trim() || existing.packUnit,
        input.costPrice,
        input.price,
        input.wholesalePrice ?? input.price,
        input.wholesaleMinQty ?? existing.wholesaleMinQty,
        input.reorderLevel ?? 0,
        input.rxRequired ? 1 : 0,
        input.genericName?.trim() || null,
        input.supplierId ?? null,
        input.departmentId ?? null,
        input.shelfLocation?.trim() || null,
        input.pluCode?.trim() || null,
        input.pricePerKg ?? null,
        input.isWeighed ? 1 : 0,
        input.expiryTracking === undefined ? (existing.expiryTracking ? 1 : 0) : input.expiryTracking ? 1 : 0,
        now,
        existing.id
      );

    syncPrimaryBarcode(db, existing.id, input.barcode?.trim() || null);

    // Every money field that moves is recorded with its old and new value, so
    // a cost or price edit can always be reconstructed from the audit trail.
    const moneyChanges: Record<string, { from: number; to: number }> = {};
    if (existing.price !== input.price) moneyChanges.price = { from: existing.price, to: input.price };
    const nextWholesale = input.wholesalePrice ?? input.price;
    if (existing.wholesalePrice !== nextWholesale) {
      moneyChanges.wholesalePrice = { from: existing.wholesalePrice, to: nextWholesale };
    }
    if (existing.costPrice !== input.costPrice) {
      moneyChanges.costPrice = { from: existing.costPrice, to: input.costPrice };
    }
    const priceChanged = Object.keys(moneyChanges).length > 0;
    audit(db, {
      action: priceChanged ? 'product.update.price' : 'product.update',
      entity: 'product',
      entityId: existing.id,
      userId: actor.userId,
      username: actor.username,
      severity: priceChanged ? 'WARN' : 'INFO',
      details: priceChanged
        ? { name: input.name.trim(), ...moneyChanges }
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
): { product: Product; batches: ReturnType<typeof listBatches>; receivedQty: number } {
  if (input.costPrice !== undefined && (!Number.isInteger(input.costPrice) || input.costPrice < 0)) {
    throw validation('Cost price is invalid.');
  }
  return db.transaction(() => {
    const product = getProduct(db, input.productId);

    // Packs and kilograms are converted to the base unit the stock ledger uses.
    let qty = input.qty;
    if (input.packs !== undefined) qty = packsToUnits(input.packs, product.packSize);
    if (input.weightKg !== undefined) {
      if (!product.isWeighed) throw validation('Only weighed products are received in kilograms.');
      if (!(input.weightKg > 0)) throw validation('Weight received must be greater than zero.');
      qty = Math.round(input.weightKg * 1000);
    }
    if (!Number.isInteger(qty) || (qty ?? 0) <= 0) {
      throw validation('Quantity received must be a positive whole number.');
    }
    const receivedQty = qty as number;
    receiveStock(db, product.id, receivedQty, {
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
        qty: receivedQty,
        packs: input.packs ?? null,
        packSize: product.packSize,
        weightKg: input.weightKg ?? null,
        batchNo: input.batchNo ?? null,
        expiryDate: input.expiryDate ?? null,
        costPrice: input.costPrice ?? product.costPrice
      }
    });
    return { product: getProduct(db, product.id), batches: listBatches(db, product.id), receivedQty };
  });
}

export function requireProduct(db: Database, id: number): Product {
  const product = getProduct(db, id);
  if (!product.active) throw new AppError('CONFLICT', `${product.name} is no longer available.`);
  return product;
}

/* ------------------------------------------------------------------ */
/* Packs, costs and public shapes                                      */
/* ------------------------------------------------------------------ */

/** Converts a pack count into base units (never below one pack). */
export function packsToUnits(packs: number, packSize: number): number {
  if (!Number.isInteger(packs) || packs < 0) throw validation('Pack quantity must be zero or more.');
  return packs * Math.max(1, packSize);
}

/** Converts base units into whole packs plus the loose remainder. */
export function unitsToPacks(units: number, packSize: number): { packs: number; loose: number } {
  const size = Math.max(1, packSize);
  return { packs: Math.floor(units / size), loose: units % size };
}

export type ProductWithCost = Product & { costPrice: Money };

/**
 * Cost prices are commercially sensitive: only a role that may set prices sees
 * them. This is applied in the MAIN process (see invoke.ts) so a renderer that
 * asks directly still gets a stripped payload.
 */
export function redactProductCost(product: Product, canSeeCost: boolean): Product {
  return canSeeCost ? product : { ...product, costPrice: 0 };
}

export function redactCostsDeep<T>(value: T, canSeeCost: boolean): T {
  if (canSeeCost) return value;
  const MONEY_KEYS = new Set(['costPrice', 'cost_price', 'cost', 'unitCost', 'profit', 'margin', 'costValue']);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(node as Record<string, unknown>)) {
      out[key] = MONEY_KEYS.has(key) ? 0 : walk(inner);
    }
    return out;
  };
  return walk(value) as T;
}
