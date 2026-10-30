import { CURRENCY_SYMBOL } from './types';

/**
 * All money is stored and computed as integer kobo (minor units) to avoid
 * floating point drift. Conversion only happens at the UI/print boundary.
 */

export function toKobo(naira: number | string): number {
  const value = typeof naira === 'string' ? Number(naira.replace(/[^0-9.-]/g, '')) : naira;
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function toNaira(kobo: number): number {
  return Math.round(kobo) / 100;
}

export function formatMoney(kobo: number, options: { symbol?: boolean; signed?: boolean } = {}): string {
  const { symbol = true, signed = false } = options;
  const negative = kobo < 0;
  const abs = Math.abs(Math.round(kobo));
  const naira = Math.floor(abs / 100);
  const koboPart = String(abs % 100).padStart(2, '0');
  const withSeparators = naira.toLocaleString('en-NG', { maximumFractionDigits: 0 });
  const body = `${symbol ? CURRENCY_SYMBOL : ''}${withSeparators}.${koboPart}`;
  if (negative) return `-${body}`;
  return signed ? `+${body}` : body;
}

/** Parses a user supplied naira string ("1,250.50", "1250", "₦1 250") into kobo. */
export function parseMoneyInput(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') return Math.round(input * 100);
  const cleaned = input.replace(/[^0-9.-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return 0;
  return Math.round(Number(cleaned) * 100);
}

/** Formats a kobo amount for an <input type="number"> control (naira string). */
export function moneyToInput(kobo: number): string {
  return (Math.round(kobo) / 100).toFixed(2);
}
