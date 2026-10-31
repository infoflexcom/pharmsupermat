import { describe, expect, it } from 'vitest';
import Sqlite from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/db';
import { MIGRATIONS, migrate } from '../src/db/migrations';
import { TABLE_NAMES, TABLES } from '../src/db/schema';
import { repositoriesFor } from '../src/db/repositories';
import type { Sale } from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct } from './helpers';

function tempDb(): { db: Database; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'infoflex-schema-'));
  const db = new Database(join(dir, 'schema.db'));
  db.open();
  return {
    db,
    dir,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('database schema and migrations', () => {
  it('creates every documented table on a fresh database', () => {
    const { db, cleanup } = tempDb();
    try {
      expect(db.handle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      const tables = (
        db.handle
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[]
      ).map((row) => row.name);
      for (const name of TABLE_NAMES) expect(tables).toContain(name);
      expect(tables.sort()).toEqual([...TABLE_NAMES].sort());
      // Seeded roles are part of the schema contract.
      expect(repositoriesFor(db).roles.count()).toBe(3);
      // Money is integer kobo: no REAL columns anywhere in the schema.
      for (const spec of TABLES) {
        const columns = db.handle.prepare(`PRAGMA table_info(${spec.name})`).all() as { name: string; type: string }[];
        for (const column of columns) expect(column.type).not.toMatch(/REAL|FLOAT|DOUBLE/i);
      }
    } finally {
      cleanup();
    }
  });

  it('upgrades a v1 installation in place, keeping stock and backfilling categories and barcodes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'infoflex-upgrade-'));
    const file = join(dir, 'old.db');
    const legacy = new Sqlite(file);
    legacy.pragma('foreign_keys = ON');
    legacy.exec('BEGIN');
    legacy.exec(MIGRATIONS[0].sql);
    legacy.pragma('user_version = 1');
    legacy.exec('COMMIT');

    const now = new Date().toISOString();
    legacy
      .prepare(
        `INSERT INTO products (sku, barcode, name, category, price, cost_price, created_at, updated_at)
         VALUES ('SKU-1', '8891234', 'Paracetamol 500mg', 'Analgesics', 15000, 9000, ?, ?)`
      )
      .run(now, now);
    legacy
      .prepare(
        `INSERT INTO stock_batches (product_id, batch_no, expiry_date, qty, cost_price, created_at, updated_at)
         VALUES (1, 'B1', '2027-01-01', 10, 9000, ?, ?)`
      )
      .run(now, now);
    legacy.close();

    const db = new Database(file);
    db.open();
    try {
      expect(db.handle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
      const product = db.handle
        .prepare('SELECT sku, category_id, requires_prescription FROM products WHERE sku = ?')
        .get('SKU-1') as { sku: string; category_id: number; requires_prescription: number };
      expect(product.category_id).toBe(1);
      expect(product.requires_prescription).toBe(0);

      const category = db.handle.prepare('SELECT name FROM categories WHERE id = ?').get(1) as { name: string };
      expect(category.name).toBe('Analgesics');

      const barcode = db.handle
        .prepare('SELECT barcode, is_primary FROM product_barcodes WHERE product_id = 1')
        .get() as { barcode: string; is_primary: number };
      expect(barcode.barcode).toBe('8891234');
      expect(barcode.is_primary).toBe(1);

      const batch = db.handle
        .prepare('SELECT qty, expiry_date FROM product_batches WHERE product_id = 1')
        .get() as { qty: number; expiry_date: string };
      expect(batch.qty).toBe(10);
      expect(batch.expiry_date).toBe('2027-01-01');

      // Re-running is a no-op, not an error.
      migrate(db.handle);
      expect(db.handle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('issues unique sequential receipt numbers and stores payments', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      const product = await createProduct(h, admin, { openingStock: 20 });
      const saleBody = {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: product.price
      };
      const first = await callOk<Sale>(h, 'sales.create', saleBody, admin.token);
      const second = await callOk<Sale>(h, 'sales.create', saleBody, admin.token);

      expect(first.receiptNo).toMatch(/^RCP-\d{6}$/);
      expect(Number(second.receiptNo.slice(4))).toBe(Number(first.receiptNo.slice(4)) + 1);
      expect(first.payments).toHaveLength(1);
      expect(first.payments[0].amount).toBe(first.total);
      expect(Number.isInteger(first.total)).toBe(true);

      // The UNIQUE index is the last line of defence against duplicates.
      expect(() =>
        h.db.handle
          .prepare(
            `INSERT INTO payments (sale_id, method, amount, created_at) VALUES (?, 'CASH', 1, ?)`
          )
          .run(first.id, new Date().toISOString())
      ).not.toThrow();
      expect(() =>
        h.db.handle
          .prepare(
            `INSERT INTO sales (receipt_no, subtotal, total, amount_paid, payment_method, user_id, username,
              store_name, store_address, store_phone, created_at)
             VALUES (?, 0, 0, 0, 'CASH', 1, 'admin', 'S', 'A', 'P', ?)`
          )
          .run(first.receiptNo, new Date().toISOString())
      ).toThrow(/UNIQUE/i);
    } finally {
      h.close();
    }
  });

  it('gates edition modules in the main process', async () => {
    const pharmacy = await bootstrap('PHARMACY');
    try {
      await callOk(pharmacy.h, 'pharmacy.expiryWatch', { windowDays: 30 }, pharmacy.admin.token);
      const blocked = await callErr(pharmacy.h, 'mart.departments.list', {}, pharmacy.admin.token);
      expect(blocked.code).toBe('EDITION_RESTRICTED');
      const shifts = await callErr(pharmacy.h, 'mart.shifts.open', {}, pharmacy.admin.token);
      expect(shifts.code).toBe('EDITION_RESTRICTED');
    } finally {
      pharmacy.h.close();
    }

    const mart = await bootstrap('SUPERMARKET');
    try {
      const departments = await callOk<unknown[]>(mart.h, 'mart.departments.list', {}, mart.admin.token);
      expect(Array.isArray(departments)).toBe(true);
      const blocked = await callErr(mart.h, 'pharmacy.dispenseLookup', { code: 'x' }, mart.admin.token);
      expect(blocked.code).toBe('EDITION_RESTRICTED');
    } finally {
      mart.h.close();
    }
  });

  it('enforces typed columns and foreign keys in the repository layer', () => {
    const { db, cleanup } = tempDb();
    try {
      const repos = repositoriesFor(db);
      const now = new Date().toISOString();
      const categoryId = repos.categories.insert({ name: 'Antibiotics', sort_order: 0, active: 1, created_at: now, updated_at: now });
      const stored = repos.categories.findById(categoryId);
      expect(stored?.name).toBe('Antibiotics');

      expect(() => repos.categories.insert({ nonsense: 1 } as never)).toThrow(/Unknown column/);
      expect(() => repos.categories.all({ nonsense: 1 } as never)).toThrow(/Unknown column/);
      expect(() =>
        repos.productBatches.insert({
          product_id: 999,
          batch_no: 'X',
          qty: 1,
          cost_price: 1,
          created_at: now,
          updated_at: now
        })
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      cleanup();
    }
  });
});
