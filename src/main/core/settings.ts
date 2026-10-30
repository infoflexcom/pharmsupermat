import type { Database } from './db';
import { nowIso } from './db';
import type { SettingsPayload, StoreProfile } from '../../shared/types';
import { validation } from './errors';

export const DEFAULT_SETTINGS: SettingsPayload = {
  storeName: '',
  storeAddress: '',
  storePhone: '',
  receiptFooter: 'Thank you for your patronage.',
  returnLimit: 2_000_000, // ₦20,000.00 — cashier returns above this need approval
  returnWindowDays: 7,
  lowStockAlerts: true,
  licenseExpiryWarningDays: 30
};

export function getAllSettings(db: Database): SettingsPayload {
  const rows = db.handle.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const readString = (key: string, fallback: string) => stored.get(key) ?? fallback;
  const readInt = (key: string, fallback: number) => {
    const raw = stored.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  };
  const readBool = (key: string, fallback: boolean) => {
    const raw = stored.get(key);
    if (raw === undefined) return fallback;
    return raw === 'true' || raw === '1';
  };
  return {
    storeName: readString('store_name', DEFAULT_SETTINGS.storeName),
    storeAddress: readString('store_address', DEFAULT_SETTINGS.storeAddress),
    storePhone: readString('store_phone', DEFAULT_SETTINGS.storePhone),
    receiptFooter: readString('receipt_footer', DEFAULT_SETTINGS.receiptFooter),
    returnLimit: readInt('return_limit', DEFAULT_SETTINGS.returnLimit),
    returnWindowDays: readInt('return_window_days', DEFAULT_SETTINGS.returnWindowDays),
    lowStockAlerts: readBool('low_stock_alerts', DEFAULT_SETTINGS.lowStockAlerts),
    licenseExpiryWarningDays: readInt(
      'license_expiry_warning_days',
      DEFAULT_SETTINGS.licenseExpiryWarningDays
    )
  };
}

export function getStoreProfile(db: Database): StoreProfile {
  const s = getAllSettings(db);
  return {
    storeName: s.storeName,
    storeAddress: s.storeAddress,
    storePhone: s.storePhone,
    receiptFooter: s.receiptFooter,
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
  const map: Record<keyof SettingsPayload, string> = {
    storeName: 'store_name',
    storeAddress: 'store_address',
    storePhone: 'store_phone',
    receiptFooter: 'receipt_footer',
    returnLimit: 'return_limit',
    returnWindowDays: 'return_window_days',
    lowStockAlerts: 'low_stock_alerts',
    licenseExpiryWarningDays: 'license_expiry_warning_days'
  };
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch) as [keyof SettingsPayload, unknown][]) {
      if (value === undefined || !(key in map)) continue;
      setSetting(db, map[key], typeof value === 'boolean' ? String(value) : String(value));
    }
  });
}

export function updateSettings(db: Database, patch: Partial<SettingsPayload>): SettingsPayload {
  if (patch.storeName !== undefined && !patch.storeName.trim()) {
    throw validation('Store name cannot be empty.');
  }
  if (patch.returnLimit !== undefined && (!Number.isInteger(patch.returnLimit) || patch.returnLimit < 0)) {
    throw validation('Return limit must be a positive amount.');
  }
  if (patch.returnWindowDays !== undefined && (!Number.isInteger(patch.returnWindowDays) || patch.returnWindowDays < 0)) {
    throw validation('Return window must be a whole number of days.');
  }
  setSettings(db, patch);
  return getAllSettings(db);
}

export function isStoreConfigured(db: Database): boolean {
  return getAllSettings(db).storeName.trim().length > 0;
}
