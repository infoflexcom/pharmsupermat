/**
 * Supermarket-module services: multiple barcodes per product and variants.
 * (Pharmacy products keep a single barcode in `products.barcode`.)
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import {
  repositoriesFor,
  type ProductBarcodeRow,
  type ProductVariantRow
} from '../db/repositories';
import { conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { getProduct } from './products';
import type { Actor } from './stock';

export function listProductBarcodes(db: Database, productId: number): ProductBarcodeRow[] {
  return repositoriesFor(db).productBarcodes.all({ product_id: productId });
}

export function addProductBarcode(
  db: Database,
  input: { productId: number; barcode: string; packQty?: number; isPrimary?: boolean },
  actor: Actor
): ProductBarcodeRow[] {
  const barcode = (input.barcode ?? '').trim();
  if (!barcode) throw validation('Barcode is required.');
  const packQty = input.packQty ?? 1;
  if (!Number.isInteger(packQty) || packQty < 1) throw validation('Pack quantity must be one or more.');
  getProduct(db, input.productId);

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const clash = repos.productBarcodes.findOne({ barcode });
    if (clash && clash.product_id !== input.productId) throw conflict('That barcode is already assigned to another product.');
    if (!clash) {
      repos.productBarcodes.insert({
        product_id: input.productId,
        barcode,
        pack_qty: packQty,
        is_primary: input.isPrimary ? 1 : 0,
        created_at: nowIso()
      });
      audit(db, {
        action: 'barcode.add',
        entity: 'product',
        entityId: input.productId,
        userId: actor.userId,
        username: actor.username,
        details: { barcode, packQty }
      });
    }
    return repos.productBarcodes.all({ product_id: input.productId });
  });
}

export function removeProductBarcode(db: Database, input: { productId: number; barcode: string }, actor: Actor): ProductBarcodeRow[] {
  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const row = repos.productBarcodes.findOne({ product_id: input.productId, barcode: input.barcode });
    if (!row) throw notFound('Barcode');
    if (row.is_primary) throw conflict('Set another barcode as primary before removing this one.');
    repos.productBarcodes.remove(row.id);
    audit(db, {
      action: 'barcode.remove',
      entity: 'product',
      entityId: input.productId,
      userId: actor.userId,
      username: actor.username,
      details: { barcode: input.barcode }
    });
    return repos.productBarcodes.all({ product_id: input.productId });
  });
}

export interface VariantInput {
  id?: number;
  productId: number;
  variantName: string;
  sku?: string;
  barcode?: string | null;
  price: number;
  costPrice?: number;
  stockQty?: number;
  active?: boolean;
}

export function listProductVariants(db: Database, productId: number): ProductVariantRow[] {
  return (repositoriesFor(db) as ReturnType<typeof repositoriesFor>).productVariants.all({ product_id: productId });
}

export function saveProductVariant(db: Database, input: VariantInput, actor: Actor): ProductVariantRow {
  if (!input.variantName?.trim()) throw validation('Variant name is required.');
  if (!Number.isInteger(input.price) || input.price < 0) throw validation('Variant price is invalid.');
  if (input.costPrice !== undefined && (!Number.isInteger(input.costPrice) || input.costPrice < 0)) {
    throw validation('Variant cost price is invalid.');
  }
  if (input.stockQty !== undefined && (!Number.isInteger(input.stockQty) || input.stockQty < 0)) {
    throw validation('Variant stock must be zero or more.');
  }
  const product = getProduct(db, input.productId);

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const existing = input.id ? repos.productVariants.findById(input.id) : null;
    if (input.id && !existing) throw notFound('Variant');
    const sku = (input.sku?.trim() || `${product.sku}-${input.variantName.trim().toUpperCase().replace(/\s+/g, '-')}`).toUpperCase();
    const clash = repos.productVariants.findOne({ sku });
    if (clash && clash.id !== existing?.id) throw conflict(`Variant code ${sku} is already in use.`);
    const now = nowIso();
    let id: number;
    if (existing) {
      repos.productVariants.update(existing.id, {
        variant_name: input.variantName.trim(),
        sku,
        barcode: input.barcode?.trim() || null,
        price: input.price,
        cost_price: input.costPrice ?? existing.cost_price,
        stock_qty: input.stockQty ?? existing.stock_qty,
        active: input.active === undefined ? existing.active : input.active ? 1 : 0,
        updated_at: now
      });
      id = existing.id;
    } else {
      id = Number(
        repos.productVariants.insert({
          product_id: input.productId,
          variant_name: input.variantName.trim(),
          sku,
          barcode: input.barcode?.trim() || null,
          price: input.price,
          cost_price: input.costPrice ?? product.costPrice,
          stock_qty: input.stockQty ?? 0,
          active: input.active === false ? 0 : 1,
          created_at: now,
          updated_at: now
        })
      );
    }
    audit(db, {
      action: existing ? 'variant.update' : 'variant.create',
      entity: 'product_variant',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { product: product.name, sku, price: input.price }
    });
    return repos.productVariants.findById(id)!;
  });
}
