import type { Database } from '../db';
import { nowIso } from '../db';
import {
  repositoriesFor,
  type CashDrawerEventRow,
  type CashierShiftRow,
  type DayClosingRow
} from '../db/repositories';
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
  cashSales: number;
  transferSales: number;
  posSales: number;
  otherSales: number;
  returnsTotal: number;
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
      `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS gross
       FROM sales WHERE status = 'COMPLETED' AND created_at BETWEEN ? AND ?`
    )
    .get(start, end) as { count: number; gross: number };

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

  return {
    businessDate,
    salesCount: sales.count,
    grossSales: money(sales.gross),
    cashSales,
    transferSales,
    posSales,
    otherSales,
    returnsTotal: money(returns.total),
    expectedCash: openingFloat + cashSales - money(returns.total)
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
      details: { businessDate, variance: payload.variance, countedCash: input.countedCash }
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
