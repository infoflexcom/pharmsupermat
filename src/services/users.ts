import type { Database } from '../db';
import { nowIso } from '../db';
import type { Edition, Role, UserAccount } from '../shared/types';
import { AppError, conflict, notFound, validation } from '../shared/errors';
import { audit } from './audit';
import { availableRoles } from '../shared/editions';
import {
  countAdmins,
  findUserById,
  hashPassword,
  passwordProblem,
  toUserAccount,
  type UserRow
} from './auth';
import type { Actor } from './stock';

export function listUsers(db: Database): UserAccount[] {
  const rows = db.handle.prepare('SELECT * FROM users ORDER BY role, full_name').all() as UserRow[];
  return rows.map(toUserAccount);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkEmail(email: string | null | undefined): string | null {
  const value = email?.trim() ?? '';
  if (!value) return null;
  if (!EMAIL.test(value)) throw validation('That email address looks invalid.');
  return value;
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  role: Role;
  password: string;
  email?: string | null;
}

export function createUser(
  db: Database,
  input: CreateUserInput,
  actor: Actor,
  edition: Edition
): UserAccount {
  if (!input.username || !/^[a-zA-Z0-9._-]{3,32}$/.test(input.username.trim())) {
    throw validation('Username must be 3-32 characters (letters, numbers, dot, dash, underscore).');
  }
  if (!input.fullName || !input.fullName.trim()) throw validation('Full name is required.');
  const problem = passwordProblem(input.password);
  if (problem) throw validation(problem);
  if (!availableRoles(edition).includes(input.role)) {
    throw new AppError(
      'EDITION_RESTRICTED',
      `${input.role} accounts are not available on the ${edition.toLowerCase()} edition.`
    );
  }
  const email = checkEmail(input.email);
  return db.transaction(() => {
    const existing = db.handle
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(input.username.trim()) as { id: number } | undefined;
    if (existing) throw conflict('That username is already taken.');
    const now = nowIso();
    const result = db.handle
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, password_algo, active, must_change_password, email, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'bcrypt', 1, 1, ?, ?, ?)`
      )
      .run(
        input.username.trim(),
        input.fullName.trim(),
        input.role,
        hashPassword(input.password),
        email,
        now,
        now
      );
    const id = Number(result.lastInsertRowid);
    audit(db, {
      action: 'user.create',
      entity: 'user',
      entityId: id,
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: { username: input.username.trim(), role: input.role }
    });
    return toUserAccount(findUserById(db, id)!);
  });
}

export function updateUser(
  db: Database,
  input: { id: number; fullName?: string; role?: Role; active?: boolean; email?: string | null },
  actor: Actor,
  edition: Edition
): UserAccount {
  const row = findUserById(db, input.id);
  if (!row) throw notFound('User');
  const nextRole = input.role ?? row.role;
  if (input.role && !availableRoles(edition).includes(nextRole)) {
    throw new AppError(
      'EDITION_RESTRICTED',
      `${nextRole} accounts are not available on the ${edition.toLowerCase()} edition.`
    );
  }
  const nextActive = input.active ?? !!row.active;
  if (row.role === 'ADMIN' && (!nextActive || nextRole !== 'ADMIN') && countAdmins(db) <= 1) {
    throw conflict('You cannot remove or demote the last active administrator.');
  }
  const email = input.email === undefined ? row.email : checkEmail(input.email);
  return db.transaction(() => {
    db.handle
      .prepare(
        `UPDATE users SET full_name = ?, role = ?, active = ?, email = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(
        input.fullName?.trim() || row.full_name,
        nextRole,
        nextActive ? 1 : 0,
        email,
        nowIso(),
        input.id
      );
    audit(db, {
      action: 'user.update',
      entity: 'user',
      entityId: input.id,
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: {
        username: row.username,
        role: { from: row.role, to: nextRole },
        active: { from: !!row.active, to: nextActive }
      }
    });
    return toUserAccount(findUserById(db, input.id)!);
  });
}

export function resetUserPassword(
  db: Database,
  input: { id: number; newPassword: string },
  actor: Actor
): void {
  const row = findUserById(db, input.id);
  if (!row) throw notFound('User');
  const problem = passwordProblem(input.newPassword);
  if (problem) throw validation(problem);
  db.transaction(() => {
    db.handle
      .prepare(
        `UPDATE users SET password_hash = ?, password_algo = 'bcrypt', must_change_password = 1,
           failed_attempts = 0, locked_until = NULL, locked_reason = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(hashPassword(input.newPassword), nowIso(), input.id);
    audit(db, {
      action: 'user.password.reset',
      entity: 'user',
      entityId: input.id,
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: { username: row.username }
    });
  });
}

/** Bootstraps the very first administrator during first-run setup. */
export function createFirstAdmin(
  db: Database,
  input: { username: string; fullName: string; password: string; email?: string | null }
): UserAccount {
  const adminCount = countAdmins(db, false);
  if (adminCount > 0) throw new AppError('CONFLICT', 'An administrator already exists.');
  if (!input.username || !/^[a-zA-Z0-9._-]{3,32}$/.test(input.username.trim())) {
    throw validation('Username must be 3-32 characters (letters, numbers, dot, dash, underscore).');
  }
  if (!input.fullName?.trim()) throw validation('Full name is required.');
  const problem = passwordProblem(input.password);
  if (problem) throw validation(problem);
  const email = checkEmail(input.email);
  return db.transaction(() => {
    const now = nowIso();
    const result = db.handle
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, password_algo, active, must_change_password, email, created_at, updated_at)
         VALUES (?, ?, 'ADMIN', ?, 'bcrypt', 1, 0, ?, ?, ?)`
      )
      .run(input.username.trim(), input.fullName.trim(), hashPassword(input.password), email, now, now);
    const id = Number(result.lastInsertRowid);
    audit(db, {
      action: 'user.bootstrap',
      entity: 'user',
      entityId: id,
      username: input.username.trim(),
      severity: 'SECURITY',
      details: { username: input.username.trim() }
    });
    return toUserAccount(findUserById(db, id)!);
  });
}

export { unlockUser } from './auth';
