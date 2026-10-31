import type { Database as SqliteDatabase } from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { migrate } from './migrations';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Thin wrapper so the whole app can run against a swappable database handle
 * (needed by backup restore, which closes and re-opens the file).
 */
export class Database {
  private connection: SqliteDatabase | null = null;

  constructor(public readonly filename: string) {}

  open(): SqliteDatabase {
    if (this.connection) return this.connection;
    if (this.filename !== ':memory:') mkdirSync(dirname(this.filename), { recursive: true });
    const db = new Sqlite(this.filename);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    this.connection = db;
    return db;
  }

  get handle(): SqliteDatabase {
    if (!this.connection) return this.open();
    return this.connection;
  }

  close(): void {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
  }

  /** Runs fn inside an IMMEDIATE transaction (money + stock safety). */
  transaction<T>(fn: () => T): T {
    const db = this.handle;
    if (db.inTransaction) return fn();
    const runner = db.transaction(fn);
    return runner.immediate() as T;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
