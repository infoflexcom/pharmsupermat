import type { Database } from '../db';
import { nowIso } from '../db';
import { RECEIPT_LAYOUTS, type SettingsPayload, type StoreProfile } from '../shared/types';
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
  idleTimeoutMinutes: 15,
  vatEnabled: false,
  vatRate: 7.5,
  maxDiscountPercent: 10,
  paymentCash: true,
  paymentTransfer: true,
  paymentPos: true,
  paymentCredit: false,
  poweredByFooter: true,
  receiptLayout: 'THERMAL_80',
  customerDisplay: false,
  requireShift: true,
  loyaltyPointsPer100: 1,
  loyaltyPointValue: 100,
  loyaltyRedeemEnabled: true,
  printerName: '',
  silentPrint: false,
  labelPrinterName: '',
  // The migration seeds 90 days under the same key, so existing shops keep it.
  expiryAlertDays: 90,
  approvalTtlMinutes: 5,
  supervisorSelfApproval: true,
  scalePrefix: '2',
  scalePluDigits: 5,
  scaleWeightDigits: 5
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
  idleTimeoutMinutes: 'idle_timeout_minutes',
  vatEnabled: 'vat_enabled',
  vatRate: 'vat_rate',
  maxDiscountPercent: 'max_discount_percent',
  paymentCash: 'payment_cash',
  paymentTransfer: 'payment_transfer',
  paymentPos: 'payment_pos',
  paymentCredit: 'payment_credit',
  poweredByFooter: 'powered_by_footer',
  receiptLayout: 'receipt_layout',
  customerDisplay: 'customer_display',
  requireShift: 'require_shift',
  loyaltyPointsPer100: 'loyalty_points_per_100',
  loyaltyPointValue: 'loyalty_point_value',
  loyaltyRedeemEnabled: 'loyalty_redeem_enabled',
  printerName: 'printer_name',
  silentPrint: 'silent_print',
  labelPrinterName: 'label_printer_name',
  expiryAlertDays: 'expiry_alert_days',
  approvalTtlMinutes: 'approval_ttl_minutes',
  supervisorSelfApproval: 'supervisor_self_approval',
  scalePrefix: 'scale_prefix',
  scalePluDigits: 'scale_plu_digits',
  scaleWeightDigits: 'scale_weight_digits'
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
  const readDecimal = (key: keyof SettingsPayload, fallback: number) => {
    const raw = stored.get(KEYS[key]);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
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
    idleTimeoutMinutes: readInt('idleTimeoutMinutes', DEFAULT_SETTINGS.idleTimeoutMinutes),
    vatEnabled: readBool('vatEnabled', DEFAULT_SETTINGS.vatEnabled),
    vatRate: readDecimal('vatRate', DEFAULT_SETTINGS.vatRate),
    maxDiscountPercent: readInt('maxDiscountPercent', DEFAULT_SETTINGS.maxDiscountPercent),
    paymentCash: readBool('paymentCash', DEFAULT_SETTINGS.paymentCash),
    paymentTransfer: readBool('paymentTransfer', DEFAULT_SETTINGS.paymentTransfer),
    paymentPos: readBool('paymentPos', DEFAULT_SETTINGS.paymentPos),
    paymentCredit: readBool('paymentCredit', DEFAULT_SETTINGS.paymentCredit),
    poweredByFooter: readBool('poweredByFooter', DEFAULT_SETTINGS.poweredByFooter),
    receiptLayout: (readString('receiptLayout', DEFAULT_SETTINGS.receiptLayout) as SettingsPayload['receiptLayout']) ?? 'THERMAL_80',
    customerDisplay: readBool('customerDisplay', DEFAULT_SETTINGS.customerDisplay),
    requireShift: readBool('requireShift', DEFAULT_SETTINGS.requireShift),
    loyaltyPointsPer100: readInt('loyaltyPointsPer100', DEFAULT_SETTINGS.loyaltyPointsPer100),
    loyaltyPointValue: readInt('loyaltyPointValue', DEFAULT_SETTINGS.loyaltyPointValue),
    loyaltyRedeemEnabled: readBool('loyaltyRedeemEnabled', DEFAULT_SETTINGS.loyaltyRedeemEnabled),
    printerName: readString('printerName', DEFAULT_SETTINGS.printerName),
    silentPrint: readBool('silentPrint', DEFAULT_SETTINGS.silentPrint),
    labelPrinterName: readString('labelPrinterName', DEFAULT_SETTINGS.labelPrinterName),
    expiryAlertDays: readInt('expiryAlertDays', DEFAULT_SETTINGS.expiryAlertDays),
    approvalTtlMinutes: readInt('approvalTtlMinutes', DEFAULT_SETTINGS.approvalTtlMinutes),
    supervisorSelfApproval: readBool('supervisorSelfApproval', DEFAULT_SETTINGS.supervisorSelfApproval),
    scalePrefix: readString('scalePrefix', DEFAULT_SETTINGS.scalePrefix),
    scalePluDigits: readInt('scalePluDigits', DEFAULT_SETTINGS.scalePluDigits),
    scaleWeightDigits: readInt('scaleWeightDigits', DEFAULT_SETTINGS.scaleWeightDigits)
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
  if (patch.maxDiscountPercent !== undefined) {
    if (
      !Number.isInteger(patch.maxDiscountPercent) ||
      patch.maxDiscountPercent < 0 ||
      patch.maxDiscountPercent > 100
    ) {
      throw validation('The discount cap must be a whole percentage between 0 and 100.');
    }
  }
  if (patch.vatRate !== undefined) {
    if (!Number.isFinite(patch.vatRate) || patch.vatRate < 0 || patch.vatRate > 100) {
      throw validation('VAT must be a percentage between 0 and 100.');
    }
  }
  if (patch.loyaltyPointsPer100 !== undefined && (!Number.isInteger(patch.loyaltyPointsPer100) || patch.loyaltyPointsPer100 < 0)) {
    throw validation('Loyalty points per ₦100 must be zero or more.');
  }
  if (patch.loyaltyPointValue !== undefined && (!Number.isInteger(patch.loyaltyPointValue) || patch.loyaltyPointValue < 0)) {
    throw validation('The value of one loyalty point must be a positive amount.');
  }
  if (patch.receiptLayout !== undefined && !RECEIPT_LAYOUTS.some((layout) => layout.value === patch.receiptLayout)) {
    throw validation('Choose a valid receipt layout.');
  }
  if (patch.storeLicenceNo !== undefined && patch.storeLicenceNo.trim().length > 60) {
    throw validation('The licence number is too long.');
  }
  if (patch.storeVatNo !== undefined && patch.storeVatNo.trim().length > 60) {
    throw validation('The tax number is too long.');
  }
  if (patch.receiptFooter !== undefined && patch.receiptFooter.length > 300) {
    throw validation('The receipt footer is too long (300 characters at most).');
  }
  if (patch.thankYouNote !== undefined && patch.thankYouNote.length > 200) {
    throw validation('The thank-you note is too long (200 characters at most).');
  }
  if (patch.printerName !== undefined && patch.printerName.trim().length > 160) {
    throw validation('That printer name is too long.');
  }
  if (patch.labelPrinterName !== undefined && patch.labelPrinterName.trim().length > 160) {
    throw validation('That label printer name is too long.');
  }
  if (patch.expiryAlertDays !== undefined) {
    if (!Number.isInteger(patch.expiryAlertDays) || patch.expiryAlertDays < 1 || patch.expiryAlertDays > 730) {
      throw validation('Expiry alerts must be between 1 and 730 days.');
    }
  }
  if (patch.approvalTtlMinutes !== undefined) {
    if (!Number.isInteger(patch.approvalTtlMinutes) || patch.approvalTtlMinutes < 1 || patch.approvalTtlMinutes > 60) {
      throw validation('An approval must stay valid for 1 to 60 minutes.');
    }
  }
  if (patch.scalePrefix !== undefined) {
    if (!/^\d{1,3}$/.test(patch.scalePrefix.trim())) {
      throw validation('The scale barcode prefix must be one to three digits.');
    }
    if (patch.scalePrefix.trim() === '0' || patch.scalePrefix.trim() === '') {
      throw validation('A scale barcode prefix cannot be zero.');
    }
  }
  if (patch.scalePluDigits !== undefined && (!Number.isInteger(patch.scalePluDigits) || patch.scalePluDigits < 1 || patch.scalePluDigits > 8)) {
    throw validation('The PLU part of a scale barcode must be 1 to 8 digits.');
  }
  if (patch.scaleWeightDigits !== undefined && (!Number.isInteger(patch.scaleWeightDigits) || patch.scaleWeightDigits < 1 || patch.scaleWeightDigits > 8)) {
    throw validation('The weight part of a scale barcode must be 1 to 8 digits.');
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

/** The store's own name must exist before any document can be printed. */
export function requireStoreName(db: Database): string {
  const { storeName } = getAllSettings(db);
  if (!storeName || !storeName.trim()) {
    throw validation('This store has no name yet. An administrator must set it in Settings before printing.');
  }
  return storeName;
}

/** Enabled payment methods, in the order the till shows them. */
export function enabledPaymentMethods(db: Database): {
  method: 'CASH' | 'TRANSFER' | 'POS' | 'CREDIT';
  label: string;
  enabled: boolean;
}[] {
  const s = getAllSettings(db);
  return [
    { method: 'CASH', label: 'Cash', enabled: s.paymentCash },
    { method: 'TRANSFER', label: 'Transfer', enabled: s.paymentTransfer },
    { method: 'POS', label: 'Card / POS', enabled: s.paymentPos },
    { method: 'CREDIT', label: 'Credit', enabled: s.paymentCredit }
  ];
}

/** VAT in basis points (750 = 7.50%), or 0 when VAT is switched off. */
export function vatBasisPoints(settings: SettingsPayload): number {
  return settings.vatEnabled ? Math.round(settings.vatRate * 100) : 0;
}

/**
 * A supermarket scale prints an EAN-13 weight barcode: a prefix digit, the PLU,
 * the weight in grams and a check digit. The shop decides the digit counts, so
 * the layout lives in Settings rather than in the till.
 */
export interface ScaleLayout {
  prefix: string;
  pluDigits: number;
  weightDigits: number;
}

export function scaleLayout(db: Database): ScaleLayout | null {
  const s = getAllSettings(db);
  if (!s.scalePrefix.trim()) return null;
  return { prefix: s.scalePrefix.trim(), pluDigits: s.scalePluDigits, weightDigits: s.scaleWeightDigits };
}

/**
 * Reads a scale barcode into its PLU and weight. Returns null when the code is
 * not a scale barcode for this shop (wrong length or prefix, non-digits, zero
 * weight), so an ordinary barcode is never mistaken for one.
 */
export function parseScaleBarcode(
  code: string,
  layout: ScaleLayout | null
): { plu: string; weightGrams: number } | null {
  if (!layout) return null;
  const text = (code ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  if (!text.startsWith(layout.prefix)) return null;
  const expected = layout.prefix.length + layout.pluDigits + layout.weightDigits;
  // Some scales append a check digit; accept exactly the payload or one more.
  if (text.length !== expected && text.length !== expected + 1) return null;
  const plu = text.slice(layout.prefix.length, layout.prefix.length + layout.pluDigits);
  const weightText = text.slice(layout.prefix.length + layout.pluDigits, expected);
  const weightGrams = Number(weightText);
  if (!Number.isInteger(weightGrams) || weightGrams <= 0) return null;
  return { plu, weightGrams };
}
