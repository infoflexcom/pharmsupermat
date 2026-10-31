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
import { enabledPaymentMethods, getAllSettings, getStoreProfile } from './settings';
import { priceCart } from './pricing';
import { consumeApproval } from './approvals';
import { adjustLoyaltyPoints } from './marketing';

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
  tier: 'RETAIL' | 'WHOLESALE';
  balance_due: number;
  promo_discount: number;
  item_discount: number;
  loyalty_points: number;
  loyalty_redeemed: number;
  loyalty_value: number;
  vat_rate: number;
  print_count: number;
  last_printed_at: string | null;
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
  line_discount: number;
  promotion_id: number | null;
  promotion_name: string | null;
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
    isWeighed: !!row.is_weighed,
    lineDiscount: row.line_discount ?? 0,
    promotionName: row.promotion_name ?? null
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
    tier: row.tier,
    balanceDue: row.balance_due,
    promoDiscount: row.promo_discount,
    itemDiscount: row.item_discount,
    loyaltyPoints: row.loyalty_points,
    loyaltyRedeemed: row.loyalty_redeemed,
    loyaltyValue: row.loyalty_value,
    vatRate: row.vat_rate,
    printCount: row.print_count,
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

const PAYMENT_METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'POS', 'CREDIT', 'SPLIT'];

interface PreparedPayment {
  method: PaymentMethod;
  amount: number;
  reference: string | null;
}

/** Money actually collected (everything except the amount left on account). */
function cashOf(payments: PreparedPayment[]): number {
  return payments.filter((p) => p.method !== 'CREDIT').reduce((sum, p) => sum + p.amount, 0);
}

function creditOf(payments: PreparedPayment[]): number {
  return payments.filter((p) => p.method === 'CREDIT').reduce((sum, p) => sum + p.amount, 0);
}

/**
 * The cashier's open shift, or the shift the caller named. Supermarket stores
 * can insist on an open shift before the first sale of the day.
 */
function resolveShift(db: Database, requested: number | null | undefined, actor: Actor, required: boolean): number | null {
  if (requested) {
    const row = db.handle
      .prepare('SELECT id, user_id, status FROM cashier_shifts WHERE id = ?')
      .get(requested) as { id: number; user_id: number; status: string } | undefined;
    if (!row) throw validation('That shift does not exist.');
    if (row.status !== 'OPEN') throw new AppError('CONFLICT', 'That shift is already closed.');
    if (row.user_id !== actor.userId) throw validation('You can only sell on your own shift.');
    return row.id;
  }
  const open = db.handle
    .prepare("SELECT id FROM cashier_shifts WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1")
    .get(actor.userId) as { id: number } | undefined;
  if (required && !open) {
    throw new AppError('SHIFT_REQUIRED', 'Open your cashier shift (with the opening float) before selling.');
  }
  return open?.id ?? null;
}

/** Outstanding balance across a customer's completed credit invoices. */
export function customerOutstanding(db: Database, customerId: number): number {
  const row = db.handle
    .prepare(
      `SELECT COALESCE(SUM(balance_due), 0) AS due FROM sales
       WHERE customer_id = ? AND status = 'COMPLETED' AND balance_due > 0`
    )
    .get(customerId) as { due: number };
  return row.due;
}

/**
 * Records a sale.
 *
 * Everything that touches money or stock happens in one SQLite transaction:
 * the till quote, stock allocation (FEFO where batches carry expiry dates),
 * the sale, its lines, its payments, the loyalty ledger and the audit trail.
 */
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
  if (input.tier && input.tier !== 'RETAIL' && input.tier !== 'WHOLESALE') {
    throw validation('Choose a valid price tier.');
  }

  const settings = getAllSettings(db);
  const enabled = enabledPaymentMethods(db);
  const supplied = input.payments ?? [];
  if (supplied.length) {
    if (
      supplied.some(
        (p) =>
          !PAYMENT_METHODS.includes(p.method) ||
          p.method === 'SPLIT' ||
          !Number.isInteger(p.amount) ||
          p.amount <= 0
      )
    ) {
      throw validation('Each payment needs a valid method and a positive amount.');
    }
    for (const payment of supplied) {
      const method = enabled.find((m) => m.method === payment.method);
      if (method && !method.enabled) {
        throw validation(`${method.label} payments are switched off. An administrator can enable them in Settings.`);
      }
    }
  } else {
    const chosen = enabled.find((m) => m.method === input.paymentMethod);
    if (!chosen) {
      throw validation('Split payments need at least two entries.');
    }
    if (!chosen.enabled) {
      throw validation(`${chosen.label} payments are switched off. An administrator can enable them in Settings.`);
    }
  }

  const store: StoreProfile = getStoreProfile(db);
  if (!store.storeName) {
    throw new AppError('SETUP_REQUIRED', 'Complete first-run setup before making sales.');
  }

  return db.transaction(() => {
    const now = nowIso();
    const shiftId = resolveShift(
      db,
      input.shiftId ?? null,
      actor,
      features.supermarket && settings.requireShift
    );

    const quote = priceCart(db, {
      lines: input.lines,
      tier: input.tier,
      docType: input.docType,
      discount: input.discount,
      loyaltyMemberId: input.loyaltyMemberId ?? null,
      loyaltyRedeemed: input.loyaltyRedeemed
    }, actor);

    /* ---- approvals ---- */
    let priceOverrideApproval: string | null = null;
    if (quote.needsPriceApproval) {
      const grant = consumeApproval(db, input.approvalToken, 'PRICE_OVERRIDE');
      if (!grant) {
        throw new AppError('APPROVAL_REQUIRED', 'A changed price needs a supervisor to approve it.');
      }
      priceOverrideApproval = grant.username;
    }
    if (quote.exceedsDiscountCap) {
      // A cashier or supervisor may only exceed the cap with an administrator
      // walking over and approving it.
      const grant = consumeApproval(db, input.approvalToken, 'DISCOUNT');
      if (!grant) {
        throw new AppError(
          'APPROVAL_REQUIRED',
          `Discounts are capped at ${settings.maxDiscountPercent}% for your role. An administrator can approve more.`
        );
      }
      priceOverrideApproval = priceOverrideApproval ?? grant.username;
    }
    // The token can only cover one approval; a basket needing two takes two
    // rounds at the till, which the renderer asks for one at a time.
    if (quote.needsPriceApproval && quote.exceedsDiscountCap && priceOverrideApproval) {
      // both were consumed above from the same single-use token only if the
      // purpose matched; reaching here means they did.
    }

    /* ---- prescription rule (pharmacy) ---- */
    const needsPrescription = quote.lines.some((l) => l.rxRequired);
    if (features.prescriptions && needsPrescription && !input.prescriptionRef?.trim()) {
      throw validation('A prescription reference is required for prescription-only items.', {
        rxRequired: true
      });
    }

    /* ---- customer + credit ---- */
    let customer: { id: number; name: string; credit_limit: number } | null = null;
    if (input.customerId) {
      const row = db.handle
        .prepare('SELECT id, name, credit_limit, active FROM customers WHERE id = ?')
        .get(input.customerId) as
        | { id: number; name: string; credit_limit: number; active: number }
        | undefined;
      if (!row || !row.active) throw validation('That customer is not on file.');
      customer = { id: row.id, name: row.name, credit_limit: row.credit_limit };
    }
    if (input.loyaltyMemberId) {
      const member = db.handle
        .prepare('SELECT id, active FROM loyalty_members WHERE id = ?')
        .get(input.loyaltyMemberId) as { id: number; active: number } | undefined;
      if (!member || !member.active) throw validation('That loyalty member is not on file.');
    }

    /* ---- stock: allocate first, so an oversell rolls the whole thing back ---- */
    interface DraftLine {
      productId: number;
      allocation: ReturnType<typeof allocateStock>[number];
      sku: string;
      name: string;
      unitPrice: number;
      listPrice: number;
      lineDiscount: number;
      promotionId: number | null;
      promotionName: string | null;
      rxRequired: boolean;
      isWeighed: boolean;
      lineTotal: number;
    }

    const draft: DraftLine[] = [];
    for (const line of quote.lines) {
      const product = requireProduct(db, line.productId);
      const allocation = allocateStock(db, product.id, line.qty, product.name);

      // Split the line over its batches, handing any rounding remainder to the
      // last part so the parts always add up to the line.
      let discountLeft = line.lineDiscount + line.promoDiscount;
      let qtyLeft = line.qty;
      allocation.forEach((part, index) => {
        const last = index === allocation.length - 1;
        const share = last
          ? discountLeft
          : Math.min(discountLeft, Math.round(((line.lineDiscount + line.promoDiscount) * part.qty) / line.qty));
        discountLeft -= share;
        qtyLeft -= part.qty;
        const gross = line.isWeighed ? Math.round((part.qty * line.unitPrice) / 1000) : part.qty * line.unitPrice;
        draft.push({
          productId: product.id,
          allocation: part,
          sku: product.sku,
          name: product.name,
          unitPrice: line.unitPrice,
          listPrice: line.listPrice,
          lineDiscount: share,
          promotionId: line.promotionId,
          promotionName: line.promotionName,
          rxRequired: line.rxRequired,
          isWeighed: line.isWeighed,
          lineTotal: gross
        });
      });
    }

    /* ---- money: checked after stock, so an oversell wins the error ---- */
    const payments: PreparedPayment[] = supplied.length
      ? supplied.map((p) => ({ method: p.method, amount: p.amount, reference: p.reference?.trim() || null }))
      : [{ method: input.paymentMethod, amount: input.amountPaid, reference: null }];

    // A credit sale without explicit payment lines puts the whole bill on account.
    if (!supplied.length && input.paymentMethod === 'CREDIT') {
      payments[0] = { method: 'CREDIT', amount: quote.total, reference: null };
      if (input.amountPaid !== 0 && input.amountPaid !== quote.total) {
        throw validation('A credit sale is tendered in full or not at all.');
      }
    }

    const cashTaken = cashOf(payments);
    const onCredit = creditOf(payments);
    const balanceDue = Math.max(0, quote.total - cashTaken);
    const changeDue = balanceDue > 0 ? 0 : Math.max(0, cashTaken - quote.total);

    if (balanceDue > 0) {
      if (!settings.paymentCredit) {
        throw validation('Credit sales are switched off. An administrator can enable them in Settings.');
      }
      if (!customer) {
        throw validation('Choose a credit customer before leaving a balance on the account.');
      }
      if (onCredit !== balanceDue) {
        throw validation('The credit line must equal the balance due.');
      }
      if (cashTaken > quote.total) {
        throw validation('A credit sale cannot give change. Reduce the amount tendered.');
      }
      if (customer.credit_limit <= 0) {
        throw validation(`${customer.name} has no credit limit. An administrator can set one on the customer record.`);
      }
      const outstanding = customerOutstanding(db, customer.id);
      if (outstanding + balanceDue > customer.credit_limit) {
        throw validation(
          `${customer.name} is over their credit limit: ₦${((outstanding + balanceDue) / 100).toFixed(2)} of ₦${(
            customer.credit_limit / 100
          ).toFixed(2)}.`
        );
      }
    } else {
      if (onCredit > 0) throw validation('The credit line must equal the balance due.');
      if (cashTaken < quote.total) {
        throw validation('Amount paid is less than the total due.');
      }
      if (supplied.length && cashTaken !== input.amountPaid) {
        throw validation('Split payments must add up to the amount tendered.');
      }
    }

    if (
      !payments.some((p) => p.method !== 'CREDIT') &&
      quote.total > 0 &&
      onCredit !== quote.total
    ) {
      throw validation('The credit line must equal the total due.');
    }

    const receiptNo = nextDocumentNumber(db, input.docType === 'INVOICE' ? 'INV' : 'RCP');

    const result = db.handle
      .prepare(
        `INSERT INTO sales
          (receipt_no, doc_type, customer_name, customer_phone, customer_address, prescription_ref,
           subtotal, discount, tax, total, amount_paid, change_due, payment_method, status,
           price_override_by, user_id, username, store_name, store_address, store_phone, note, created_at,
           customer_id, loyalty_member_id, shift_id,
           tier, balance_due, promo_discount, item_discount, loyalty_points, loyalty_redeemed, loyalty_value,
           vat_rate, print_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, 0)`
      )
      .run(
        receiptNo,
        input.docType,
        customer?.name ?? input.customerName?.trim() ?? null,
        input.customerPhone?.trim() || null,
        input.customerAddress?.trim() || null,
        input.prescriptionRef?.trim() || null,
        quote.subtotal,
        quote.totalDiscount,
        quote.tax,
        quote.total,
        cashTaken,
        changeDue,
        input.paymentMethod,
        priceOverrideApproval ? actor.userId : null,
        actor.userId,
        actor.username,
        store.storeName,
        store.storeAddress,
        store.storePhone,
        input.note?.trim() || null,
        now,
        customer?.id ?? null,
        input.loyaltyMemberId ?? null,
        shiftId,
        quote.tier,
        balanceDue,
        quote.promoDiscount,
        quote.itemDiscount,
        quote.loyaltyEarned,
        input.loyaltyRedeemed ?? 0,
        quote.loyaltyValue,
        quote.vatRate
      );
    const saleId = Number(result.lastInsertRowid);

    const insertPayment = db.handle.prepare(
      'INSERT INTO payments (sale_id, method, amount, reference, user_id, created_at, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const payment of payments) {
      insertPayment.run(
        saleId,
        payment.method,
        payment.amount,
        payment.reference,
        actor.userId,
        now,
        payment.method === 'CREDIT' ? null : shiftId
      );
    }

    const insertItem = db.handle.prepare(
      `INSERT INTO sale_items
        (sale_id, product_id, sku, name, qty, unit_price, list_price, cost_price, line_total, batch_id, batch_no,
         rx_required, is_weighed, line_discount, promotion_id, promotion_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const item of draft) {
      insertItem.run(
        saleId,
        item.productId,
        item.sku,
        item.name,
        item.allocation.qty,
        item.unitPrice,
        item.listPrice,
        item.allocation.costPrice,
        item.lineTotal,
        item.allocation.batchId,
        item.allocation.batchNo,
        item.rxRequired ? 1 : 0,
        item.isWeighed ? 1 : 0,
        item.lineDiscount,
        item.promotionId,
        item.promotionName
      );
      commitSaleAllocation(db, item.productId, item.allocation, {
        refType: 'sale',
        refId: saleId,
        userId: actor.userId
      });
    }

    /* ---- loyalty ledger ---- */
    if (input.loyaltyMemberId && features.supermarket) {
      if (quote.loyaltyRedeemed > 0) {
        adjustLoyaltyPoints(
          db,
          { memberId: input.loyaltyMemberId, points: -quote.loyaltyRedeemed, reason: `Redeemed on ${receiptNo}`, saleId },
          actor
        );
      }
      if (quote.loyaltyEarned > 0) {
        adjustLoyaltyPoints(
          db,
          { memberId: input.loyaltyMemberId, points: quote.loyaltyEarned, reason: `Earned on ${receiptNo}`, saleId },
          actor
        );
      }
      db.handle
        .prepare('UPDATE sales SET loyalty_redeemed = ?, loyalty_value = ?, loyalty_points = ? WHERE id = ?')
        .run(quote.loyaltyRedeemed, quote.loyaltyValue, quote.loyaltyEarned, saleId);
    } else if (quote.loyaltyEarned > 0 || (input.loyaltyRedeemed ?? 0) > 0) {
      db.handle
        .prepare('UPDATE sales SET loyalty_redeemed = ?, loyalty_value = ?, loyalty_points = 0 WHERE id = ?')
        .run(input.loyaltyRedeemed ?? 0, quote.loyaltyValue, saleId);
    }

    /* ---- a held basket is consumed by the sale that replaces it ---- */
    if (input.holdId) {
      db.handle.prepare('DELETE FROM held_sales WHERE id = ? AND user_id = ?').run(input.holdId, actor.userId);
    }

    const anyPriceOverride = quote.lines.some((l) => l.priceOverridden);
    audit(db, {
      action: input.docType === 'INVOICE' ? 'sale.invoice' : 'sale.create',
      entity: 'sale',
      entityId: saleId,
      userId: actor.userId,
      username: actor.username,
      severity: anyPriceOverride || quote.exceedsDiscountCap ? 'WARN' : 'INFO',
      details: {
        receiptNo,
        total: quote.total,
        discount: quote.totalDiscount,
        itemDiscount: quote.itemDiscount,
        promoDiscount: quote.promoDiscount,
        manualDiscount: quote.manualDiscount,
        items: draft.length,
        paymentMethod: input.paymentMethod,
        payments: payments.map((p) => ({ method: p.method, amount: p.amount })),
        balanceDue,
        tier: quote.tier,
        loyaltyEarned: quote.loyaltyEarned,
        loyaltyRedeemed: quote.loyaltyRedeemed,
        priceOverridden: anyPriceOverride,
        approvedBy: priceOverrideApproval,
        customer: customer?.name ?? input.customerName ?? null,
        prescriptionRef: input.prescriptionRef ?? null,
        shiftId
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
