import { createDecipheriv, randomUUID, scryptSync, sign as cryptoSign } from 'node:crypto';
import vendorSecrets from './vendor-secrets.json';
import { VENDOR_PUBLIC_KEY_SPKI_BASE64 } from './vendor-public-key';
import { verifyPassword } from '../services/auth';
import { verifyLicenseCode, encodeLicenseCode, canonicalPayload } from './code';
import {
  featuresForEdition,
  isValidEdition,
  productNameForEdition,
  UNLICENSED_PRODUCT_NAME
} from '../shared/editions';
import type { Database } from '../db';
import { nowIso } from '../db';
import type {
  Edition,
  LicenseHistoryEntry,
  LicensePayload,
  LicenseSetupInput,
  LicenseStatus,
  MasterPasswordResult
} from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { audit } from '../services/audit';
import {
  attemptState,
  computeLicenseStatus,
  delayForFailures,
  evaluateLicense,
  isBusinessDate,
  localDate,
  parseBusinessDate,
  periodAlreadyUsed,
  readLicenseRow,
  readHistory,
  recordAttempt,
  recordFromRow,
  requireUsableLicense,
  signPeriod,
  signLastSeen,
  validatePeriod,
  verifyPeriodSignature,
  writeHistory,
  type LicenseRecord
} from './guard';

export { readHistory as getLicenseHistory } from './guard';

export const WARNING_DAYS = 30;

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
  issuedAt?: string;
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
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: expires.toISOString(),
    note: input.note?.trim() || undefined
  };
}

/* ------------------------------------------------------------------ */
/* Master password attempts                                            */
/* ------------------------------------------------------------------ */

/**
 * Applies the 30s / 1m / 5m … ladder, verifies the password and records the
 * attempt. Only the outcome is stored; the typed value is never logged.
 */
export function checkMasterPassword(
  db: Database,
  password: string,
  now: Date = new Date(),
  action = 'license.master.verify'
): MasterPasswordResult {
  const state = attemptState(db, now);
  if (state.waitSeconds > 0) {
    audit(db, {
      action: `${action}.throttled`,
      entity: 'license',
      username: 'vendor',
      severity: 'SECURITY',
      details: { failures: state.failures, retryAfterSeconds: state.waitSeconds }
    });
    throw new AppError(
      'FORBIDDEN',
      `Too many wrong passwords. Try again in ${state.waitSeconds} second(s).`,
      { retryAfterSeconds: state.waitSeconds, failures: state.failures }
    );
  }

  const ok = verifyVendorPassword(password ?? '');
  if (ok) {
    recordAttempt(db, 'OK', 0, 0, now);
    audit(db, { action, entity: 'license', username: 'vendor', severity: 'SECURITY', details: { attempt: state.failures + 1 } });
    return { ok: true, failures: 0, retryAfterSeconds: 0 };
  }

  const failures = state.failures + 1;
  const nextDelay = delayForFailures(failures);
  recordAttempt(db, 'WRONG', failures, nextDelay, now);
  audit(db, {
    action: `${action}.failed`,
    entity: 'license',
    username: 'vendor',
    severity: 'SECURITY',
    details: { attempt: failures, delaySeconds: nextDelay }
  });
  throw new AppError('FORBIDDEN', 'The vendor master password is not correct.', {
    failures,
    retryAfterSeconds: nextDelay
  });
}

/* ------------------------------------------------------------------ */
/* Period mapping from legacy signed payloads                          */
/* ------------------------------------------------------------------ */

/**
 * Old licences carried an inclusive expiry timestamp. The phase-4 model uses an
 * exclusive end date, so a "23:59:59" expiry becomes the next day and anything
 * earlier stays on its own date.
 */
export function endDateFromExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) throw validation('Licence expiry date is invalid.');
  const endOfDay = date.getHours() >= 23 && date.getMinutes() >= 55;
  const day = localDate(date);
  if (!endOfDay) return day;
  return localDate(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1));
}

function recordFor(
  edition: Edition,
  startsOn: string,
  endsOn: string,
  customerName: string,
  issuedAt: string,
  licenseId: string
): LicenseRecord {
  return { licenseId, edition, customerName, startsOn, endsOn, issuedAt };
}

function persist(
  db: Database,
  record: LicenseRecord,
  options: {
    action: LicenseHistoryEntry['action'];
    activatedBy: string;
    activationCode?: string;
    note?: string | null;
  }
): string {
  const signature = signPeriod(db, record);
  const seenAt = nowIso();
  db.handle
    .prepare(
      `INSERT INTO license_state
         (id, edition, customer_name, license_id, activation_code, issued_at, expires_at,
          activated_at, activated_by, note, starts_on, ends_on, hmac, period_hmac, signed_at,
          renewed_at, last_seen_at, last_seen_hmac, lock_reason, locked_at, integrity_algo)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'hmac-sha256')
       ON CONFLICT(id) DO UPDATE SET
         edition = excluded.edition,
         customer_name = excluded.customer_name,
         license_id = excluded.license_id,
         activation_code = excluded.activation_code,
         issued_at = excluded.issued_at,
         expires_at = excluded.expires_at,
         activated_at = excluded.activated_at,
         activated_by = excluded.activated_by,
         note = excluded.note,
         starts_on = excluded.starts_on,
         ends_on = excluded.ends_on,
         hmac = excluded.hmac,
         period_hmac = excluded.period_hmac,
         signed_at = excluded.signed_at,
         renewed_at = excluded.renewed_at,
         last_seen_at = excluded.last_seen_at,
         last_seen_hmac = excluded.last_seen_hmac,
         lock_reason = NULL,
         locked_at = NULL,
         integrity_algo = excluded.integrity_algo`
    )
    .run(
      record.edition,
      record.customerName,
      record.licenseId,
      options.activationCode ?? '',
      record.issuedAt,
      parseBusinessDate(record.endsOn).toISOString(),
      seenAt,
      options.activatedBy,
      options.note ?? null,
      record.startsOn,
      record.endsOn,
      signature,
      signature,
      seenAt,
      seenAt,
      seenAt,
      signLastSeen(db, record.licenseId, seenAt)
    );
  writeHistory(db, record, options.action, options.activatedBy, signature);
  return signature;
}

/** Re-signs the current period and clears a clock-rollback lock. */
export function unlockLicense(
  db: Database,
  masterPassword: string,
  activatedBy: string,
  now: Date = new Date()
): LicenseStatus {
  checkMasterPassword(db, masterPassword, now, 'license.unlock');
  const row = readLicenseRow(db);
  if (!row) throw new AppError('LICENSE_REQUIRED', 'There is no licence on this installation yet.');

  const record = recordFromRow(row);
  if (!verifyPeriodSignature(db, record, row.period_hmac ?? row.hmac)) {
    throw new AppError(
      'LICENSE_LOCKED',
      'The licence file was changed outside the app. Enter a new licence period to restore it.',
      { reason: 'TAMPERED' }
    );
  }

  const seenAt = now.toISOString();
  db.handle
    .prepare(
      `UPDATE license_state
          SET lock_reason = NULL, locked_at = NULL, last_seen_at = ?, last_seen_hmac = ?, renewed_at = ?
        WHERE id = 1`
    )
    .run(seenAt, signLastSeen(db, record.licenseId, seenAt), seenAt);
  writeHistory(
    db,
    record,
    'UNLOCK',
    activatedBy,
    row.period_hmac ?? signPeriod(db, record)
  );
  audit(db, {
    action: 'license.unlock',
    entity: 'license',
    entityId: record.licenseId,
    username: activatedBy,
    severity: 'SECURITY',
    details: { startsOn: record.startsOn, endsOn: record.endsOn }
  });
  return computeLicenseStatus(db, now);
}

export interface ActivateOptions {
  masterPassword: string;
  /** Pre-signed vendor code (legacy path). */
  activationCode?: string;
  edition?: Edition;
  /** Business dates, `YYYY-MM-DD`; end date exclusive. */
  startsOn?: string;
  endsOn?: string;
  customerName?: string;
  /** Legacy inclusive expiry timestamp, mapped onto an exclusive end date. */
  expiresAt?: string;
  note?: string;
  activatedBy: string;
}

/**
 * Activates a fresh installation or renews an existing licence.
 *
 * Every path is gated by the master password (rate limited) and writes the
 * period plus its HMAC in one transaction. Renewals must move forward: a period
 * that has already been used, or an end date that is not in the future, is
 * refused. The store details are never touched here.
 */
export function activateLicense(
  db: Database,
  options: ActivateOptions,
  now: Date = new Date()
): LicenseStatus {
  const before = readLicenseRow(db);
  checkMasterPassword(db, options.masterPassword, now, before ? 'license.renew' : 'license.activate');

  let edition: Edition;
  let record: LicenseRecord;
  let activationCode = '';

  if (options.activationCode?.trim()) {
    const code = options.activationCode.trim();
    let payload: LicensePayload;
    try {
      payload = verifyLicenseCode(code, VENDOR_PUBLIC_KEY_SPKI_BASE64);
    } catch (error) {
      throw validation(error instanceof Error ? error.message : 'That licence code could not be verified.');
    }
    if (Date.parse(payload.expiresAt) <= now.getTime()) {
      throw validation('That licence has already expired. Issue a new one to renew.');
    }
    edition = payload.edition;
    record = recordFor(
      edition,
      localDate(new Date(payload.issuedAt)),
      endDateFromExpiry(payload.expiresAt),
      payload.customerName,
      payload.issuedAt,
      payload.licenseId
    );
    activationCode = code;
    options.customerName = payload.customerName;
    options.note = payload.note;
  } else {
    edition = (options.edition ?? before?.edition ?? '') as Edition;
    if (!isValidEdition(edition)) throw validation('Choose a valid edition.');

    let startsOn = options.startsOn;
    let endsOn = options.endsOn;
    if (!startsOn || !endsOn) {
      // Legacy callers send only an expiry timestamp.
      if (!options.expiresAt) throw validation('Choose the licence start and end dates.');
      startsOn = localDate(now);
      endsOn = endDateFromExpiry(options.expiresAt);
    }
    const period = validatePeriod({ startsOn, endsOn }, now);
    record = recordFor(
      edition,
      period.startsOn,
      period.endsOn,
      (options.customerName ?? before?.customer_name ?? '').trim(),
      now.toISOString(),
      before?.license_id && before.edition === edition ? before.license_id : randomUUID()
    );
  }

  // Renewals may not replay a period that has already been issued. The one
  // exception is re-signing the period that is already in the signed history
  // while it is still running (an edition change, or repairing a tampered row) —
  // an expired range can never be reused.
  const lastSigned = readHistory(db, 1)[0];
  const matchesSignedHistory =
    Boolean(lastSigned) &&
    lastSigned!.startsOn === record.startsOn &&
    lastSigned!.endsOn === record.endsOn;
  const historyStillRunning = matchesSignedHistory && localDate(now) < record.endsOn;
  if (periodAlreadyUsed(db, record.startsOn, record.endsOn) && !historyStillRunning) {
    throw validation('That licence period has already been used. Choose a new start or end date.');
  }

  const action: LicenseHistoryEntry['action'] = !before
    ? 'ACTIVATE'
    : before.edition !== record.edition
      ? 'EDITION_CHANGE'
      : 'RENEW';

  db.transaction(() => {
    persist(db, record, {
      action,
      activatedBy: options.activatedBy,
      activationCode,
      note: options.note ?? null
    });
    audit(db, {
      action: action === 'ACTIVATE' ? 'license.activate' : action === 'RENEW' ? 'license.renew' : 'license.edition.change',
      entity: 'license',
      entityId: record.licenseId,
      username: options.activatedBy,
      severity: 'SECURITY',
      details: {
        edition: record.edition,
        previousEdition: before?.edition ?? null,
        startsOn: record.startsOn,
        endsOn: record.endsOn,
        previousEndsOn: before?.ends_on ?? null,
        mode: activationCode ? 'activation-code' : 'vendor-setup'
      }
    });
    if (before && before.edition !== record.edition) {
      audit(db, {
        action: 'license.edition.change',
        entity: 'license',
        entityId: record.licenseId,
        username: options.activatedBy,
        severity: 'SECURITY',
        details: { from: before.edition, to: record.edition }
      });
    }
  });

  return computeLicenseStatus(db, now);
}

/** Legacy helper used by tests and the vendor tooling. */
export function saveLicense(
  db: Database,
  payload: LicensePayload,
  code: string,
  activatedBy: string
): void {
  const record = recordFor(
    payload.edition,
    localDate(new Date(payload.issuedAt)),
    endDateFromExpiry(payload.expiresAt),
    payload.customerName,
    payload.issuedAt,
    payload.licenseId
  );
  db.transaction(() => {
    persist(db, record, {
      action: 'ACTIVATE',
      activatedBy,
      activationCode: code,
      note: payload.note ?? null
    });
  });
}

/* ------------------------------------------------------------------ */
/* Reading the licence                                                 */
/* ------------------------------------------------------------------ */

/** Reads the stored licence, re-verifying its HMAC and the clock on every call. */
export function getLicenseStatus(db: Database, now: Date = new Date()): LicenseStatus {
  return evaluateLicense(db, now).status;
}

export function requireValidLicense(db: Database, now: Date = new Date()): LicenseStatus {
  return requireUsableLicense(db, now);
}

export interface LicenseSummary {
  status: LicenseStatus;
  history: LicenseHistoryEntry[];
  productName: string;
  features: ReturnType<typeof featuresForEdition> | null;
}

export function licenseSummary(db: Database, now: Date = new Date(), historyLimit = 25): LicenseSummary {
  const status = getLicenseStatus(db, now);
  return {
    status,
    history: readHistory(db, historyLimit),
    productName: status.productName || productNameForEdition(null) || UNLICENSED_PRODUCT_NAME,
    features: status.features ? featuresForEdition(status.edition as Edition) : null
  };
}

/** True when the stored licence record exists but its HMAC no longer matches. */
export function licenseIsTampered(db: Database): boolean {
  const row = readLicenseRow(db);
  if (!row) return false;
  return !verifyPeriodSignature(db, recordFromRow(row), row.period_hmac ?? row.hmac);
}

/** Exposed for the activation screen: is this a business date string? */
export { isBusinessDate };

export type { LicenseSetupInput };

/** Editable fields on the activation screen — kept in one place for the UI. */
export const LICENSE_EDITION_CHOICES: Array<{ value: Edition; label: string; product: string }> = [
  { value: 'PHARMACY', label: 'Pharmacy', product: productNameForEdition('PHARMACY') },
  { value: 'SUPERMARKET', label: 'Supermarket', product: productNameForEdition('SUPERMARKET') },
  { value: 'BOTH', label: 'Pharmacy & Supermarket', product: productNameForEdition('BOTH') }
];
