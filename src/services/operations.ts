import type { Database } from '../db';
import { nowIso } from '../db';
import {
  repositoriesFor,
  type CashDrawerEventRow,
  type CashierShiftRow,
  type DayClosingRow
} from '../db/repositories';
import type { CashierReconciliation, DayReconciliation, ShiftReconciliation } from '../shared/types';
import { conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { rangeBounds } from './helpers';
import type { Actor } from './stock';

/* ------------------------------------------------------------------ */
/* Day totals + closing                                                */
/* ------------------------------------------------------------------ */

export interface DayTotals {
  businessDate: string;
  salesCount: number;
  grossSales: number;
  discounts: number;
  cashSales: number;
  transferSales: number;
  posSales: number;
  otherSales: number;
  /** Every completed return in the day, whatever the refund method. */
  returnsTotal: number;
  /** Only the returns that were paid out of the drawer. */
  cashRefunds: number;
  expectedCash: number;
}

function money(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

export function computeDayTotals(db: Database, businessDate: string, openingFloat = 0): DayTotals {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) throw validation('Business date must be YYYY-MM-DD.');
  const { start, end } = rangeBounds(businessDate, businessDate);

  const sales = db.handle
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(subtotal), 0) AS gross, COALESCE(SUM(discount), 0) AS discounts
       FROM sales WHERE status = 'COMPLETED' AND created_at BETWEEN ? AND ?`
    )
    .get(start, end) as { count: number; gross: number; discounts: number };

  const payments = db.handle
    .prepare(
      `SELECT p.method AS method, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ?
       GROUP BY p.method`
    )
    .all(start, end) as { method: string; amount: number }[];

  const byMethod = new Map(payments.map((row) => [row.method, money(row.amount)]));
  const cashSales = byMethod.get('CASH') ?? 0;
  const transferSales = byMethod.get('TRANSFER') ?? 0;
  const posSales = byMethod.get('POS') ?? 0;
  const otherSales = [...byMethod.entries()]
    .filter(([method]) => !['CASH', 'TRANSFER', 'POS'].includes(method))
    .reduce((sum, [, amount]) => sum + amount, 0);

  const returns = db.handle
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total FROM returns
       WHERE status = 'COMPLETED' AND approved_at IS NOT NULL AND approved_at BETWEEN ? AND ?`
    )
    .get(start, end) as { total: number };

  const cashRefunds = db.handle
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS total FROM returns
       WHERE status = 'COMPLETED' AND approved_at BETWEEN ? AND ?
         AND (refund_method IS NULL OR refund_method = 'CASH')`
    )
    .get(start, end) as { total: number };

  return {
    businessDate,
    salesCount: sales.count,
    grossSales: money(sales.gross),
    discounts: money(sales.discounts),
    cashSales,
    transferSales,
    posSales,
    otherSales,
    returnsTotal: money(returns.total),
    cashRefunds: money(cashRefunds.total),
    expectedCash: openingFloat + cashSales - money(cashRefunds.total)
  };
}

/**
 * The end-of-day picture: the drawer as the day computes it, the saved close
 * (if the day has been closed) and — on supermarket licences — every shift and
 * cashier with their own over/short.
 *
 * Cash refunds are subtracted from the drawer; transfers, card refunds and
 * store credit never left the till.
 */
export function dayReconciliation(
  db: Database,
  businessDate: string,
  options: { openingFloat?: number; includeShifts: boolean }
): DayReconciliation {
  const closing = repositoriesFor(db).dayClosings.findOne({ business_date: businessDate });
  const openingFloat = options.openingFloat ?? closing?.opening_float ?? 0;
  const totals = computeDayTotals(db, businessDate, openingFloat);
  const { start, end } = rangeBounds(businessDate, businessDate);

  const shiftRows = options.includeShifts
    ? (db.handle
        .prepare(
          `SELECT * FROM cashier_shifts
           WHERE substr(opened_at, 1, 10) = ? OR substr(IFNULL(closed_at, ''), 1, 10) = ?
           ORDER BY opened_at`
        )
        .all(businessDate, businessDate) as CashierShiftRow[])
    : [];

  const refundsForWindow = db.handle.prepare(
    `SELECT COALESCE(SUM(total), 0) AS total FROM returns
     WHERE status = 'COMPLETED' AND approved_at BETWEEN ? AND ?
       AND (refund_method IS NULL OR refund_method = 'CASH')`
  );
  // A voided sale keeps its payment rows for the audit trail, but the money was
  // handed back, so only completed sales count towards the drawer.
  const cashForShift = db.handle.prepare(
    `SELECT COALESCE(SUM(p.amount), 0) AS total FROM payments p
     JOIN sales s ON s.id = p.sale_id
     WHERE p.shift_id = ? AND p.method = 'CASH' AND s.status = 'COMPLETED'`
  );

  const shifts: ShiftReconciliation[] = shiftRows.map((shift) => {
    const cashSales = money((cashForShift.get(shift.id) as { total: number }).total);
    const until = shift.closed_at ?? end;
    const cashRefunds = money((refundsForWindow.get(shift.opened_at, until) as { total: number }).total);
    const expectedCash = shift.opening_float + cashSales - cashRefunds;
    return {
      shiftId: shift.id,
      username: shift.username,
      openedAt: shift.opened_at,
      closedAt: shift.closed_at,
      openingFloat: shift.opening_float,
      cashSales,
      cashRefunds,
      expectedCash,
      countedCash: shift.counted_cash,
      variance: shift.counted_cash === null ? null : shift.counted_cash - expectedCash,
      status: shift.status
    };
  });

  const cashierRows = options.includeShifts
    ? (db.handle
        .prepare(
          `SELECT s.user_id, s.username, COUNT(*) AS sales, COALESCE(SUM(s.total), 0) AS gross,
                  COALESCE(SUM((SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                                WHERE p.sale_id = s.id AND p.method = 'CASH')), 0) AS cash
           FROM sales s
           WHERE s.status = 'COMPLETED' AND s.created_at BETWEEN ? AND ? AND s.user_id IS NOT NULL
           GROUP BY s.user_id, s.username ORDER BY cash DESC`
        )
        .all(start, end) as { user_id: number; username: string; sales: number; gross: number; cash: number }[])
    : [];

  const refundsByUser = db.handle
    .prepare(
      `SELECT requested_by AS user_id, COALESCE(SUM(total), 0) AS total FROM returns
       WHERE status = 'COMPLETED' AND approved_at BETWEEN ? AND ?
         AND (refund_method IS NULL OR refund_method = 'CASH') GROUP BY requested_by`
    )
    .all(start, end) as { user_id: number | null; total: number }[];

  const floatByUser = new Map<number, number>();
  for (const shift of shiftRows) {
    floatByUser.set(shift.user_id, (floatByUser.get(shift.user_id) ?? 0) + shift.opening_float);
  }
  const countedByUser = new Map<number, number>();
  for (const shift of shiftRows) {
    if (shift.counted_cash !== null) {
      countedByUser.set(shift.user_id, (countedByUser.get(shift.user_id) ?? 0) + shift.counted_cash);
    }
  }

  const fullNames = new Map(
    (db.handle.prepare('SELECT id, full_name FROM users').all() as { id: number; full_name: string }[]).map((row) => [
      row.id,
      row.full_name
    ])
  );

  const cashiers: CashierReconciliation[] = cashierRows.map((row) => {
    const cashRefunds = money(refundsByUser.find((r) => r.user_id === row.user_id)?.total ?? 0);
    const float = floatByUser.get(row.user_id) ?? 0;
    const expectedCash = float + money(row.cash) - cashRefunds;
    const counted = countedByUser.get(row.user_id) ?? null;
    return {
      userId: row.user_id,
      username: row.username,
      fullName: fullNames.get(row.user_id) ?? row.username,
      salesCount: row.sales,
      gross: money(row.gross),
      cashSales: money(row.cash),
      cashRefunds,
      expectedCash,
      countedCash: counted,
      variance: counted === null ? null : counted - expectedCash
    };
  });

  return {
    businessDate,
    openingFloat,
    salesCount: totals.salesCount,
    grossSales: totals.grossSales,
    discounts: totals.discounts,
    cashSales: totals.cashSales,
    transferSales: totals.transferSales,
    posSales: totals.posSales,
    otherSales: totals.otherSales,
    returnsTotal: totals.returnsTotal,
    cashRefunds: totals.cashRefunds,
    expectedCash: totals.expectedCash,
    countedCash: closing?.counted_cash ?? null,
    variance: closing?.variance ?? null,
    closedAt: closing?.closed_at ?? null,
    closedBy: closing?.closed_by_name ?? null,
    note: closing?.note ?? null,
    canClose: !closing?.closed_at,
    shiftReconciliation: options.includeShifts,
    shifts,
    cashiers
  };
}

export function listDayClosings(db: Database, limit = 60): DayClosingRow[] {
  return repositoriesFor(db).dayClosings.all({}, { limit });
}

export function closeDay(
  db: Database,
  input: { businessDate: string; openingFloat?: number; countedCash: number; note?: string },
  actor: Actor
): DayClosingRow {
  const businessDate = (input.businessDate ?? '').trim();
  if (!businessDate) throw validation('Choose the business date to close.');
  if (!Number.isInteger(input.countedCash) || input.countedCash < 0) {
    throw validation('Counted cash must be an amount in kobo.');
  }
  if (input.openingFloat !== undefined && (!Number.isInteger(input.openingFloat) || input.openingFloat < 0)) {
    throw validation('Opening float must be an amount in kobo.');
  }

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const openingFloat = input.openingFloat ?? 0;
    const existing = repos.dayClosings.findOne({ business_date: businessDate });
    if (existing?.closed_at) throw conflict(`The day ${businessDate} has already been closed.`);
    const totals = computeDayTotals(db, businessDate, openingFloat);
    const now = nowIso();
    const payload = {
      business_date: businessDate,
      opened_at: existing?.opened_at ?? `${businessDate}T00:00:00.000Z`,
      closed_at: now,
      opening_float: openingFloat,
      cash_sales: totals.cashSales,
      transfer_sales: totals.transferSales,
      pos_sales: totals.posSales,
      other_sales: totals.otherSales,
      returns_total: totals.returnsTotal,
      expected_cash: totals.expectedCash,
      counted_cash: input.countedCash,
      variance: input.countedCash - totals.expectedCash,
      sales_count: totals.salesCount,
      closed_by: actor.userId,
      closed_by_name: actor.username,
      note: input.note?.trim() || null
    };
    const id = existing ? (repos.dayClosings.update(existing.id, payload), existing.id) : repos.dayClosings.insert(payload);

    audit(db, {
      action: 'day.close',
      entity: 'day_closing',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      severity: payload.variance === 0 ? 'INFO' : 'WARN',
      details: {
        businessDate,
        variance: payload.variance,
        countedCash: input.countedCash,
        expectedCash: totals.expectedCash,
        cashRefunds: totals.cashRefunds
      }
    });
    return repos.dayClosings.findById(id)!;
  });
}

/* ------------------------------------------------------------------ */
/* Cashier shifts (supermarket module)                                 */
/* ------------------------------------------------------------------ */

export function listShifts(
  db: Database,
  query: { status?: 'OPEN' | 'CLOSED'; userId?: number; limit?: number } = {}
): CashierShiftRow[] {
  const repos = repositoriesFor(db);
  const where: Partial<CashierShiftRow> = {};
  if (query.status) where.status = query.status;
  if (query.userId) where.user_id = query.userId;
  return repos.shifts.all(where, { limit: query.limit ?? 50 });
}

export function openShift(db: Database, input: { openingFloat?: number; note?: string }, actor: Actor): CashierShiftRow {
  const openingFloat = input.openingFloat ?? 0;
  if (!Number.isInteger(openingFloat) || openingFloat < 0) throw validation('Opening float must be an amount in kobo.');

  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const alreadyOpen = repos.shifts.findOne({ user_id: actor.userId, status: 'OPEN' });
    if (alreadyOpen) throw conflict('You already have an open shift. Close it first.');
    const now = nowIso();
    const id = Number(
      repos.shifts.insert({
        user_id: actor.userId,
        username: actor.username,
        opened_at: now,
        opening_float: openingFloat,
        expected_cash: openingFloat,
        status: 'OPEN',
        note: input.note?.trim() || null
      })
    );
    repos.drawerEvents.insert({
      shift_id: id,
      user_id: actor.userId,
      username: actor.username,
      event_type: 'OPEN',
      amount: openingFloat,
      reason: 'Shift opened',
      created_at: now
    });
    audit(db, {
      action: 'shift.open',
      entity: 'cashier_shift',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { openingFloat }
    });
    return repos.shifts.findById(id)!;
  });
}

export function shiftCashTotal(db: Database, shiftId: number): number {
  const row = db.handle
    .prepare(
      `SELECT COALESCE(SUM(p.amount), 0) AS cash
       FROM payments p JOIN sales s ON s.id = p.sale_id
       WHERE s.shift_id = ? AND s.status = 'COMPLETED' AND p.method = 'CASH'`
    )
    .get(shiftId) as { cash: number };
  return money(row.cash);
}

export function closeShift(
  db: Database,
  input: { shiftId: number; countedCash: number; note?: string },
  actor: Actor
): CashierShiftRow {
  if (!Number.isInteger(input.countedCash) || input.countedCash < 0) {
    throw validation('Counted cash must be an amount in kobo.');
  }
  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const shift = repos.shifts.findById(input.shiftId);
    if (!shift) throw notFound('Shift');
    if (shift.status === 'CLOSED') throw conflict('That shift is already closed.');
    if (shift.user_id !== actor.userId) {
      throw conflict('Only the cashier who opened the shift can close it.');
    }
    const expected = shift.opening_float + shiftCashTotal(db, shift.id);
    const now = nowIso();
    repos.shifts.update(shift.id, {
      status: 'CLOSED',
      closed_at: now,
      counted_cash: input.countedCash,
      expected_cash: expected,
      variance: input.countedCash - expected,
      note: input.note?.trim() || shift.note
    });
    repos.drawerEvents.insert({
      shift_id: shift.id,
      user_id: actor.userId,
      username: actor.username,
      event_type: 'CLOSE',
      amount: input.countedCash,
      reason: input.note?.trim() || 'Shift closed',
      created_at: now
    });
    audit(db, {
      action: 'shift.close',
      entity: 'cashier_shift',
      entityId: shift.id,
      userId: actor.userId,
      username: actor.username,
      severity: input.countedCash === expected ? 'INFO' : 'WARN',
      details: { expected, counted: input.countedCash, variance: input.countedCash - expected }
    });
    return repos.shifts.findById(shift.id)!;
  });
}

export type DrawerEventType = 'OPEN' | 'NO_SALE' | 'PAID_IN' | 'PAID_OUT' | 'CLOSE';

export function logDrawerEvent(
  db: Database,
  input: { eventType: Exclude<DrawerEventType, 'OPEN' | 'CLOSE'>; amount?: number; reason?: string },
  actor: Actor
): CashDrawerEventRow {
  const amount = input.amount ?? 0;
  if (!Number.isInteger(amount) || amount < 0) throw validation('Drawer amount must be an amount in kobo.');
  if ((input.eventType === 'PAID_IN' || input.eventType === 'PAID_OUT') && amount <= 0) {
    throw validation('Paid-in and paid-out events need an amount.');
  }
  return db.transaction(() => {
    const repos = repositoriesFor(db);
    const shift = repos.shifts.findOne({ user_id: actor.userId, status: 'OPEN' });
    const now = nowIso();
    const id = Number(
      repos.drawerEvents.insert({
        shift_id: shift?.id ?? null,
        user_id: actor.userId,
        username: actor.username,
        event_type: input.eventType,
        amount,
        reason: input.reason?.trim() || null,
        created_at: now
      })
    );
    audit(db, {
      action: `drawer.${input.eventType.toLowerCase()}`,
      entity: 'cash_drawer_event',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      details: { amount, shiftId: shift?.id ?? null, reason: input.reason ?? null }
    });
    return repos.drawerEvents.findById(id)!;
  });
}

export function listDrawerEvents(db: Database, query: { shiftId?: number; limit?: number } = {}): CashDrawerEventRow[] {
  const repos = repositoriesFor(db);
  return repos.drawerEvents.all(query.shiftId ? { shift_id: query.shiftId } : {}, { limit: query.limit ?? 100 });
}
