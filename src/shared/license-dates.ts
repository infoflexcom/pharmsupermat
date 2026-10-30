/**
 * Licence date helpers.
 *
 * Business dates are local calendar days (`YYYY-MM-DD`). A licence period runs
 * from the start date up to — but not including — the end date, so an end date
 * of "today" already locks the app. Shared by the main process and the
 * renderer so both sides compute the same day.
 */

export const DAY_MS = 86_400_000;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local calendar date as `YYYY-MM-DD` (no UTC shifting). */
export function localDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [, y, m, d] = DATE_RE.exec(value)!;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return (
    date.getFullYear() === Number(y) &&
    date.getMonth() === Number(m) - 1 &&
    date.getDate() === Number(d)
  );
}

export function parseBusinessDate(value: string): Date {
  const [, y, m, d] = DATE_RE.exec(value)!;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

export function addDays(value: string, days: number): string {
  const date = parseBusinessDate(value);
  date.setDate(date.getDate() + days);
  return localDate(date);
}

export function addYears(value: string, years: number): string {
  const date = parseBusinessDate(value);
  const day = date.getDate();
  date.setFullYear(date.getFullYear() + years);
  // 29 Feb + 1 year lands on 1 March in JS; clamp to the last day of the month.
  if (date.getDate() !== day) date.setDate(0);
  return localDate(date);
}

/** Whole days from `from` to `to` (both business dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseBusinessDate(to).getTime() - parseBusinessDate(from).getTime()) / DAY_MS);
}

/** Start of the end date in local time — the first instant the app locks. */
export function periodEndInstant(endsOn: string): Date {
  return parseBusinessDate(endsOn);
}
