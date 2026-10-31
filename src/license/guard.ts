/**
 * Licence guard — the piece that decides whether the app may be used right now.
 *
 * Everything here runs in the Electron MAIN process (and in the same module map
 * the browser harness calls), never in the renderer. It owns four jobs:
 *
 *   1. period maths   — local business dates, end date exclusive
 *   2. integrity      — HMAC over the stored period, keyed from a per-install
 *                       secret plus a machine fingerprint
 *   3. clock policing — a signed last-seen stamp; moving the clock backwards
 *                       locks the app until the vendor signs in again
 *   4. attempt delays — 30s, 1m, 5m, 15m … after five wrong passwords
 *
 * Nothing here touches business tables. Locking or expiring never deletes,
 * moves or encrypts data.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { arch, cpus, hostname, platform } from 'node:os';
import type { Database } from '../db';
import { nowIso } from '../db';
import type {
  Edition,
  LicenseHistoryEntry,
  LicenseLockReason,
  LicenseState,
  LicenseStatus
} from '../shared/types';
import { featuresForEdition, productNameForEdition } from '../shared/editions';
import { AppError } from '../shared/errors';
import { audit } from '../services/audit';
import { daysBetween, isBusinessDate, localDate, periodEndInstant } from '../shared/license-dates';

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

export {
  DAY_MS,
  localDate,
  isBusinessDate,
  parseBusinessDate,
  addDays,
  addYears,
  daysBetween,
  periodEndInstant
} from '../shared/license-dates';

/** Days before the end date that raise the admin banner. */
export const WARNING_THRESHOLDS = [30, 14, 7, 1] as const;
/** Inside this window the app warns that the licence is about to end. */
export const ENDING_SOON_MS = 10 * 60_000;
/** Allowance for NTP corrections before a "clock rollback" is declared. */
export const CLOCK_TOLERANCE_MS = 2 * 60_000;

export interface PeriodCheck {
  startsOn: string;
  endsOn: string;
  today: string;
  /** Days left until the end date (0 on the last day). */
  daysRemaining: number;
  expired: boolean;
  notStarted: boolean;
}

export function checkPeriod(startsOn: string, endsOn: string, now: Date): PeriodCheck {
  const today = localDate(now);
  return {
    startsOn,
    endsOn,
    today,
    daysRemaining: daysBetween(today, endsOn),
    expired: today >= endsOn,
    notStarted: today < startsOn
  };
}

export interface PeriodInput extends Record<string, unknown> {
  startsOn?: unknown;
  endsOn?: unknown;
}

export interface ValidatedPeriod {
  startsOn: string;
  endsOn: string;
}

/**
 * Validates a period entered on the activation / renewal screen.
 *
 * Rules: both dates must be real calendar dates, the end date must be after the
 * start date, the start cannot be in the future (that would lock the app the
 * moment it was saved) and the end must still be ahead — an end date of today
 * is already outside the exclusive range.
 */
export function validatePeriod(input: PeriodInput, now: Date = new Date()): ValidatedPeriod {
  const startsOn = typeof input.startsOn === 'string' ? input.startsOn.trim() : '';
  const endsOn = typeof input.endsOn === 'string' ? input.endsOn.trim() : '';
  if (!isBusinessDate(startsOn)) throw validationError('Choose a valid start date.');
  if (!isBusinessDate(endsOn)) throw validationError('Choose a valid end date.');
  if (endsOn <= startsOn) throw validationError('The end date must be after the start date.');
  const today = localDate(now);
  if (startsOn > today) {
    throw validationError('The start date cannot be in the future — the app would lock immediately.');
  }
  if (endsOn <= today) {
    throw validationError('The end date must be in the future.');
  }
  return { startsOn, endsOn };
}

function validationError(message: string): AppError {
  return new AppError('VALIDATION', message);
}

/* ------------------------------------------------------------------ */
/* Integrity                                                           */
/* ------------------------------------------------------------------ */

interface GuardSecretRow {
  secret: string;
}

/**
 * Machine fingerprint. Combined with the per-install secret this means a
 * `license_state` row copied from another computer (or edited in place) will
 * not verify. Documented limit: a determined attacker who reverse-engineers
 * the binary can recompute any HMAC — see docs/DECISIONS.md.
 */
export function machineFingerprint(): string {
  const cpu = cpus()[0]?.model ?? 'unknown-cpu';
  return createHash('sha256')
    .update([hostname(), platform(), arch(), cpu].join('|'))
    .digest('hex');
}

function guardSecretHex(db: Database): string {
  const row = db.handle.prepare('SELECT secret FROM license_guard WHERE id = 1').get() as
    | GuardSecretRow
    | undefined;
  if (row?.secret) return row.secret;
  const secret = randomBytes(32).toString('hex');
  db.handle
    .prepare('INSERT INTO license_guard (id, secret, created_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING')
    .run(secret, nowIso());
  const stored = db.handle.prepare('SELECT secret FROM license_guard WHERE id = 1').get() as GuardSecretRow;
  return stored.secret;
}

function hmacKey(db: Database): Buffer {
  const ikm = Buffer.from(`${guardSecretHex(db)}:${machineFingerprint()}`, 'utf8');
  const salt = Buffer.from('infoflex.license.v1', 'utf8');
  const info = Buffer.from('license-period-hmac', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

function hmacHex(db: Database, value: string): string {
  return createHmac('sha256', hmacKey(db)).update(value, 'utf8').digest('hex');
}

export interface LicenseRecord {
  licenseId: string;
  edition: Edition;
  customerName: string;
  startsOn: string;
  endsOn: string;
  issuedAt: string;
}

/** Canonical bytes covered by the licence HMAC. */
export function periodCanonical(record: LicenseRecord): string {
  return [
    'ifx-license-v1',
    record.licenseId,
    record.edition,
    record.startsOn,
    record.endsOn,
    record.customerName ?? '',
    record.issuedAt
  ].join('|');
}

export function signPeriod(db: Database, record: LicenseRecord): string {
  return hmacHex(db, periodCanonical(record));
}

export function verifyPeriodSignature(db: Database, record: LicenseRecord, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(signPeriod(db, record), 'utf8');
  const actual = Buffer.from(signature, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Last-seen stamp is bound to the licence id so it cannot be replayed across records. */
export function signLastSeen(db: Database, licenseId: string, iso: string): string {
  return hmacHex(db, `last-seen|${licenseId}|${iso}`);
}

/* ------------------------------------------------------------------ */
/* Attempt throttle                                                    */
/* ------------------------------------------------------------------ */

/** 30s, 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, then once a day. */
export const DELAY_LADDER_SECONDS = [30, 60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400];
export const FREE_ATTEMPTS = 5;

interface AttemptRow {
  id: number;
  created_at: string;
}

export interface AttemptState {
  failures: number;
  /** Seconds the caller still has to wait (0 = go ahead). */
  waitSeconds: number;
  /** Delay applied to the next wrong attempt, for messaging. */
  nextDelaySeconds: number;
}

function recentFailures(db: Database): AttemptRow[] {
  const lastOk = db.handle
    .prepare("SELECT MAX(id) AS id FROM license_attempts WHERE outcome = 'OK'")
    .get() as { id: number | null };
  return db.handle
    .prepare("SELECT id, created_at FROM license_attempts WHERE outcome = 'WRONG' AND id > ? ORDER BY id")
    .all(lastOk.id ?? 0) as AttemptRow[];
}

export function delayForFailures(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  const index = Math.min(failures - FREE_ATTEMPTS, DELAY_LADDER_SECONDS.length - 1);
  return DELAY_LADDER_SECONDS[index];
}

export function attemptState(db: Database, now: Date): AttemptState {
  const failures = recentFailures(db);
  if (failures.length < FREE_ATTEMPTS) {
    return { failures: failures.length, waitSeconds: 0, nextDelaySeconds: 0 };
  }
  const delay = delayForFailures(failures.length);
  const last = failures[failures.length - 1];
  const unlockAt = Date.parse(last.created_at) + delay * 1000;
  return {
    failures: failures.length,
    waitSeconds: Math.max(0, Math.ceil((unlockAt - now.getTime()) / 1000)),
    nextDelaySeconds: delay
  };
}

export function recordAttempt(
  db: Database,
  outcome: 'OK' | 'WRONG',
  failuresAfter: number,
  delaySeconds: number,
  now: Date = new Date()
): void {
  db.handle
    .prepare(
      'INSERT INTO license_attempts (created_at, outcome, failures_after, delay_seconds, source) VALUES (?, ?, ?, ?, ?)'
    )
    .run(now.toISOString(), outcome, failuresAfter, delaySeconds, 'vendor');
  // Keep the throttle table small; the audit log keeps the full history.
  db.handle
    .prepare('DELETE FROM license_attempts WHERE id <= (SELECT MAX(id) - 500 FROM license_attempts)')
    .run();
}

/* ------------------------------------------------------------------ */
/* Rows and status                                                     */
/* ------------------------------------------------------------------ */

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
  starts_on: string | null;
  ends_on: string | null;
  hmac: string | null;
  period_hmac: string | null;
  signed_at: string | null;
  renewed_at: string | null;
  last_seen_at: string | null;
  last_seen_hmac: string | null;
  lock_reason: string | null;
  locked_at: string | null;
  integrity_algo: string;
}

export function readLicenseRow(db: Database): LicenseRow | undefined {
  return db.handle.prepare('SELECT * FROM license_state WHERE id = 1').get() as LicenseRow | undefined;
}

export function recordFromRow(row: LicenseRow): LicenseRecord {
  return {
    licenseId: row.license_id,
    edition: row.edition,
    customerName: row.customer_name ?? '',
    startsOn: row.starts_on ?? localDate(new Date(row.issued_at)),
    endsOn: row.ends_on ?? localDate(new Date(row.expires_at)),
    issuedAt: row.issued_at
  };
}

export function warningFor(daysRemaining: number): LicenseStatus['warning'] {
  if (daysRemaining > 30 || daysRemaining < 0) return null;
  const ascending = [1, 7, 14, 30] as const;
  const level = ascending.find((threshold) => daysRemaining <= threshold) ?? 30;
  return { level: level as 30 | 14 | 7 | 1, daysRemaining };
}

function emptyStatus(now: Date): LicenseStatus {
  return {
    state: 'NONE',
    edition: null,
    customerName: null,
    issuedAt: null,
    expiresAt: null,
    startsOn: null,
    endsOn: null,
    daysRemaining: null,
    features: null,
    productName: productNameForEdition(null),
    usable: false,
    lockReason: 'NONE',
    endingSoon: false,
    warning: null,
    serverTime: now.toISOString(),
    message: 'Activate Infoflex with the vendor master password to get started.'
  };
}

function lockMessage(reason: LicenseLockReason): string {
  switch (reason) {
    case 'EXPIRED':
      return 'License Expired — Software Update Required.';
    case 'NOT_STARTED':
      return 'This licence period has not started yet.';
    case 'TAMPERED':
      return 'The licence file has been changed outside the app. Enter the update password to restore it.';
    case 'CLOCK_ROLLBACK':
      return 'The system clock has moved backwards. Enter the update password to continue.';
    default:
      return 'Activate Infoflex with the vendor master password to get started.';
  }
}

function statusFor(
  row: LicenseRow,
  state: LicenseState,
  now: Date,
  message?: string
): LicenseStatus {
  const record = recordFromRow(row);
  const check = checkPeriod(record.startsOn, record.endsOn, now);
  const usable = state === 'VALID' || state === 'EXPIRING';
  const endInstant = periodEndInstant(record.endsOn);
  const lockReason: LicenseLockReason | null = usable
    ? null
    : state === 'EXPIRED'
      ? 'EXPIRED'
      : state === 'NOT_STARTED'
        ? 'NOT_STARTED'
        : state === 'TAMPERED'
          ? 'TAMPERED'
          : state === 'CLOCK_ROLLBACK'
            ? 'CLOCK_ROLLBACK'
            : null;
  return {
    state,
    edition: row.edition,
    customerName: row.customer_name || null,
    issuedAt: row.issued_at,
    expiresAt: endInstant.toISOString(),
    startsOn: record.startsOn,
    endsOn: record.endsOn,
    daysRemaining: Math.max(0, check.daysRemaining),
    features: featuresForEdition(row.edition),
    productName: productNameForEdition(row.edition),
    usable,
    lockReason,
    endingSoon: usable && endInstant.getTime() - now.getTime() <= ENDING_SOON_MS,
    warning: usable ? warningFor(check.daysRemaining) : null,
    serverTime: now.toISOString(),
    message: message ?? (usable ? undefined : lockMessage(lockReason ?? 'NONE'))
  };
}

/** Pure status calculation: no writes, no side effects. */
export function computeLicenseStatus(db: Database, now: Date = new Date()): LicenseStatus {
  const row = readLicenseRow(db);
  if (!row) return emptyStatus(now);

  const record = recordFromRow(row);
  if (!verifyPeriodSignature(db, record, row.period_hmac ?? row.hmac)) {
    return statusFor(row, 'TAMPERED', now, lockMessage('TAMPERED'));
  }
  if (row.lock_reason === 'CLOCK_ROLLBACK') {
    return statusFor(row, 'CLOCK_ROLLBACK', now, lockMessage('CLOCK_ROLLBACK'));
  }
  const check = checkPeriod(record.startsOn, record.endsOn, now);
  if (check.notStarted) return statusFor(row, 'NOT_STARTED', now, lockMessage('NOT_STARTED'));
  if (check.expired) return statusFor(row, 'EXPIRED', now, lockMessage('EXPIRED'));
  const state: LicenseState = check.daysRemaining <= 30 ? 'EXPIRING' : 'VALID';
  return statusFor(row, state, now);
}

export interface GuardEvaluation {
  status: LicenseStatus;
  /** True when the guard itself changed something worth reporting. */
  changed: boolean;
}

/**
 * The runtime guard: detects a backwards clock, persists the lock, and keeps
 * the signed last-seen stamp current. Called on every IPC call and from the
 * main-process interval (every few minutes / at midnight).
 */
export function evaluateLicense(db: Database, now: Date = new Date()): GuardEvaluation {
  const row = readLicenseRow(db);
  if (!row) return { status: emptyStatus(now), changed: false };

  const record = recordFromRow(row);
  const validSignature = verifyPeriodSignature(db, record, row.period_hmac ?? row.hmac);

  let changed = false;
  if (validSignature && row.last_seen_at) {
    const lastSeen = Date.parse(row.last_seen_at);
    if (Number.isFinite(lastSeen) && now.getTime() < lastSeen - CLOCK_TOLERANCE_MS) {
      if (row.lock_reason !== 'CLOCK_ROLLBACK') {
        db.handle
          .prepare("UPDATE license_state SET lock_reason = 'CLOCK_ROLLBACK', locked_at = ? WHERE id = 1")
          .run(nowIso());
        audit(db, {
          action: 'license.clock.rollback',
          entity: 'license',
          entityId: record.licenseId,
          username: 'system',
          severity: 'SECURITY',
          details: { lastSeenAt: row.last_seen_at, detectedAt: nowIso() }
        });
      }
      return { status: computeLicenseStatus(db, now), changed: true };
    }
  }

  const status = computeLicenseStatus(db, now);
  if (status.usable) {
    const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (!row.last_seen_at || now.getTime() - lastSeen > 60_000) {
      const iso = now.toISOString();
      db.handle
        .prepare('UPDATE license_state SET last_seen_at = ?, last_seen_hmac = ? WHERE id = 1')
        .run(iso, signLastSeen(db, record.licenseId, iso));
      changed = true;
    }
  }
  return { status, changed };
}

/** Convenience for code paths that only need the status but must be guarded. */
export function requireUsableLicense(db: Database, now: Date = new Date()): LicenseStatus {
  const { status } = evaluateLicense(db, now);
  if (!status.usable) {
    const code =
      status.state === 'NONE' || status.state === 'TAMPERED' ? 'LICENSE_REQUIRED' : 'LICENSE_EXPIRED';
    throw new AppError(code, status.message ?? 'A valid licence is required to continue.', {
      state: status.state,
      lockReason: status.lockReason
    });
  }
  return status;
}

/* ------------------------------------------------------------------ */
/* History                                                             */
/* ------------------------------------------------------------------ */

export function writeHistory(
  db: Database,
  record: LicenseRecord,
  action: LicenseHistoryEntry['action'],
  createdBy: string,
  signature: string,
  now: Date = new Date()
): void {
  db.handle
    .prepare(
      `INSERT INTO license_history (license_id, edition, customer_name, starts_on, ends_on, action, period_hmac, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      record.licenseId,
      record.edition,
      record.customerName,
      record.startsOn,
      record.endsOn,
      action,
      signature,
      now.toISOString(),
      createdBy
    );
}

export function readHistory(db: Database, limit = 50): LicenseHistoryEntry[] {
  const rows = db.handle
    .prepare('SELECT * FROM license_history ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{
    id: number;
    license_id: string;
    edition: Edition;
    customer_name: string;
    starts_on: string;
    ends_on: string;
    action: LicenseHistoryEntry['action'];
    created_at: string;
    created_by: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    licenseId: row.license_id,
    edition: row.edition,
    customerName: row.customer_name,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    action: row.action,
    createdAt: row.created_at,
    createdBy: row.created_by
  }));
}

/** True when the exact period was already used (renewals must move forward). */
export function periodAlreadyUsed(db: Database, startsOn: string, endsOn: string): boolean {
  const row = db.handle
    .prepare('SELECT COUNT(*) AS n FROM license_history WHERE starts_on = ? AND ends_on = ?')
    .get(startsOn, endsOn) as { n: number };
  return row.n > 0;
}

/**
 * Backfills the period dates and HMAC for a licence row created before
 * migration v4. Only rows with no signature are touched, so a tampered row is
 * never blessed.
 */
export function backfillLegacyLicense(db: Database): void {
  const row = readLicenseRow(db);
  if (!row || (row.period_hmac && row.hmac)) return;
  const record = recordFromRow(row);
  const signature = signPeriod(db, record);
  db.handle
    .prepare(
      `UPDATE license_state
          SET starts_on = ?, ends_on = ?, period_hmac = ?, hmac = ?, signed_at = COALESCE(signed_at, ?),
              last_seen_at = COALESCE(last_seen_at, ?), integrity_algo = 'hmac-sha256'
        WHERE id = 1`
    )
    .run(record.startsOn, record.endsOn, signature, signature, nowIso(), nowIso());
  writeHistory(db, record, 'ACTIVATE', row.activated_by ?? 'vendor', signature);
}
