/**
 * Supervisor approvals at the till.
 *
 * A cashier who needs a price override (or an administrator who needs a
 * discount above the cap) asks a second person to walk over and type their
 * password. The password is checked with the normal scrypt verifier and is
 * never kept: only a short-lived, single-use token is handed back, and the
 * approval itself goes to the audit log.
 */
import { randomBytes } from 'node:crypto';
import type { Database } from '../db';
import type { ApprovalGrant, ApprovalPurpose } from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { findUserByUsername, verifyPassword } from './auth';
import { permissionsForRole } from '../shared/permissions';
import { audit } from './audit';
import { getLicenseStatus } from '../license/license';

const APPROVAL_TTL_MS = 5 * 60 * 1000;

interface StoredGrant extends ApprovalGrant {
  dbKey: number;
  used: boolean;
}

// In memory only: closing the app invalidates every outstanding approval,
// which is exactly what a supervisor would expect.
const grants = new Map<string, StoredGrant>();

/** Permission the approver must already hold for each kind of approval. */
const APPROVER_PERMISSION: Record<ApprovalPurpose, string> = {
  PRICE_OVERRIDE: 'prices.override',
  DISCOUNT: 'settings.manage',
  VOID: 'sales.void.approve'
};

const PURPOSE_LABEL: Record<ApprovalPurpose, string> = {
  PRICE_OVERRIDE: 'price override',
  DISCOUNT: 'discount above the cap',
  VOID: 'void'
};

let sweepCounter = 0;

function sweep(now: number): void {
  sweepCounter += 1;
  if (sweepCounter % 20 !== 0) return;
  for (const [token, grant] of grants) {
    if (grant.used || Date.parse(grant.expiresAt) <= now) grants.delete(token);
  }
}

export interface ApprovalInput {
  purpose: ApprovalPurpose;
  username: string;
  password: string;
  /** What the approval is for, kept in the audit trail. */
  reason?: string;
}

/**
 * Verifies an approver's own credentials and returns a token the till passes
 * back with the sale. The token proves a human with the right permission
 * agreed, without the sale handler ever seeing their password.
 */
export function approveWithPin(
  db: Database,
  input: ApprovalInput,
  requester: { userId: number; username: string }
): ApprovalGrant {
  if (!input || typeof input !== 'object') throw validation('Approval details are missing.');
  if (!['PRICE_OVERRIDE', 'DISCOUNT', 'VOID'].includes(input.purpose)) {
    throw validation('Unknown approval type.');
  }
  const username = (input.username ?? '').trim();
  const password = input.password ?? '';
  if (!username || !password) throw validation('Enter the approver’s username and password.');

  const user = findUserByUsername(db, username);
  const ok = Boolean(user) && Boolean(user?.active) && verifyPassword(password, user!.password_hash);

  if (!ok) {
    audit(db, {
      action: 'pos.approval.denied',
      entity: 'user',
      entityId: user?.id ?? null,
      userId: requester.userId,
      username: requester.username,
      severity: 'WARN',
      details: { purpose: input.purpose, attempted: username, reason: input.reason ?? null }
    });
    throw new AppError('FORBIDDEN', 'That username and password do not match an active user.');
  }

  const edition = getLicenseStatus(db).edition;
  const permissions = permissionsForRole(user!.role, edition);
  const needed = APPROVER_PERMISSION[input.purpose];
  if (!permissions.includes(needed as never)) {
    throw new AppError(
      'FORBIDDEN',
      `${user!.full_name} cannot approve a ${PURPOSE_LABEL[input.purpose]}.`
    );
  }
  if (user!.id === requester.userId) {
    // Self-approval is allowed for administrators (they are the second pair of
    // eyes anyway) but never silently: it is logged as a warning below.
  }

  const now = Date.now();
  sweep(now);
  const token = randomBytes(18).toString('hex');
  const grant: StoredGrant = {
    token,
    username: user!.username,
    purpose: input.purpose,
    expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    dbKey: databaseKey(db),
    used: false
  };
  grants.set(token, grant);

  audit(db, {
    action: 'pos.approval',
    entity: 'user',
    entityId: user!.id,
    userId: requester.userId,
    username: requester.username,
    severity: user!.id === requester.userId ? 'WARN' : 'INFO',
    details: {
      purpose: input.purpose,
      approvedBy: user!.username,
      approvedByRole: user!.role,
      reason: input.reason ?? null
    }
  });

  return { token, username: grant.username, purpose: grant.purpose, expiresAt: grant.expiresAt };
}

/** The approver behind a token, consuming it so it cannot be reused. */
export function consumeApproval(
  db: Database,
  token: string | undefined,
  purpose: ApprovalPurpose
): { username: string } | null {
  if (!token) return null;
  const grant = grants.get(token);
  if (!grant) throw new AppError('APPROVAL_REQUIRED', 'That approval has expired. Ask a supervisor again.');
  if (grant.dbKey !== databaseKey(db)) {
    throw new AppError('APPROVAL_REQUIRED', 'That approval belongs to another store. Ask a supervisor again.');
  }
  if (grant.used) throw new AppError('APPROVAL_REQUIRED', 'That approval was already used.');
  if (Date.parse(grant.expiresAt) <= Date.now()) {
    grants.delete(token);
    throw new AppError('APPROVAL_REQUIRED', 'That approval has expired. Ask a supervisor again.');
  }
  if (grant.purpose !== purpose) {
    throw new AppError('APPROVAL_REQUIRED', `That approval was for a different action, not a ${PURPOSE_LABEL[purpose]}.`);
  }
  grant.used = true;
  return { username: grant.username };
}

/**
 * A stable identity for the open database. `Database` wraps one connection per
 * install, so the connection object itself is a good key.
 */
const keys = new WeakMap<object, number>();
let nextKey = 1;
function databaseKey(db: Database): number {
  const target = db as unknown as object;
  const existing = keys.get(target);
  if (existing) return existing;
  keys.set(target, nextKey);
  nextKey += 1;
  return keys.get(target)!;
}

/** Test/teardown helper: forget every outstanding approval. */
export function clearApprovals(): void {
  grants.clear();
}
