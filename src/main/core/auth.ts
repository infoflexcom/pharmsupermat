import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Database } from './db';
import { nowIso } from './db';
import type { Role, UserAccount } from '../../shared/types';
import { AppError, validation } from './errors';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

/** Hash format: scrypt$N$r$p$saltBase64$hashBase64 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: SCRYPT.maxmem
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nRaw, rRaw, pRaw, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nRaw),
      r: Number(rRaw),
      p: Number(pRaw),
      maxmem: SCRYPT.maxmem
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password: string): string | null {
  if (!password || password.length < 6) return 'Password must be at least 6 characters.';
  if (password.length > 200) return 'Password is too long.';
  if (/^\s|\s$/.test(password)) return 'Password cannot start or end with a space.';
  return null;
}

interface UserRow {
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
    lastLoginAt: row.last_login_at
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

/**
 * Simple in-memory brute force throttle, keyed by database + username so that
 * separate installs (and tests) never interfere with each other.
 */
const loginAttempts = new Map<string, { count: number; blockedUntil: number }>();

function throttleKey(db: Database, username: string): string {
  return `${db.filename}|${username.trim().toLowerCase()}`;
}

export function resetLoginThrottle(db?: Database, username?: string): void {
  if (db && username) loginAttempts.delete(throttleKey(db, username));
  else if (db) {
    for (const key of loginAttempts.keys()) {
      if (key.startsWith(`${db.filename}|`)) loginAttempts.delete(key);
    }
  } else loginAttempts.clear();
}

export interface AuthenticatedUser {
  user: UserRow;
  account: UserAccount;
}

export function authenticate(
  db: Database,
  username: string,
  password: string
): AuthenticatedUser {
  const key = throttleKey(db, username);
  const attempt = loginAttempts.get(key);
  const now = Date.now();
  if (attempt && attempt.blockedUntil > now) {
    const seconds = Math.ceil((attempt.blockedUntil - now) / 1000);
    throw new AppError('FORBIDDEN', `Too many failed attempts. Try again in ${seconds} seconds.`);
  }

  const row = findUserByUsername(db, username);
  const ok = row ? verifyPassword(password, row.password_hash) : false;
  if (!row || !ok) {
    const next = { count: (attempt?.count ?? 0) + 1, blockedUntil: 0 };
    if (next.count >= 5) {
      next.blockedUntil = now + 60_000;
      next.count = 0;
    }
    loginAttempts.set(key, next);
    throw new AppError('UNAUTHENTICATED', 'Incorrect username or password.');
  }
  if (!row.active) throw new AppError('FORBIDDEN', 'This account has been disabled.');
  loginAttempts.delete(key);
  db.handle.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), row.id);
  return { user: row, account: toUserAccount(row) };
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
  db.handle
    .prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?'
    )
    .run(hashPassword(newPassword), nowIso(), userId);
}
