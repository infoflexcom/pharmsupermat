import { createDecipheriv, randomUUID, scryptSync, sign as cryptoSign } from 'node:crypto';
import vendorSecrets from './vendor-secrets.json';
import { VENDOR_PUBLIC_KEY_SPKI_BASE64 } from './vendor-public-key';
import { verifyPassword } from '../services/auth';
import { verifyLicenseCode, encodeLicenseCode, canonicalPayload, daysUntil } from './code';
import { featuresForEdition, isValidEdition, productNameForEdition } from '../shared/editions';
import type { Database } from '../db';
import { nowIso } from '../db';
import type { Edition, LicensePayload, LicenseState, LicenseStatus } from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { getAllSettings } from '../services/settings';

const WARNING_DAYS = 30;

interface VendorSecrets {
  algorithm: string;
  passwordHash: string;
  wrappedPrivateKey: {
    kdf: { name: string; N: number; r: number; p: number };
    salt: string;
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

const secrets = vendorSecrets as VendorSecrets;

/** Verifies the vendor master password against the stored scrypt hash. */
export function verifyVendorPassword(password: string): boolean {
  if (!password) return false;
  return verifyPassword(password, secrets.passwordHash);
}

export function assertVendorPassword(password: string): void {
  if (!verifyVendorPassword(password)) {
    throw new AppError('FORBIDDEN', 'The vendor master password is not correct.');
  }
}

/**
 * Unseals the vendor signing key. The key only exists in memory: it is sealed
 * with AES-256-GCM under a scrypt key derived from the master password, so the
 * password (never stored) is required for every signing operation.
 */
function unsealPrivateKey(password: string): string {
  const wrapped = secrets.wrappedPrivateKey;
  const key = scryptSync(password, Buffer.from(wrapped.salt, 'base64'), 32, {
    N: wrapped.kdf.N,
    r: wrapped.kdf.r,
    p: wrapped.kdf.p,
    maxmem: 128 * 1024 * 1024
  });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(wrapped.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
  try {
    const pem = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');
    return pem;
  } catch {
    throw new AppError('FORBIDDEN', 'The vendor master password is not correct.');
  }
}

/** Signs a licence payload with the vendor key (requires the master password). */
export function signLicensePayload(payload: LicensePayload, masterPassword: string): string {
  assertVendorPassword(masterPassword);
  const pem = unsealPrivateKey(masterPassword);
  const signature = cryptoSign(null, canonicalPayload(payload), pem);
  return encodeLicenseCode(payload, signature);
}

export function buildLicensePayload(input: {
  edition: Edition;
  customerName: string;
  expiresAt: string;
  note?: string;
  licenseId?: string;
}): LicensePayload {
  if (!isValidEdition(input.edition)) throw validation('Choose a valid edition.');
  if (!input.customerName.trim()) throw validation('Customer / store name is required on the licence.');
  const expires = new Date(input.expiresAt);
  if (Number.isNaN(expires.getTime())) throw validation('Licence expiry date is invalid.');
  if (expires.getTime() <= Date.now()) throw validation('Licence expiry must be in the future.');
  return {
    v: 1,
    licenseId: input.licenseId ?? randomUUID(),
    edition: input.edition,
    customerName: input.customerName.trim(),
    issuedAt: new Date().toISOString(),
    expiresAt: expires.toISOString(),
    note: input.note?.trim() || undefined
  };
}

export interface LicenseRow {
  id: number;
  edition: Edition;
  customer_name: string;
  license_id: string;
  activation_code: string;
  issued_at: string;
  expires_at: string;
  activated_at: string;
  activated_by: string | null;
  note: string | null;
}

export function readLicenseRow(db: Database): LicenseRow | undefined {
  return db.handle.prepare('SELECT * FROM license_state WHERE id = 1').get() as LicenseRow | undefined;
}

export function saveLicense(
  db: Database,
  payload: LicensePayload,
  code: string,
  activatedBy: string
): void {
  db.handle
    .prepare(
      `INSERT INTO license_state (id, edition, customer_name, license_id, activation_code, issued_at, expires_at, activated_at, activated_by, note)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         edition = excluded.edition,
         customer_name = excluded.customer_name,
         license_id = excluded.license_id,
         activation_code = excluded.activation_code,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at,
         activated_at = excluded.activated_at,
         activated_by = excluded.activated_by,
         note = excluded.note`
    )
    .run(
      payload.edition,
      payload.customerName,
      payload.licenseId,
      code,
      payload.issuedAt,
      payload.expiresAt,
      nowIso(),
      activatedBy,
      payload.note ?? null
    );
}

function statusFromPayload(
  payload: LicensePayload,
  now = new Date(),
  warningDays = WARNING_DAYS
): LicenseStatus {
  const remaining = daysUntil(payload.expiresAt, now);
  let state: LicenseState = 'VALID';
  if (Date.parse(payload.expiresAt) <= now.getTime()) state = 'EXPIRED';
  else if (remaining <= warningDays) state = 'EXPIRING';
  return {
    state,
    edition: payload.edition,
    customerName: payload.customerName,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    daysRemaining: remaining,
    features: featuresForEdition(payload.edition),
    productName: productNameForEdition(payload.edition),
    message:
      state === 'EXPIRED'
        ? 'Your licence has expired. Renew with the vendor master password to continue.'
        : undefined
  };
}

/** Reads the stored licence and re-verifies its signature on every call. */
export function getLicenseStatus(db: Database, now = new Date()): LicenseStatus {
  const row = readLicenseRow(db);
  if (!row) {
    return {
      state: 'NONE',
      edition: null,
      customerName: null,
      issuedAt: null,
      expiresAt: null,
      daysRemaining: null,
      features: null,
      productName: productNameForEdition(null),
      message: 'Activate Infoflex with the vendor master password to get started.'
    };
  }
  try {
    const payload = verifyLicenseCode(row.activation_code, VENDOR_PUBLIC_KEY_SPKI_BASE64);
    return statusFromPayload(payload, now, getAllSettings(db).licenseExpiryWarningDays);
  } catch (error) {
    return {
      state: 'INVALID',
      edition: null,
      customerName: null,
      issuedAt: null,
      expiresAt: null,
      daysRemaining: null,
      features: null,
      productName: productNameForEdition(null),
      message:
        error instanceof Error ? `Licence could not be verified: ${error.message}` : 'Licence invalid.'
    };
  }
}

export function requireValidLicense(db: Database): LicenseStatus {
  const status = getLicenseStatus(db);
  if (status.state === 'NONE' || status.state === 'INVALID') {
    throw new AppError('LICENSE_REQUIRED', status.message ?? 'Activate your Infoflex licence first.');
  }
  if (status.state === 'EXPIRED') {
    throw new AppError('LICENSE_EXPIRED', status.message ?? 'Your licence has expired.');
  }
  return status;
}

export interface ActivateOptions {
  masterPassword: string;
  /** An existing signed activation code, or omit to issue one in vendor mode. */
  activationCode?: string;
  edition?: Edition;
  customerName?: string;
  expiresAt?: string;
  note?: string;
  activatedBy: string;
}

/**
 * Activates or renews the licence. Two paths, both gated by the vendor master
 * password:
 *   1. paste a licence code signed by the vendor tool (recommended), or
 *   2. vendor mode: sign a fresh licence in place from the details supplied.
 */
export function activateLicense(db: Database, options: ActivateOptions): LicenseStatus {
  assertVendorPassword(options.masterPassword);

  let code = options.activationCode?.trim() || '';
  if (code) {
    try {
      verifyLicenseCode(code, VENDOR_PUBLIC_KEY_SPKI_BASE64);
    } catch (error) {
      throw validation(
        error instanceof Error ? error.message : 'That licence code could not be verified.'
      );
    }
  } else {
    if (!options.edition || !options.customerName || !options.expiresAt) {
      throw validation('Choose an edition, customer name and expiry date to issue a licence.');
    }
    const payload = buildLicensePayload({
      edition: options.edition,
      customerName: options.customerName,
      expiresAt: options.expiresAt,
      note: options.note
    });
    code = signLicensePayload(payload, options.masterPassword);
  }

  const payload = verifyLicenseCode(code, VENDOR_PUBLIC_KEY_SPKI_BASE64);
  if (Date.parse(payload.expiresAt) <= Date.now()) {
    throw validation('That licence has already expired. Issue a new one to renew.');
  }
  saveLicense(db, payload, code, options.activatedBy);
  return getLicenseStatus(db);
}
