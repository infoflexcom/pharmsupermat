import type { Database as SqliteDatabase } from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Schema migrations are append-only: add a new entry, never edit an old one.
 * The applied version is tracked with PRAGMA user_version.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: /* sql */ `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN','SUPERVISOR','CASHIER')),
        password_hash TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        entity TEXT,
        entity_id TEXT,
        details TEXT,
        severity TEXT NOT NULL DEFAULT 'INFO'
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

      CREATE TABLE IF NOT EXISTS license (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        edition TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        license_id TEXT NOT NULL,
        activation_code TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        activated_at TEXT NOT NULL,
        activated_by TEXT,
        note TEXT
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT NOT NULL UNIQUE,
        barcode TEXT,
        name TEXT NOT NULL,
        category TEXT,
        unit TEXT NOT NULL DEFAULT 'unit',
        cost_price INTEGER NOT NULL DEFAULT 0,
        price INTEGER NOT NULL DEFAULT 0,
        wholesale_price INTEGER NOT NULL DEFAULT 0,
        reorder_level INTEGER NOT NULL DEFAULT 0,
        rx_required INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

      CREATE TABLE IF NOT EXISTS stock_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        batch_no TEXT NOT NULL,
        expiry_date TEXT,
        qty INTEGER NOT NULL DEFAULT 0,
        cost_price INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_batches_product ON stock_batches(product_id);
      CREATE INDEX IF NOT EXISTS idx_batches_expiry ON stock_batches(expiry_date);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_batches_unique
        ON stock_batches(product_id, batch_no, IFNULL(expiry_date, ''));

      CREATE TABLE IF NOT EXISTS stock_moves (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        batch_id INTEGER,
        qty_change INTEGER NOT NULL,
        type TEXT NOT NULL,
        ref_type TEXT,
        ref_id INTEGER,
        note TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_moves_product ON stock_moves(product_id);
      CREATE INDEX IF NOT EXISTS idx_moves_ref ON stock_moves(ref_type, ref_id);

      CREATE TABLE IF NOT EXISTS sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        receipt_no TEXT NOT NULL UNIQUE,
        doc_type TEXT NOT NULL DEFAULT 'RECEIPT',
        customer_name TEXT,
        customer_phone TEXT,
        customer_address TEXT,
        prescription_ref TEXT,
        subtotal INTEGER NOT NULL,
        discount INTEGER NOT NULL DEFAULT 0,
        tax INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL,
        amount_paid INTEGER NOT NULL,
        change_due INTEGER NOT NULL DEFAULT 0,
        payment_method TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','VOIDED')),
        void_reason TEXT,
        void_requested_by INTEGER,
        void_requested_at TEXT,
        voided_by INTEGER,
        voided_at TEXT,
        approved_by INTEGER,
        price_override_by INTEGER,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        store_name TEXT NOT NULL,
        store_address TEXT NOT NULL,
        store_phone TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sales_user ON sales(user_id);

      CREATE TABLE IF NOT EXISTS sale_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        product_id INTEGER NOT NULL,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        list_price INTEGER NOT NULL,
        cost_price INTEGER NOT NULL,
        line_total INTEGER NOT NULL,
        batch_id INTEGER,
        batch_no TEXT,
        rx_required INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

      CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        credit_note_no TEXT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        customer_name TEXT,
        reason TEXT NOT NULL,
        total INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','REJECTED')),
        requested_by INTEGER NOT NULL,
        requested_at TEXT NOT NULL,
        approved_by INTEGER,
        approved_at TEXT,
        reject_reason TEXT,
        store_name TEXT NOT NULL,
        store_address TEXT NOT NULL,
        store_phone TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns(sale_id);
      CREATE INDEX IF NOT EXISTS idx_returns_status ON returns(status);

      CREATE TABLE IF NOT EXISTS return_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER NOT NULL REFERENCES returns(id),
        sale_item_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        line_total INTEGER NOT NULL,
        batch_id INTEGER,
        cost_price INTEGER NOT NULL DEFAULT 0,
        restock INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_return_items_return ON return_items(return_id);

      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `
  }
];

export function migrate(db: SqliteDatabase): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  for (const migration of pending) {
    db.exec('BEGIN');
    try {
      db.exec(migration.sql);
      db.pragma(`user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(
        `Database migration ${migration.version} (${migration.name}) failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}

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
