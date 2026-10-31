/**
 * Point-of-sale helpers that are not part of recording a sale: the till's
 * configuration, parked baskets, printed documents and their reprint trail,
 * customer credit balances and the customer display.
 *
 * Every function here is called from the main process only; the IPC layer
 * checks permissions and edition flags before it gets this far.
 */
import type { Database } from '../db';
import { nowIso } from '../db';
import { repositoriesFor, type DocumentPrintRow } from '../db/repositories';
import type {
  CreditPaymentInput,
  DisplayState,
  FeatureFlags,
  HeldSale,
  PosConfig,
  ReceiptLayout,
  Sale,
  SaleDocumentPayload,
  SettingsPayload
} from '../shared/types';
import { RECEIPT_LAYOUTS } from '../shared/types';
import { AppError, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { buildSaleDocument } from './documents';
import { nextDocumentNumber } from './helpers';
import { customerOutstanding, getSale } from './sales';
import { enabledPaymentMethods, getAllSettings, getStoreProfile, vatBasisPoints } from './settings';
import { shiftCashTotal } from './operations';
import type { Actor } from './stock';

export interface PosActor extends Actor {
  permissions: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Till configuration                                                  */
/* ------------------------------------------------------------------ */

interface ShiftRow {
  id: number;
  opened_at: string;
  opening_float: number;
  expected_cash: number;
}

function openShiftFor(db: Database, userId: number): ShiftRow | undefined {
  return db.handle
    .prepare(
      "SELECT id, opened_at, opening_float, expected_cash FROM cashier_shifts WHERE user_id = ? AND status = 'OPEN' ORDER BY id DESC LIMIT 1"
    )
    .get(userId) as ShiftRow | undefined;
}

/** Everything the till screen needs to draw itself, in one call. */
export function getPosConfig(db: Database, actor: PosActor, features: FeatureFlags): PosConfig {
  const settings = getAllSettings(db);
  const shift = openShiftFor(db, actor.userId);
  const isAdmin = actor.permissions.includes('settings.manage');
  return {
    paymentMethods: enabledPaymentMethods(db),
    vatEnabled: settings.vatEnabled,
    vatRate: settings.vatRate,
    maxDiscountPercent: settings.maxDiscountPercent,
    // Administrators set the cap, so they are not bound by it.
    canDiscountFreely: isAdmin,
    canOverridePrice: actor.permissions.includes('prices.override'),
    loyaltyEnabled: features.supermarket,
    loyaltyPointsPer100: settings.loyaltyPointsPer100,
    loyaltyPointValue: settings.loyaltyPointValue,
    loyaltyRedeemEnabled: settings.loyaltyRedeemEnabled,
    requireShift: features.supermarket && settings.requireShift,
    shift: shift
      ? {
          id: shift.id,
          openedAt: shift.opened_at,
          openingFloat: shift.opening_float,
          expectedCash: shift.opening_float + shiftCashTotal(db, shift.id)
        }
      : null,
    customerDisplay: settings.customerDisplay,
    receiptLayout: settings.receiptLayout,
    poweredByFooter: settings.poweredByFooter,
    wholesaleEnabled: features.wholesale && actor.permissions.includes('wholesale.sell')
  };
}

/** The VAT percentage to show on the till (0 when VAT is switched off). */
export function currentVatRate(settings: SettingsPayload): number {
  return vatBasisPoints(settings);
}

/* ------------------------------------------------------------------ */
/* Held (parked) baskets                                               */
/* ------------------------------------------------------------------ */

export interface HoldInput {
  label?: string;
  customerName?: string;
  total?: number;
  linesCount?: number;
  /** Exactly what the till needs to rebuild the basket. */
  payload: string | Record<string, unknown>;
}

function mapHold(row: {
  id: number;
  hold_no: string;
  label: string | null;
  lines_count: number;
  total: number;
  customer_name: string | null;
  username: string;
  created_at: string;
}): HeldSale {
  return {
    id: row.id,
    holdNo: row.hold_no,
    label: row.label,
    linesCount: row.lines_count,
    total: row.total,
    customerName: row.customer_name,
    username: row.username,
    createdAt: row.created_at
  };
}

/** Parks a basket so the till can serve the next customer. Nothing is sold yet. */
export function holdSale(db: Database, input: HoldInput, actor: PosActor): HeldSale {
  if (!input || input.payload === undefined) throw validation('There is nothing in the basket to hold.');
  const payload = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
  if (payload.length > 200_000) throw validation('That basket is too large to hold.');
  try {
    JSON.parse(payload);
  } catch {
    throw validation('The held basket is not valid.');
  }
  const total = input.total ?? 0;
  if (!Number.isInteger(total) || total < 0) throw validation('The held total is invalid.');
  const linesCount = input.linesCount ?? 0;
  if (!Number.isInteger(linesCount) || linesCount < 0) throw validation('The held basket is invalid.');

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const holdNo = nextDocumentNumber(db, 'HLD');
    const id = Number(
      repos.heldSales.insert({
        hold_no: holdNo,
        label: input.label?.trim() || null,
        payload,
        lines_count: linesCount,
        total,
        customer_name: input.customerName?.trim() || null,
        user_id: actor.userId,
        username: actor.username,
        created_at: nowIso()
      })
    );
    audit(db, {
      action: 'pos.hold',
      entity: 'held_sale',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { holdNo, total, linesCount }
    });
    const row = repos.heldSales.findById(id)!;
    return mapHold(row);
  });
}

/** Held baskets: a cashier sees their own, an approver sees the till's. */
export function listHeldSales(db: Database, actor: PosActor): HeldSale[] {
  const repos = repositoriesFor(db);
  const rows = actor.permissions.includes('sales.view.all')
    ? repos.heldSales.all()
    : repos.heldSales.all({ user_id: actor.userId });
  return rows.map(mapHold);
}

export function getHeldSale(db: Database, id: number, actor: PosActor): HeldSale & { payload: string } {
  const row = repositoriesFor(db).heldSales.findById(id);
  if (!row) throw notFound('Held basket');
  if (row.user_id !== actor.userId && !actor.permissions.includes('sales.view.all')) {
    throw new AppError('FORBIDDEN', 'That basket belongs to another cashier.');
  }
  return { ...mapHold(row), payload: row.payload };
}

/** Removes a held basket the cashier no longer needs. Holds never contain sales. */
export function cancelHeldSale(db: Database, id: number, actor: PosActor): { cancelled: true } {
  const row = repositoriesFor(db).heldSales.findById(id);
  if (!row) throw notFound('Held basket');
  if (row.user_id !== actor.userId && !actor.permissions.includes('sales.view.all')) {
    throw new AppError('FORBIDDEN', 'That basket belongs to another cashier.');
  }
  return db.transaction(() => {
    repositoriesFor(db).heldSales.remove(id);
    audit(db, {
      action: 'pos.hold.cancel',
      entity: 'held_sale',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { holdNo: row.hold_no, total: row.total }
    });
    return { cancelled: true as const };
  });
}

/* ------------------------------------------------------------------ */
/* Printing                                                            */
/* ------------------------------------------------------------------ */

const LAYOUTS = RECEIPT_LAYOUTS.map((l) => l.value);

function normaliseLayout(value: unknown, fallback: ReceiptLayout): ReceiptLayout {
  return LAYOUTS.includes(value as ReceiptLayout) ? (value as ReceiptLayout) : fallback;
}

/**
 * Renders a receipt/invoice and records the print.
 *
 * The very first print of a sale is the original; every later print is stamped
 * DUPLICATE and logged, so a reprint can never be passed off as a new receipt.
 * If the store has no name there is nothing to head the document with, so
 * printing is blocked with a pointer to Settings.
 */
export function printSaleDocument(
  db: Database,
  input: { id: number; layout?: ReceiptLayout },
  actor: PosActor,
  features: FeatureFlags
): SaleDocumentPayload {
  const sale = getSale(db, input.id);
  if (sale.userId !== actor.userId && !actor.permissions.includes('sales.view.all')) {
    throw new AppError('FORBIDDEN', 'You can only print your own sales.');
  }
  const settings = getAllSettings(db);
  const store = getStoreProfile(db);

  if (!store.storeName || !store.storeName.trim()) {
    throw new AppError(
      'PRINT_BLOCKED',
      'This store has no name yet, so receipts cannot be printed. An administrator must set the store name in Settings → Store profile.'
    );
  }
  if (!sale.storeName || !sale.storeName.trim()) {
    throw new AppError(
      'PRINT_BLOCKED',
      'This document has no store name stored with it. An administrator must set the store name in Settings → Store profile.'
    );
  }

  const fallback: ReceiptLayout = sale.docType === 'INVOICE' ? 'A4_INVOICE' : settings.receiptLayout;
  const layout = normaliseLayout(input.layout, fallback);
  const duplicate = sale.printCount > 0;

  return db.transaction(() => {
    const html = buildSaleDocument(sale, store, features.productName, {
      layout,
      duplicate,
      poweredBy: settings.poweredByFooter
    });
    const now = nowIso();
    repositoriesFor(db).documentPrints.insert({
      sale_id: sale.id,
      layout,
      duplicate: duplicate ? 1 : 0,
      user_id: actor.userId,
      username: actor.username,
      created_at: now
    });
    db.handle
      .prepare('UPDATE sales SET print_count = print_count + 1, last_printed_at = ? WHERE id = ?')
      .run(now, sale.id);
    audit(db, {
      action: duplicate ? 'sale.reprint' : 'sale.print',
      entity: 'sale',
      entityId: sale.id,
      userId: actor.userId,
      username: actor.username,
      severity: duplicate ? 'WARN' : 'INFO',
      details: { receiptNo: sale.receiptNo, layout, duplicate }
    });
    return { html, sale: getSale(db, sale.id), layout, duplicate };
  });
}

export function listDocumentPrints(db: Database, saleId: number): DocumentPrintRow[] {
  return repositoriesFor(db).documentPrints.all({ sale_id: saleId });
}

/* ------------------------------------------------------------------ */
/* Customer credit                                                     */
/* ------------------------------------------------------------------ */

export interface CreditBalance {
  customerId: number;
  name: string;
  phone: string | null;
  creditLimit: number;
  outstanding: number;
  invoices: number;
}

export function listCreditBalances(db: Database, search?: string): CreditBalance[] {
  const like = search?.trim() ? `%${search.trim()}%` : null;
  const rows = db.handle
    .prepare(
      `SELECT c.id, c.name, c.phone, c.credit_limit,
              COALESCE((SELECT SUM(s.balance_due) FROM sales s
                        WHERE s.customer_id = c.id AND s.status = 'COMPLETED' AND s.balance_due > 0), 0) AS outstanding,
              (SELECT COUNT(*) FROM sales s
               WHERE s.customer_id = c.id AND s.status = 'COMPLETED' AND s.balance_due > 0) AS invoices
       FROM customers c
       WHERE c.active = 1 ${like ? 'AND (c.name LIKE ? OR IFNULL(c.phone, \'\') LIKE ?)' : ''}
       ORDER BY c.name COLLATE NOCASE`
    )
    .all(...(like ? [like, like] : [])) as {
    id: number;
    name: string;
    phone: string | null;
    credit_limit: number;
    outstanding: number;
    invoices: number;
  }[];
  return rows.map((r) => ({
    customerId: r.id,
    name: r.name,
    phone: r.phone,
    creditLimit: r.credit_limit,
    outstanding: r.outstanding,
    invoices: r.invoices
  }));
}

export interface CreditInvoice {
  id: number;
  receiptNo: string;
  createdAt: string;
  total: number;
  balanceDue: number;
  docType: string;
}

/** Open invoices for a customer, oldest first (FIFO is how shops collect). */
export function listCreditInvoices(db: Database, customerId: number): CreditInvoice[] {
  const rows = db.handle
    .prepare(
      `SELECT id, receipt_no, created_at, total, balance_due, doc_type FROM sales
       WHERE customer_id = ? AND status = 'COMPLETED' AND balance_due > 0
       ORDER BY created_at, id`
    )
    .all(customerId) as {
    id: number;
    receipt_no: string;
    created_at: string;
    total: number;
    balance_due: number;
    doc_type: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    receiptNo: r.receipt_no,
    createdAt: r.created_at,
    total: r.total,
    balanceDue: r.balance_due,
    docType: r.doc_type
  }));
}

/**
 * Records money a credit customer has paid against an invoice. The original
 * sale is never edited apart from its cached balance, and the payment counts
 * towards the drawer of the shift that took it.
 */
export function recordCreditPayment(
  db: Database,
  input: CreditPaymentInput,
  actor: PosActor,
  features: FeatureFlags
): Sale {
  if (!input || !Number.isInteger(input.saleId)) throw validation('Choose the invoice being paid.');
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw validation('Enter the amount received.');
  }
  const method = input.method;
  if (method !== 'CASH' && method !== 'TRANSFER' && method !== 'POS') {
    throw validation('Credit can only be paid with cash, transfer or card.');
  }
  const enabled = enabledPaymentMethods(db).find((m) => m.method === method);
  if (!enabled?.enabled) {
    throw validation(`${enabled?.label ?? method} payments are switched off in Settings.`);
  }
  const sale = getSale(db, input.saleId);
  if (sale.status === 'VOIDED') throw new AppError('CONFLICT', 'That invoice has been voided.');
  if (sale.balanceDue <= 0) throw new AppError('CONFLICT', 'That invoice has nothing left to pay.');
  if (input.amount > sale.balanceDue) {
    throw validation(`The balance on ${sale.receiptNo} is only ₦${(sale.balanceDue / 100).toFixed(2)}.`);
  }

  return db.transaction(() => {
    const now = nowIso();
    const shift = openShiftFor(db, actor.userId);
    db.handle
      .prepare(
        'INSERT INTO payments (sale_id, method, amount, reference, user_id, created_at, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(sale.id, method, input.amount, input.reference?.trim() || 'Credit payment', actor.userId, now, shift?.id ?? null);
    db.handle
      .prepare('UPDATE sales SET balance_due = balance_due - ?, amount_paid = amount_paid + ? WHERE id = ?')
      .run(input.amount, input.amount, sale.id);
    const remaining = sale.balanceDue - input.amount;
    audit(db, {
      action: 'sale.credit.payment',
      entity: 'sale',
      entityId: sale.id,
      userId: actor.userId,
      username: actor.username,
      details: { receiptNo: sale.receiptNo, amount: input.amount, method, remaining }
    });
    if (features.supermarket && shift) {
      audit(db, {
        action: 'drawer.credit.payment',
        entity: 'cashier_shift',
        entityId: shift.id,
        userId: actor.userId,
        username: actor.username,
        details: { amount: input.amount, method, receiptNo: sale.receiptNo }
      });
    }
    return getSale(db, sale.id);
  });
}

/** Total a customer owes, used by the customer list and the profile screen. */
export function customerBalanceSummary(db: Database, customerId: number): CreditBalance | null {
  const row = listCreditBalances(db).find((c) => c.customerId === customerId);
  if (row) return row;
  const customer = db.handle.prepare('SELECT id, name, phone, credit_limit FROM customers WHERE id = ?').get(customerId) as
    | { id: number; name: string; phone: string | null; credit_limit: number }
    | undefined;
  if (!customer) return null;
  return {
    customerId: customer.id,
    name: customer.name,
    phone: customer.phone,
    creditLimit: customer.credit_limit,
    outstanding: customerOutstanding(db, customer.id),
    invoices: 0
  };
}

/* ------------------------------------------------------------------ */
/* Customer display                                                    */
/* ------------------------------------------------------------------ */

/**
 * Shapes the running basket for the customer-facing panel. Kept on the server
 * so the panel shows exactly what the till will charge.
 */
export function displayState(
  db: Database,
  basket: {
    lines: { name: string; qty: number; amount: number; isWeighed?: boolean }[];
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    paid: number;
  }
): DisplayState {
  const settings = getAllSettings(db);
  const change = Math.max(0, (basket.paid ?? 0) - basket.total);
  return {
    storeName: settings.storeName,
    lines: basket.lines.map((l) => ({
      name: l.name,
      qty: l.qty,
      amount: l.amount,
      isWeighed: Boolean(l.isWeighed)
    })),
    subtotal: basket.subtotal,
    discount: basket.discount,
    tax: basket.tax,
    total: basket.total,
    paid: basket.paid,
    change,
    updatedAt: nowIso()
  };
}
