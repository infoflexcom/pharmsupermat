import type { Database } from '../db';
import { nowIso } from '../db';
import type { AuditEntry } from '../shared/types';

export interface AuditInput {
  action: string;
  entity?: string;
  entityId?: string | number | null;
  details?: unknown;
  severity?: 'INFO' | 'WARN' | 'SECURITY';
  userId?: number | null;
  username?: string | null;
}

/**
 * Append-only audit trail. Never throws: a failed audit write must not roll
 * back a business transaction, but it is surfaced on stderr.
 */
export function audit(db: Database, input: AuditInput): void {
  try {
    const details =
      input.details === undefined || input.details === null
        ? null
        : typeof input.details === 'string'
          ? input.details
          : JSON.stringify(input.details);
    db.handle
      .prepare(
        `INSERT INTO audit_log (created_at, user_id, username, action, entity, entity_id, details, severity)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        nowIso(),
        input.userId ?? null,
        input.username ?? null,
        input.action,
        input.entity ?? null,
        input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
        details,
        input.severity ?? 'INFO'
      );
  } catch (error) {
    console.error('[audit] failed to write audit entry', error);
  }
}

export function listAudit(
  db: Database,
  options: { from?: string; to?: string; limit?: number; action?: string; search?: string } = {}
): AuditEntry[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.from) {
    clauses.push('created_at >= ?');
    params.push(`${options.from}T00:00:00`);
  }
  if (options.to) {
    clauses.push('created_at <= ?');
    params.push(`${options.to}T23:59:59.999Z`);
  }
  if (options.action) {
    clauses.push('action = ?');
    params.push(options.action);
  }
  if (options.search) {
    clauses.push('(action LIKE ? OR username LIKE ? OR details LIKE ?)');
    const like = `%${options.search}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const rows = db.handle
    .prepare(
      `SELECT id, created_at, user_id, username, action, entity, entity_id, details, severity
       FROM audit_log ${where} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit) as {
    id: number;
    created_at: string;
    user_id: number | null;
    username: string | null;
    action: string;
    entity: string | null;
    entity_id: string | null;
    details: string | null;
    severity: 'INFO' | 'WARN' | 'SECURITY';
  }[];
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    userId: r.user_id,
    username: r.username,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    details: r.details,
    severity: r.severity
  }));
}
