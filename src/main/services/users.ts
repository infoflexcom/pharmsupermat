import type { Database } from '../core/db';
import { nowIso } from '../core/db';
import type { Edition, Role, UserAccount } from '../../shared/types';
import { AppError, conflict, notFound, validation } from '../core/errors';
import { audit } from '../core/audit';
import { availableRoles } from '../../shared/editions';
import { countAdmins, hashPassword, passwordProblem, toUserAccount } from '../core/auth';
import type { Actor } from './stock';

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

export function listUsers(db: Database): UserAccount[] {
  const rows = db.handle.prepare('SELECT * FROM users ORDER BY role, full_name').all() as UserRow[];
  return rows.map(toUserAccount);
}

export interface CreateUserInput {
  username: string;
  fullName: string;
  role: Role;
  password: string;
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
  return db.transaction(() => {
    const existing = db.handle
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .get(input.username.trim()) as { id: number } | undefined;
    if (existing) throw conflict('That username is already taken.');
    const now = nowIso();
    const result = db.handle
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, active, must_change_password, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?)`
      )
      .run(
        input.username.trim(),
        input.fullName.trim(),
        input.role,
        hashPassword(input.password),
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
    const row = db.handle.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return toUserAccount(row);
  });
}

export function updateUser(
  db: Database,
  input: { id: number; fullName?: string; role?: Role; active?: boolean },
  actor: Actor,
  edition: Edition
): UserAccount {
  const row = db.handle.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as UserRow | undefined;
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
  return db.transaction(() => {
    db.handle
      .prepare('UPDATE users SET full_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(
        input.fullName?.trim() || row.full_name,
        nextRole,
        nextActive ? 1 : 0,
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
    const updated = db.handle.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as UserRow;
    return toUserAccount(updated);
  });
}

export function resetUserPassword(
  db: Database,
  input: { id: number; newPassword: string },
  actor: Actor
): void {
  const row = db.handle.prepare('SELECT * FROM users WHERE id = ?').get(input.id) as UserRow | undefined;
  if (!row) throw notFound('User');
  const problem = passwordProblem(input.newPassword);
  if (problem) throw validation(problem);
  db.transaction(() => {
    db.handle
      .prepare(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?'
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
  input: { username: string; fullName: string; password: string }
): UserAccount {
  const adminCount = countAdmins(db, false);
  if (adminCount > 0) throw new AppError('CONFLICT', 'An administrator already exists.');
  if (!input.username || !/^[a-zA-Z0-9._-]{3,32}$/.test(input.username.trim())) {
    throw validation('Username must be 3-32 characters (letters, numbers, dot, dash, underscore).');
  }
  if (!input.fullName?.trim()) throw validation('Full name is required.');
  const problem = passwordProblem(input.password);
  if (problem) throw validation(problem);
  return db.transaction(() => {
    const now = nowIso();
    const result = db.handle
      .prepare(
        `INSERT INTO users (username, full_name, role, password_hash, active, must_change_password, created_at, updated_at)
         VALUES (?, ?, 'ADMIN', ?, 1, 0, ?, ?)`
      )
      .run(input.username.trim(), input.fullName.trim(), hashPassword(input.password), now, now);
    const id = Number(result.lastInsertRowid);
    audit(db, {
      action: 'user.bootstrap',
      entity: 'user',
      entityId: id,
      username: input.username.trim(),
      severity: 'SECURITY',
      details: { username: input.username.trim() }
    });
    const row = db.handle.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow;
    return toUserAccount(row);
  });
}
