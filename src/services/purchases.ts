import type { Database } from '../db';
import { nowIso } from '../db';
import { repositoriesFor, type PurchaseItemRow, type PurchaseRow } from '../db/repositories';
import { notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { nextDocumentNumber } from './helpers';
import { getProduct } from './products';
import { receiveStock, type Actor } from './stock';

export interface PurchaseItemInput {
  productId: number;
  qty: number;
  /** Unit cost in kobo; defaults to the product's current cost price. */
  costPrice?: number;
  batchNo?: string;
  expiryDate?: string | null;
}

export interface PurchaseInput {
  supplierId?: number | null;
  supplierName?: string;
  invoiceNo?: string;
  purchaseDate?: string;
  discount?: number;
  amountPaid?: number;
  note?: string;
  items: PurchaseItemInput[];
}

export interface PurchaseWithItems extends PurchaseRow {
  items: PurchaseItemRow[];
}

export function getPurchase(db: Database, id: number): PurchaseWithItems {
  const repos = repositoriesFor(db);
  const purchase = repos.purchases.findById(id);
  if (!purchase) throw notFound('Purchase');
  return { ...purchase, items: repos.purchaseItems.all({ purchase_id: id }) };
}

export function listPurchases(
  db: Database,
  query: { from?: string; to?: string; supplierId?: number; limit?: number } = {}
): PurchaseRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.from) {
    clauses.push('purchase_date >= ?');
    params.push(query.from);
  }
  if (query.to) {
    clauses.push('purchase_date <= ?');
    params.push(query.to);
  }
  if (query.supplierId) {
    clauses.push('supplier_id = ?');
    params.push(query.supplierId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
  return db.handle
    .prepare(`SELECT * FROM purchases ${where} ORDER BY purchase_date DESC, id DESC LIMIT ?`)
    .all(...params, limit) as PurchaseRow[];
}

/**
 * Records a received purchase and adds the stock to the matching batches.
 * Everything (header, lines, stock, ledger, audit) runs in one transaction.
 */
export function createPurchase(db: Database, input: PurchaseInput, actor: Actor): PurchaseWithItems {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw validation('Add at least one item to the purchase.');
  }
  const purchaseDate = (input.purchaseDate ?? '').trim() || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw validation('Purchase date must be YYYY-MM-DD.');
  if (input.discount !== undefined && (!Number.isInteger(input.discount) || input.discount < 0)) {
    throw validation('Purchase discount is invalid.');
  }

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const supplier = input.supplierId ? repos.suppliers.findById(input.supplierId) : null;
    if (input.supplierId && !supplier) throw notFound('Supplier');
    const now = nowIso();

    const lines = input.items.map((item) => {
      if (!Number.isInteger(item.qty) || item.qty <= 0) {
        throw validation('Purchase quantities must be positive whole numbers.');
      }
      if (item.costPrice !== undefined && (!Number.isInteger(item.costPrice) || item.costPrice < 0)) {
        throw validation('Purchase cost price is invalid.');
      }
      if (item.expiryDate && !/^\d{4}-\d{2}-\d{2}$/.test(item.expiryDate)) {
        throw validation('Expiry date must be YYYY-MM-DD.');
      }
      const product = getProduct(db, item.productId);
      const costPrice = item.costPrice ?? product.costPrice;
      return { product, qty: item.qty, costPrice, batchNo: item.batchNo?.trim() || null, expiryDate: item.expiryDate ?? null };
    });

    const subtotal = lines.reduce((sum, line) => sum + line.qty * line.costPrice, 0);
    const discount = input.discount ?? 0;
    if (discount > subtotal) throw validation('Purchase discount cannot be more than the subtotal.');
    const total = subtotal - discount;
    const amountPaid = input.amountPaid ?? total;
    if (!Number.isInteger(amountPaid) || amountPaid < 0) throw validation('Amount paid is invalid.');

    const purchaseNo = nextDocumentNumber(db, 'PUR');
    const purchaseId = Number(
      repos.purchases.insert({
        purchase_no: purchaseNo,
        supplier_id: supplier?.id ?? null,
        supplier_name: supplier?.name ?? input.supplierName?.trim() ?? null,
        invoice_no: input.invoiceNo?.trim() || null,
        purchase_date: purchaseDate,
        subtotal,
        discount,
        total,
        amount_paid: amountPaid,
        status: 'RECEIVED',
        note: input.note?.trim() || null,
        user_id: actor.userId,
        username: actor.username,
        created_at: now
      })
    );

    for (const line of lines) {
      repos.purchaseItems.insert({
        purchase_id: purchaseId,
        product_id: line.product.id,
        name: line.product.name,
        qty: line.qty,
        cost_price: line.costPrice,
        line_total: line.qty * line.costPrice,
        batch_no: line.batchNo,
        expiry_date: line.expiryDate,
        created_at: now
      });
      receiveStock(db, line.product.id, line.qty, {
        batchNo: line.batchNo ?? undefined,
        expiryDate: line.expiryDate,
        costPrice: line.costPrice,
        type: 'PURCHASE',
        refType: 'purchase',
        refId: purchaseId,
        note: `Purchase ${purchaseNo}`,
        userId: actor.userId
      });
    }

    audit(db, {
      action: 'purchase.receive',
      entity: 'purchase',
      entityId: purchaseId,
      userId: actor.userId,
      username: actor.username,
      details: {
        purchaseNo,
        supplier: supplier?.name ?? input.supplierName ?? null,
        total,
        items: lines.length
      }
    });

    return getPurchase(db, purchaseId);
  });
}
