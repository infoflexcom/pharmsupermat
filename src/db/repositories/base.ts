import type { Database } from '../index';

/** A raw SQLite row (column -> value). */
export type DbRow = Record<string, unknown>;

export interface TableConfig<T extends object> {
  table: string;
  /** Every writable column, in schema order. Used for inserts / where-clauses. */
  columns: readonly (keyof T & string)[];
  /** Defaults to `id`. */
  primaryKey?: keyof T & string;
  /** Defaults to the primary key; `sort_order, name` style lists are fine. */
  orderBy?: string;
}

/**
 * Small typed wrapper around one table.
 *
 * It deliberately exposes plain CRUD only: business rules (stock, money,
 * approvals, audit) live in `src/services/*` so they always run inside a
 * service-level transaction. Repositories are the typed access used by the
 * edition modules, the reporting reads and `scripts/verify-db.ts`.
 *
 * Values are never interpolated into SQL — only column names, and those are
 * validated against the table's declared column list.
 */
export class Table<T extends object> {
  constructor(
    protected readonly db: Database,
    protected readonly config: TableConfig<T>
  ) {}

  get name(): string {
    return this.config.table;
  }

  protected get key(): string {
    return (this.config.primaryKey as string | undefined) ?? 'id';
  }

  protected get cols(): readonly string[] {
    return this.config.columns;
  }

  /** Declared writable columns, in schema order. */
  get columnNames(): readonly string[] {
    return this.config.columns;
  }

  private condition(where: Partial<T>): { sql: string; params: unknown[] } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (!this.cols.includes(column)) {
        throw new Error(`Unknown column ${this.config.table}.${column}`);
      }
      if (value === null) {
        parts.push(`${column} IS NULL`);
      } else {
        parts.push(`${column} = ?`);
        params.push(value);
      }
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
  }

  all(where: Partial<T> = {}, opts: { limit?: number; offset?: number } = {}): T[] {
    const clause = this.condition(where);
    const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const sql = `SELECT * FROM ${this.config.table} ${clause.sql} ORDER BY ${this.config.orderBy ?? this.key} LIMIT ? OFFSET ?`;
    return this.db.handle.prepare(sql).all(...clause.params, limit, offset) as T[];
  }

  findById(id: number | string): T | null {
    const row = this.db.handle.prepare(`SELECT * FROM ${this.config.table} WHERE ${this.key} = ?`).get(id);
    return (row as T | undefined) ?? null;
  }

  findOne(where: Partial<T>): T | null {
    const clause = this.condition(where);
    const row = this.db.handle.prepare(`SELECT * FROM ${this.config.table} ${clause.sql} LIMIT 1`).get(...clause.params);
    return (row as T | undefined) ?? null;
  }

  count(where: Partial<T> = {}): number {
    const clause = this.condition(where);
    const row = this.db.handle.prepare(`SELECT COUNT(*) AS n FROM ${this.config.table} ${clause.sql}`).get(...clause.params) as { n: number };
    return row.n;
  }

  insert(values: Partial<T>): number | string {
    const entries = Object.entries(values).filter(([, value]) => value !== undefined);
    if (!entries.length) throw new Error(`Refusing to insert an empty row into ${this.config.table}`);
    for (const [column] of entries) {
      if (!this.cols.includes(column)) throw new Error(`Unknown column ${this.config.table}.${column}`);
    }
    const sql = `INSERT INTO ${this.config.table} (${entries.map(([c]) => c).join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`;
    const info = this.db.handle.prepare(sql).run(...entries.map(([, value]) => value as never));
    return typeof info.lastInsertRowid === 'bigint' ? Number(info.lastInsertRowid) : info.lastInsertRowid;
  }

  update(id: number | string, patch: Partial<T>): number {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return 0;
    for (const [column] of entries) {
      if (!this.cols.includes(column) || column === this.key) {
        throw new Error(`Cannot update ${this.config.table}.${column}`);
      }
    }
    const sql = `UPDATE ${this.config.table} SET ${entries.map(([c]) => `${c} = ?`).join(', ')} WHERE ${this.key} = ?`;
    return this.db.handle.prepare(sql).run(...entries.map(([, value]) => value as never), id).changes;
  }

  /** Only for draft/master data — sales and payments are never deleted, they are voided. */
  remove(id: number | string): number {
    return this.db.handle.prepare(`DELETE FROM ${this.config.table} WHERE ${this.key} = ?`).run(id).changes;
  }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true;
}

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}
