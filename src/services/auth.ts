import { scryptSync, timingSafeEqual } from 'node:crypto';
import { compareSync, genSaltSync, hashSync } from 'bcryptjs';
import type { Database } from '../db';
import { nowIso } from '../db';
import type { Role, UserAccount } from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { audit } from './audit';

/**
 * bcrypt cost. 10 rounds is the usual desktop trade-off (~80 ms per hash on a
 * 2020s laptop) and the cost is stored inside each hash, so raising it later
 * only affects new passwords. Overridable for slow CI machines.
 */
const BCRYPT_ROUNDS = clampRounds(Number(process.env.INFOFLEX_BCRYPT_ROUNDS ?? 10));

function clampRounds(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.min(Math.max(Math.round(value), 8), 14);
}

/** Five consecutive failures lock the account until an administrator unlocks it. */
export const MAX_FAILED_ATTEMPTS = 5;

/** Sentinel stored in users.locked_until for an admin-only unlock. */
export const LOCKED_UNTIL_SENTINEL = '9999-12-31T23:59:59.999Z';

export function hashPassword(password: string): string {
  return hashSync(password, genSaltSync(BCRYPT_ROUNDS));
}

/**
 * Verifies bcrypt hashes and the legacy scrypt format (`scrypt$N$r$p$salt$hash`)
 * written by earlier builds and by the vendor-key tooling.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  try {
    if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
      return compareSync(password, stored);
    }
    const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: 64 * 1024 * 1024
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** True when a verified password should be re-hashed with the current scheme/cost. */
export function passwordNeedsRehash(stored: string): boolean {
  if (!stored.startsWith('$2')) return true;
  const cost = Number(stored.split('$')[2]);
  return !Number.isFinite(cost) || cost < BCRYPT_ROUNDS;
}

export function passwordProblem(password: string): string | null {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  if (/^\s|\s$/.test(password)) return 'Password cannot start or end with a space.';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must include at least one letter and one number.';
  }
  return null;
}

/** 0-4 strength score used by the setup and user screens. */
export function passwordStrength(password: string): { score: number; label: string } {
  let score = 0;
  if (password.length >= 8) score += 1;
  if (password.length >= 12) score += 1;
  if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
  if (/[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;
  const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
  return { score: Math.min(score, 4), label: labels[Math.min(score, 4)] };
}

export interface UserRow {
  id: number;
  username: string;
  full_name: string;
  role: Role;
  password_hash: string;
  active: number;
  must_change_password: number;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  failed_attempts: number;
  locked_until: string | null;
  locked_reason: string | null;
  password_algo: string;
  email: string | null;
}

export function isLocked(row: { locked_until: string | null }): boolean {
  return !!row.locked_until && row.locked_until > new Date().toISOString();
}

export function toUserAccount(row: UserRow): UserAccount {
  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    role: row.role,
    active: !!row.active,
    mustChangePassword: !!row.must_change_password,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
    email: row.email,
    failedAttempts: row.failed_attempts,
    lockedUntil: row.locked_until,
    isLocked: isLocked(row)
  };
}

export function findUserByUsername(db: Database, username: string): UserRow | undefined {
  return db.handle
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username.trim()) as UserRow | undefined;
}

export function findUserById(db: Database, id: number): UserRow | undefined {
  return db.handle.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function countAdmins(db: Database, onlyActive = true): number {
  const row = db.handle
    .prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'ADMIN'${onlyActive ? ' AND active = 1' : ''}`
    )
    .get() as { n: number };
  return row.n;
}

export interface AuthenticatedUser {
  user: UserRow;
  account: UserAccount;
}

function recordFailedAttempt(db: Database, row: UserRow): { locked: boolean; attempts: number } {
  const attempts = row.failed_attempts + 1;
  const locked = attempts >= MAX_FAILED_ATTEMPTS;
  db.handle
    .prepare(
      `UPDATE users
          SET failed_attempts = ?, locked_until = ?, locked_reason = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(attempts, locked ? LOCKED_UNTIL_SENTINEL : null, locked ? 'failed_sign_ins' : null, nowIso(), row.id);

  if (locked) {
    audit(db, {
      action: 'auth.account.locked',
      entity: 'user',
      entityId: row.id,
      username: row.username,
      severity: 'SECURITY',
      details: { attempts, reason: 'failed_sign_ins', unlock: 'administrator' }
    });
  } else {
    audit(db, {
      action: 'auth.login.failed',
      entity: 'user',
      entityId: row.id,
      username: row.username,
      severity: 'SECURITY',
      details: { attempts, attemptsRemaining: MAX_FAILED_ATTEMPTS - attempts }
    });
  }
  return { locked, attempts };
}

export function authenticate(db: Database, username: string, password: string): AuthenticatedUser {
  const typed = (username ?? '').trim();
  const row = typed ? findUserByUsername(db, typed) : undefined;

  if (row && isLocked(row)) {
    audit(db, {
      action: 'auth.login.blocked',
      entity: 'user',
      entityId: row.id,
      username: row.username,
      severity: 'SECURITY',
      details: { reason: 'account_locked' }
    });
    throw new AppError(
      'FORBIDDEN',
      'This account is locked after too many failed attempts. Ask an administrator to unlock it.',
      { locked: true }
    );
  }

  const ok = row ? verifyPassword(password ?? '', row.password_hash) : false;

  if (!row || !ok) {
    if (!row) {
      audit(db, {
        action: 'auth.login.failed',
        username: typed || null,
        severity: 'SECURITY',
        details: { reason: 'unknown_username' }
      });
      throw new AppError('UNAUTHENTICATED', 'Incorrect username or password.');
    }
    const { locked, attempts } = recordFailedAttempt(db, row);
    if (locked) {
      throw new AppError(
        'FORBIDDEN',
        'Too many failed attempts. This account is now locked — an administrator can unlock it.',
        { locked: true }
      );
    }
    throw new AppError(
      'UNAUTHENTICATED',
      `Incorrect username or password. ${MAX_FAILED_ATTEMPTS - attempts} attempt(s) left before the account locks.`,
      { attemptsRemaining: MAX_FAILED_ATTEMPTS - attempts }
    );
  }

  if (!row.active) {
    audit(db, {
      action: 'auth.login.failed',
      entity: 'user',
      entityId: row.id,
      username: row.username,
      severity: 'SECURITY',
      details: { reason: 'account_disabled' }
    });
    throw new AppError('FORBIDDEN', 'This account has been disabled.');
  }

  const rehash = passwordNeedsRehash(row.password_hash);
  db.transaction(() => {
    db.handle
      .prepare(
        `UPDATE users
            SET last_login_at = ?, failed_attempts = 0, locked_until = NULL, locked_reason = NULL,
                password_hash = ?, password_algo = 'bcrypt', updated_at = ?
          WHERE id = ?`
      )
      .run(
        nowIso(),
        rehash ? hashPassword(password) : row.password_hash,
        nowIso(),
        row.id
      );
    audit(db, {
      action: 'auth.login',
      entity: 'user',
      entityId: row.id,
      userId: row.id,
      username: row.username,
      details: { role: row.role }
    });
  });

  const fresh = findUserById(db, row.id)!;
  return { user: fresh, account: toUserAccount(fresh) };
}

export function changePassword(
  db: Database,
  userId: number,
  currentPassword: string | null,
  newPassword: string
): void {
  const row = findUserById(db, userId);
  if (!row) throw new AppError('NOT_FOUND', 'User was not found.');
  if (currentPassword !== null && !verifyPassword(currentPassword, row.password_hash)) {
    throw new AppError('VALIDATION', 'Your current password is not correct.');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw validation(problem);
  db.transaction(() => {
    db.handle
      .prepare(
        `UPDATE users
            SET password_hash = ?, password_algo = 'bcrypt', must_change_password = 0,
                failed_attempts = 0, locked_until = NULL, locked_reason = NULL, updated_at = ?
          WHERE id = ?`
      )
      .run(hashPassword(newPassword), nowIso(), userId);
    audit(db, {
      action: 'user.password.change',
      entity: 'user',
      entityId: userId,
      userId,
      username: row.username,
      severity: 'SECURITY',
      details: { username: row.username }
    });
  });
}

/** Administrator action: clears the lock and the failure counter. */
export function unlockUser(
  db: Database,
  userId: number,
  actor: { userId: number; username: string }
): UserRow {
  const row = findUserById(db, userId);
  if (!row) throw new AppError('NOT_FOUND', 'That user was not found.');
  db.transaction(() => {
    db.handle
      .prepare(
        `UPDATE users SET failed_attempts = 0, locked_until = NULL, locked_reason = NULL, updated_at = ?
          WHERE id = ?`
      )
      .run(nowIso(), userId);
    audit(db, {
      action: 'user.unlock',
      entity: 'user',
      entityId: userId,
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: { username: row.username }
    });
  });
  return findUserById(db, userId)!;
}
