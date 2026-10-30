import { randomBytes } from 'node:crypto';
import type { Database } from '../db';
import type { Edition, LicenseStatus, Role } from '../shared/types';
import { permissionsForRole, type Permission } from '../shared/permissions';
import { findUserById } from './auth';
import { idleTimeoutMs } from './settings';
import { getLicenseStatus } from '../license/license';

export interface Session {
  token: string;
  userId: number;
  username: string;
  fullName: string;
  role: Role;
  permissions: Permission[];
  mustChangePassword: boolean;
  createdAt: number;
  lastSeen: number;
}

export interface ApiContext {
  db: Database;
  dataDir: string;
  backupsDir: string;
  version: string;
  sessions: Map<string, Session>;
  /** Injectable clock — keeps tests deterministic. */
  now(): Date;
  /** Electron-only printer hook; absent in the browser dev harness. */
  print?: (payload: { html: string; title: string }) => Promise<{ printed: boolean; message: string }>;
}

/** Fallback when settings cannot be read (e.g. a brand-new database). */
export const SESSION_IDLE_MS = 15 * 60 * 1000;

/** Inactivity limit for a session, configured in Settings (1-720 minutes). */
export function sessionIdleMs(db: Database): number {
  try {
    return idleTimeoutMs(db);
  } catch {
    return SESSION_IDLE_MS;
  }
}

export function createContext(options: {
  db: Database;
  dataDir: string;
  backupsDir: string;
  version: string;
  now?: () => Date;
  print?: (payload: { html: string; title: string }) => Promise<{ printed: boolean; message: string }>;
}): ApiContext {
  return {
    db: options.db,
    dataDir: options.dataDir,
    backupsDir: options.backupsDir,
    version: options.version,
    sessions: new Map(),
    now: options.now ?? (() => new Date()),
    ...(options.print ? { print: options.print } : {})
  };
}

export function createSession(
  ctx: ApiContext,
  user: {
    id: number;
    username: string;
    fullName: string;
    role: Role;
    mustChangePassword: boolean;
  },
  edition: Edition
): Session {
  const token = randomBytes(24).toString('base64url');
  const session: Session = {
    token,
    userId: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    permissions: permissionsForRole(user.role, edition),
    mustChangePassword: user.mustChangePassword,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };
  // One live session per user keeps role/permission changes predictable.
  for (const [existingToken, existing] of ctx.sessions) {
    if (existing.userId === user.id) ctx.sessions.delete(existingToken);
  }
  ctx.sessions.set(token, session);
  return session;
}

export function resolveSession(ctx: ApiContext, token: unknown): Session | null {
  if (typeof token !== 'string' || !token) return null;
  const session = ctx.sessions.get(token);
  if (!session) return null;
  // Idle expiry is enforced here, in the main process, so a renderer that
  // ignores its own timer still cannot keep a session alive.
  if (Date.now() - session.lastSeen > sessionIdleMs(ctx.db)) {
    ctx.sessions.delete(token);
    return null;
  }
  // Re-read the account on every call: a disabled user or a downgraded role
  // takes effect immediately, not at the next sign-in.
  const user = findUserById(ctx.db, session.userId);
  if (!user || !user.active) {
    ctx.sessions.delete(token);
    return null;
  }
  const license = getLicenseStatus(ctx.db);
  session.role = user.role;
  session.fullName = user.full_name;
  session.mustChangePassword = !!user.must_change_password;
  session.permissions = permissionsForRole(user.role, license.edition);
  session.lastSeen = Date.now();
  return session;
}

export function dropSession(ctx: ApiContext, token: string): void {
  ctx.sessions.delete(token);
}

export function dropSessionsForUser(ctx: ApiContext, userId: number): void {
  for (const [token, session] of ctx.sessions) {
    if (session.userId === userId) ctx.sessions.delete(token);
  }
}

export function clearSessions(ctx: ApiContext): void {
  ctx.sessions.clear();
}

/** Recomputes permissions after an edition/licence change. */
export function refreshSessionPermissions(ctx: ApiContext, license: LicenseStatus): void {
  for (const session of ctx.sessions.values()) {
    if (license.edition) session.permissions = permissionsForRole(session.role, license.edition);
  }
}
