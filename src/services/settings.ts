import type { Database } from '../db';
import { nowIso } from '../db';
import type { SettingsPayload, StoreProfile } from '../shared/types';
import { validation } from '../shared/errors';

export const DEFAULT_SETTINGS: SettingsPayload = {
  storeName: '',
  storeAddress: '',
  storePhone: '',
  storeEmail: '',
  storeLicenceNo: '',
  storeVatNo: '',
  storeLogo: '',
  receiptFooter: 'Thank you for your patronage.',
  thankYouNote: 'Thank you for your patronage.',
  returnLimit: 2_000_000, // ₦20,000.00 — cashier returns above this need approval
  returnWindowDays: 7,
  lowStockAlerts: true,
  licenseExpiryWarningDays: 30,
  idleTimeoutMinutes: 15
};

/** settings row names, kept in one place so reads and writes cannot drift. */
const KEYS: Record<keyof SettingsPayload, string> = {
  storeName: 'store_name',
  storeAddress: 'store_address',
  storePhone: 'store_phone',
  storeEmail: 'store_email',
  storeLicenceNo: 'store_licence_no',
  storeVatNo: 'store_vat_no',
  storeLogo: 'store_logo',
  receiptFooter: 'receipt_footer',
  thankYouNote: 'thank_you_note',
  returnLimit: 'return_limit',
  returnWindowDays: 'return_window_days',
  lowStockAlerts: 'low_stock_alerts',
  licenseExpiryWarningDays: 'license_expiry_warning_days',
  idleTimeoutMinutes: 'idle_timeout_minutes'
};

export const MIN_IDLE_MINUTES = 1;
export const MAX_IDLE_MINUTES = 720;

export function getAllSettings(db: Database): SettingsPayload {
  const rows = db.handle.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const readString = (key: keyof SettingsPayload, fallback: string) => {
    const raw = stored.get(KEYS[key]);
    return raw === undefined ? fallback : raw;
  };
  const readInt = (key: keyof SettingsPayload, fallback: number) => {
    const raw = stored.get(KEYS[key]);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  };
  const readBool = (key: keyof SettingsPayload, fallback: boolean) => {
    const raw = stored.get(KEYS[key]);
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };
  return {
    storeName: readString('storeName', DEFAULT_SETTINGS.storeName),
    storeAddress: readString('storeAddress', DEFAULT_SETTINGS.storeAddress),
    storePhone: readString('storePhone', DEFAULT_SETTINGS.storePhone),
    storeEmail: readString('storeEmail', DEFAULT_SETTINGS.storeEmail),
    storeLicenceNo: readString('storeLicenceNo', DEFAULT_SETTINGS.storeLicenceNo),
    storeVatNo: readString('storeVatNo', DEFAULT_SETTINGS.storeVatNo),
    storeLogo: readString('storeLogo', DEFAULT_SETTINGS.storeLogo),
    receiptFooter: readString('receiptFooter', DEFAULT_SETTINGS.receiptFooter),
    thankYouNote: readString('thankYouNote', DEFAULT_SETTINGS.thankYouNote),
    returnLimit: readInt('returnLimit', DEFAULT_SETTINGS.returnLimit),
    returnWindowDays: readInt('returnWindowDays', DEFAULT_SETTINGS.returnWindowDays),
    lowStockAlerts: readBool('lowStockAlerts', DEFAULT_SETTINGS.lowStockAlerts),
    licenseExpiryWarningDays: readInt(
      'licenseExpiryWarningDays',
      DEFAULT_SETTINGS.licenseExpiryWarningDays
    ),
    idleTimeoutMinutes: readInt('idleTimeoutMinutes', DEFAULT_SETTINGS.idleTimeoutMinutes)
  };
}

export function getStoreProfile(db: Database): StoreProfile {
  const s = getAllSettings(db);
  return {
    storeName: s.storeName,
    storeAddress: s.storeAddress,
    storePhone: s.storePhone,
    storeEmail: s.storeEmail,
    storeLicenceNo: s.storeLicenceNo,
    storeVatNo: s.storeVatNo,
    storeLogo: s.storeLogo,
    receiptFooter: s.receiptFooter,
    thankYouNote: s.thankYouNote,
    returnLimit: s.returnLimit,
    returnWindowDays: s.returnWindowDays,
    lowStockAlerts: s.lowStockAlerts
  };
}

export function setSetting(db: Database, key: string, value: string): void {
  db.handle
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, value, nowIso());
}

export function setSettings(db: Database, patch: Partial<SettingsPayload>): void {
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch) as [keyof SettingsPayload, unknown][]) {
      if (value === undefined || !(key in KEYS)) continue;
      setSetting(db, KEYS[key], typeof value === 'boolean' ? String(value) : String(value));
    }
  });
}

const LOGO_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const MAX_LOGO_BYTES = 200 * 1024;

export function validateStoreLogo(value: string | null | undefined): string {
  if (!value) return '';
  const logo = value.trim();
  if (!logo) return '';
  if (!LOGO_DATA_URL.test(logo)) {
    throw validation('The store logo must be a PNG, JPEG, WebP or SVG image.');
  }
  const base64 = logo.slice(logo.indexOf(',') + 1);
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
  if (bytes > MAX_LOGO_BYTES) throw validation('The store logo must be smaller than 200 KB.');
  return logo;
}

export function updateSettings(db: Database, patch: Partial<SettingsPayload>): SettingsPayload {
  if (patch.storeName !== undefined && !patch.storeName.trim()) {
    throw validation('Store name cannot be empty.');
  }
  if (patch.storeName !== undefined && patch.storeName.trim().length > 120) {
    throw validation('Store name is too long.');
  }
  if (patch.storeEmail !== undefined && patch.storeEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.storeEmail.trim())) {
    throw validation('The store email address looks invalid.');
  }
  if (patch.returnLimit !== undefined && (!Number.isInteger(patch.returnLimit) || patch.returnLimit < 0)) {
    throw validation('Return limit must be a positive amount.');
  }
  if (patch.returnWindowDays !== undefined && (!Number.isInteger(patch.returnWindowDays) || patch.returnWindowDays < 0)) {
    throw validation('Return window must be a whole number of days.');
  }
  if (patch.idleTimeoutMinutes !== undefined) {
    if (
      !Number.isInteger(patch.idleTimeoutMinutes) ||
      patch.idleTimeoutMinutes < MIN_IDLE_MINUTES ||
      patch.idleTimeoutMinutes > MAX_IDLE_MINUTES
    ) {
      throw validation(`Auto sign-out must be between ${MIN_IDLE_MINUTES} and ${MAX_IDLE_MINUTES} minutes.`);
    }
  }
  const next = { ...patch };
  if ('storeLogo' in patch) next.storeLogo = validateStoreLogo(patch.storeLogo);
  setSettings(db, next);
  return getAllSettings(db);
}

export function isStoreConfigured(db: Database): boolean {
  return getAllSettings(db).storeName.trim().length > 0;
}

/** Idle timeout in milliseconds, clamped to the allowed range. */
export function idleTimeoutMs(db: Database): number {
  const minutes = getAllSettings(db).idleTimeoutMinutes;
  const safe = Number.isInteger(minutes) ? Math.min(Math.max(minutes, MIN_IDLE_MINUTES), MAX_IDLE_MINUTES) : 15;
  return safe * 60_000;
}
