import type { Database as SqliteDatabase } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only schema history. `PRAGMA user_version` records the last applied
 * version and each migration runs inside a transaction.
 *
 * Ownership tags used in the SQL comments:
 *   [shared]      — available in every edition
 *   [pharmacy]    — surfaced only when the licence enables the pharmacy module
 *   [supermarket] — surfaced only when the licence enables the supermarket module
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
  },
  {
    version: 2,
    name: 'shared_catalogue_partners_documents_and_edition_modules',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Shared naming alignment                                          *
       * ---------------------------------------------------------------- */
      ALTER TABLE stock_batches RENAME TO product_batches;      -- [pharmacy] batch/expiry stock engine
      ALTER TABLE stock_moves RENAME TO stock_movements;        -- [shared] movement ledger
      ALTER TABLE license RENAME TO license_state;              -- [shared] signed licence record
      ALTER TABLE products RENAME COLUMN rx_required TO requires_prescription; -- [pharmacy]

      /* ---------------------------------------------------------------- *
       * [shared] roles (seeded), categories, suppliers, customers         *
       * ---------------------------------------------------------------- */
      CREATE TABLE IF NOT EXISTS roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        is_system INTEGER NOT NULL DEFAULT 1,
        permissions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO roles (name, description, is_system, permissions, created_at) VALUES
        ('ADMIN', 'Full access', 1, '["*"]', datetime('now')),
        ('SUPERVISOR', 'Approvals, no user or price management', 1,
          '["pos.sell","sales.view.all","sales.void.approve","returns.approve","prices.override","stock.receive","reports.view.all","audit.view"]',
          datetime('now')),
        ('CASHIER', 'Sales, receipts and limited returns', 1,
          '["pos.sell","sales.view.own","sales.void.request","returns.create","reports.view.own"]', datetime('now'));

      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        contact_person TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        phone TEXT,
        email TEXT,
        address TEXT,
        credit_limit INTEGER NOT NULL DEFAULT 0,
        loyalty_member_id INTEGER,
        notes TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

      /* ---------------------------------------------------------------- *
       * [shared] products: pharmacy + supermarket columns                *
       * ---------------------------------------------------------------- */
      ALTER TABLE products ADD COLUMN generic_name TEXT;               -- [pharmacy]
      ALTER TABLE products ADD COLUMN category_id INTEGER;             -- [shared]
      ALTER TABLE products ADD COLUMN supplier_id INTEGER;             -- [shared]
      ALTER TABLE products ADD COLUMN department_id INTEGER;           -- [supermarket]
      ALTER TABLE products ADD COLUMN shelf_location TEXT;             -- [supermarket]
      ALTER TABLE products ADD COLUMN plu_code TEXT;                   -- [supermarket] weighed items
      ALTER TABLE products ADD COLUMN price_per_kg INTEGER;            -- [supermarket] kobo per kg
      ALTER TABLE products ADD COLUMN is_weighed INTEGER NOT NULL DEFAULT 0; -- [supermarket]
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_department ON products(department_id);
      CREATE INDEX IF NOT EXISTS idx_products_plu ON products(plu_code);

      /* ---------------------------------------------------------------- *
       * [shared] payments, purchases, day closings                       *
       * ---------------------------------------------------------------- */
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        method TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reference TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);
      CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);

      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_no TEXT NOT NULL UNIQUE,
        supplier_id INTEGER REFERENCES suppliers(id),
        supplier_name TEXT,
        invoice_no TEXT,
        purchase_date TEXT NOT NULL,
        subtotal INTEGER NOT NULL DEFAULT 0,
        discount INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        amount_paid INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('DRAFT','RECEIVED','CANCELLED')),
        note TEXT,
        user_id INTEGER,
        username TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date DESC);

      CREATE TABLE IF NOT EXISTS purchase_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL REFERENCES purchases(id),
        product_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        cost_price INTEGER NOT NULL,
        line_total INTEGER NOT NULL,
        batch_no TEXT,
        expiry_date TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

      CREATE TABLE IF NOT EXISTS day_closings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        business_date TEXT NOT NULL UNIQUE,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        opening_float INTEGER NOT NULL DEFAULT 0,
        cash_sales INTEGER NOT NULL DEFAULT 0,
        transfer_sales INTEGER NOT NULL DEFAULT 0,
        pos_sales INTEGER NOT NULL DEFAULT 0,
        other_sales INTEGER NOT NULL DEFAULT 0,
        returns_total INTEGER NOT NULL DEFAULT 0,
        expected_cash INTEGER NOT NULL DEFAULT 0,
        counted_cash INTEGER NOT NULL DEFAULT 0,
        variance INTEGER NOT NULL DEFAULT 0,
        sales_count INTEGER NOT NULL DEFAULT 0,
        closed_by INTEGER,
        closed_by_name TEXT,
        note TEXT
      );

      ALTER TABLE sales ADD COLUMN customer_id INTEGER;       -- [shared]
      ALTER TABLE sales ADD COLUMN loyalty_member_id INTEGER; -- [supermarket]
      ALTER TABLE sales ADD COLUMN shift_id INTEGER;          -- [supermarket]
      CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);

      /* Credit notes are unique and sequential once issued. */
      CREATE UNIQUE INDEX IF NOT EXISTS idx_returns_credit_note
        ON returns(credit_note_no) WHERE credit_note_no IS NOT NULL;

      /* ---------------------------------------------------------------- *
       * [supermarket] departments, promotions, price rules               *
       * ---------------------------------------------------------------- */
      CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        promo_type TEXT NOT NULL CHECK (promo_type IN ('PERCENT','AMOUNT','BOGO','MULTIBUY')),
        value INTEGER NOT NULL DEFAULT 0,
        product_id INTEGER,
        category_id INTEGER,
        department_id INTEGER,
        min_qty INTEGER NOT NULL DEFAULT 1,
        starts_at TEXT,
        ends_at TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_promotions_product ON promotions(product_id);

      CREATE TABLE IF NOT EXISTS price_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('PRODUCT','CATEGORY','DEPARTMENT')),
        product_id INTEGER,
        category_id INTEGER,
        department_id INTEGER,
        rule_type TEXT NOT NULL CHECK (rule_type IN ('DISCOUNT_PERCENT','DISCOUNT_AMOUNT','SET_PRICE')),
        value INTEGER NOT NULL DEFAULT 0,
        min_qty INTEGER NOT NULL DEFAULT 1,
        starts_at TEXT,
        ends_at TEXT,
        requires_supervisor INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS loyalty_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_no TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        points INTEGER NOT NULL DEFAULT 0,
        joined_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_loyalty_phone ON loyalty_members(phone);

      CREATE TABLE IF NOT EXISTS loyalty_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id INTEGER NOT NULL REFERENCES loyalty_members(id),
        sale_id INTEGER,
        points_change INTEGER NOT NULL,
        reason TEXT,
        user_id INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loyalty_tx_member ON loyalty_transactions(member_id);

      CREATE TABLE IF NOT EXISTS cashier_shifts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        opening_float INTEGER NOT NULL DEFAULT 0,
        counted_cash INTEGER,
        expected_cash INTEGER NOT NULL DEFAULT 0,
        variance INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shifts_user ON cashier_shifts(user_id, status);

      CREATE TABLE IF NOT EXISTS cash_drawer_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        shift_id INTEGER REFERENCES cashier_shifts(id),
        user_id INTEGER,
        username TEXT,
        event_type TEXT NOT NULL CHECK (event_type IN ('OPEN','NO_SALE','PAID_IN','PAID_OUT','CLOSE')),
        amount INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_drawer_shift ON cash_drawer_events(shift_id);

      CREATE TABLE IF NOT EXISTS product_barcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        barcode TEXT NOT NULL UNIQUE,
        pack_qty INTEGER NOT NULL DEFAULT 1,
        is_primary INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);

      CREATE TABLE IF NOT EXISTS product_variants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id),
        variant_name TEXT NOT NULL,
        sku TEXT NOT NULL UNIQUE,
        barcode TEXT,
        price INTEGER NOT NULL DEFAULT 0,
        cost_price INTEGER NOT NULL DEFAULT 0,
        stock_qty INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

      /* Backfill categories from the denormalised product.category text. */
      INSERT OR IGNORE INTO categories (name, sort_order, active, created_at, updated_at)
        SELECT DISTINCT TRIM(category), 0, 1, datetime('now'), datetime('now')
        FROM products WHERE category IS NOT NULL AND TRIM(category) <> '';
      UPDATE products
        SET category_id = (SELECT c.id FROM categories c WHERE c.name = TRIM(products.category))
        WHERE category IS NOT NULL AND TRIM(category) <> '' AND category_id IS NULL;

      /* Backfill the primary barcode into the multi-barcode table. */
      INSERT OR IGNORE INTO product_barcodes (product_id, barcode, pack_qty, is_primary, created_at)
        SELECT id, barcode, 1, 1, datetime('now') FROM products
        WHERE barcode IS NOT NULL AND TRIM(barcode) <> '';
    `
  },
  {
    version: 3,
    name: 'account_lockout_store_profile_and_idle_policy',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Account lockout (5 failed sign-ins lock the account until an       *
       * administrator unlocks it). Counters live on the user row so a      *
       * restart, a second terminal or a copied database cannot reset them. *
       * ---------------------------------------------------------------- */
      ALTER TABLE users ADD COLUMN failed_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN locked_until TEXT;
      ALTER TABLE users ADD COLUMN locked_reason TEXT;
      ALTER TABLE users ADD COLUMN password_algo TEXT NOT NULL DEFAULT 'bcrypt';
      ALTER TABLE users ADD COLUMN email TEXT;
      CREATE INDEX IF NOT EXISTS idx_users_locked ON users(locked_until);

      /* Store profile extras captured at first-run setup (settings is key/value,
         this keeps the defaults explicit for new installs). */
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
        ('store_email', '', datetime('now')),
        ('store_licence_no', '', datetime('now')),
        ('store_vat_no', '', datetime('now')),
        ('store_logo', '', datetime('now')),
        ('thank_you_note', 'Thank you for your patronage.', datetime('now')),
        ('idle_timeout_minutes', '15', datetime('now'));

      /* Sign-in and user-management events drive the security view. */
      CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at DESC);
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
