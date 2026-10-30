import type { Database } from '../db';
import { nowIso } from '../db';

/** Atomically increments a named counter and returns a padded document number. */
export function nextDocumentNumber(db: Database, prefix: string): string {
  db.handle
    .prepare(
      `INSERT INTO counters (name, value) VALUES (?, 1)
       ON CONFLICT(name) DO UPDATE SET value = value + 1`
    )
    .run(prefix);
  const row = db.handle.prepare('SELECT value FROM counters WHERE name = ?').get(prefix) as {
    value: number;
  };
  return `${prefix}-${String(row.value).padStart(6, '0')}`;
}

export function dayRange(from?: string, to?: string): { from: string; to: string } {
  const today = new Date().toISOString().slice(0, 10);
  return { from: from || today, to: to || from || today };
}

/** ISO timestamp boundaries for an inclusive YYYY-MM-DD range (UTC). */
export function rangeBounds(from?: string, to?: string): { start: string; end: string } {
  const { from: f, to: t } = dayRange(from, to);
  return { start: `${f}T00:00:00.000Z`, end: `${t}T23:59:59.999Z` };
}

export function likeParam(value: string): string {
  return `%${value.replace(/[%_]/g, (m) => `\\${m}`)}%`;
}

export function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive whole number.`);
  }
  return value;
}

export function money(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${field} must be an amount in kobo.`);
  }
  return value;
}

export function nowText(): string {
  return nowIso();
}

export function describeAge(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
