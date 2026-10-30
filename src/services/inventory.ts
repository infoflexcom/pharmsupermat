import type { Database } from '../db';
import type { Product } from '../shared/types';
import { listProducts } from './products';
import { listBatches } from './stock';

export interface ExpiryAlert {
  productId: number;
  sku: string;
  name: string;
  batchNo: string;
  expiryDate: string;
  daysLeft: number;
  qty: number;
}

export interface StockAlerts {
  lowStock: Product[];
  expiring: ExpiryAlert[];
  outOfStock: Product[];
}

export function listStockAlerts(db: Database, expiryWindowDays = 90): StockAlerts {
  const lowStock = listProducts(db, { lowStock: true, limit: 2000 });
  const outOfStock = lowStock.filter((p) => p.stockQty <= 0);
  const today = new Date().toISOString().slice(0, 10);
  const limitDate = new Date(Date.now() + expiryWindowDays * 86_400_000).toISOString().slice(0, 10);
  const rows = db.handle
    .prepare(
      `SELECT b.product_id, p.sku, p.name, b.batch_no, b.expiry_date, b.qty
       FROM product_batches b JOIN products p ON p.id = b.product_id
       WHERE b.qty > 0 AND b.expiry_date IS NOT NULL AND b.expiry_date <= ?
       ORDER BY b.expiry_date ASC`
    )
    .all(limitDate) as {
    product_id: number;
    sku: string;
    name: string;
    batch_no: string;
    expiry_date: string;
    qty: number;
  }[];
  const expiring: ExpiryAlert[] = rows.map((r) => ({
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    batchNo: r.batch_no,
    expiryDate: r.expiry_date,
    daysLeft: Math.ceil((Date.parse(r.expiry_date) - Date.parse(today)) / 86_400_000),
    qty: r.qty
  }));
  return { lowStock, expiring, outOfStock };
}

export interface InventoryItem extends Product {
  batches: ReturnType<typeof listBatches>;
}

export function listInventory(db: Database, search?: string): InventoryItem[] {
  const products = listProducts(db, { search, limit: 500 });
  return products.map((p) => ({ ...p, batches: listBatches(db, p.id) }));
}

export function stockLedger(
  db: Database,
  productId: number,
  limit = 100
): {
  id: number;
  createdAt: string;
  type: string;
  qtyChange: number;
  note: string | null;
  reference: string | null;
}[] {
  const rows = db.handle
    .prepare(
      `SELECT id, created_at, type, qty_change, note, ref_type, ref_id
       FROM stock_movements WHERE product_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(productId, Math.min(Math.max(limit, 1), 500)) as {
    id: number;
    created_at: string;
    type: string;
    qty_change: number;
    note: string | null;
    ref_type: string | null;
    ref_id: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    type: r.type,
    qtyChange: r.qty_change,
    note: r.note,
    reference: r.ref_type ? `${r.ref_type}#${r.ref_id ?? ''}` : null
  }));
}
