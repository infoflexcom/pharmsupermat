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
  },
  {
    version: 4,
    name: 'licence_periods_hmac_and_attempt_throttle',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Licence periods (start/end business dates), HMAC integrity, the  *
       * last-seen stamp used to detect a clock rollback, and the reason   *
       * the app is currently locked (cleared by a vendor unlock).         *
       * ---------------------------------------------------------------- */
      ALTER TABLE license_state ADD COLUMN starts_on TEXT;
      ALTER TABLE license_state ADD COLUMN ends_on TEXT;
      ALTER TABLE license_state ADD COLUMN hmac TEXT;
      ALTER TABLE license_state ADD COLUMN period_hmac TEXT;
      ALTER TABLE license_state ADD COLUMN signed_at TEXT;
      ALTER TABLE license_state ADD COLUMN renewed_at TEXT;
      ALTER TABLE license_state ADD COLUMN last_seen_at TEXT;
      ALTER TABLE license_state ADD COLUMN last_seen_hmac TEXT;
      ALTER TABLE license_state ADD COLUMN lock_reason TEXT;
      ALTER TABLE license_state ADD COLUMN locked_at TEXT;
      ALTER TABLE license_state ADD COLUMN integrity_algo TEXT NOT NULL DEFAULT 'hmac-sha256';

      /* Backfill business dates for installs that predate licence periods:
         the old expiry timestamp becomes the first invalid day. */
      UPDATE license_state
         SET starts_on = COALESCE(starts_on, date(issued_at)),
             ends_on = COALESCE(ends_on, date(expires_at, '+1 day')),
             signed_at = COALESCE(signed_at, activated_at),
             last_seen_at = COALESCE(last_seen_at, datetime('now'))
       WHERE id = 1;

      /* Every period and edition change ever saved, append-only. */
      CREATE TABLE IF NOT EXISTS license_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_id TEXT NOT NULL,
        edition TEXT NOT NULL CHECK (edition IN ('PHARMACY','SUPERMARKET','BOTH')),
        customer_name TEXT NOT NULL DEFAULT '',
        starts_on TEXT NOT NULL,
        ends_on TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('ACTIVATE','RENEW','EDITION_CHANGE','UNLOCK')),
        period_hmac TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'vendor'
      );
      CREATE INDEX IF NOT EXISTS idx_license_history_created ON license_history(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_license_history_period ON license_history(starts_on, ends_on);

      /* Master-password attempts: drives the 30s / 1m / 5m ... delay ladder.
         Only the outcome is stored — never what was typed. */
      CREATE TABLE IF NOT EXISTS license_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('OK','WRONG')),
        failures_after INTEGER NOT NULL DEFAULT 0,
        delay_seconds INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'vendor'
      );
      CREATE INDEX IF NOT EXISTS idx_license_attempts_created ON license_attempts(created_at DESC);

      /* Per-install random secret used to derive the licence HMAC key. It lives
         beside the licence record, so editing either one on its own fails. */
      CREATE TABLE IF NOT EXISTS license_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    version: 5,
    name: 'product_packs_brands_stock_counts_and_grn',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Product master data: brand, pack size (units per pack) and the    *
       * wholesale minimum quantity. Stock is always kept in base units;    *
       * receiving packs is converted on the way in.                        *
       * ---------------------------------------------------------------- */
      ALTER TABLE products ADD COLUMN brand TEXT;
      ALTER TABLE products ADD COLUMN pack_size INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE products ADD COLUMN pack_unit TEXT NOT NULL DEFAULT 'pack';
      ALTER TABLE products ADD COLUMN wholesale_min_qty INTEGER NOT NULL DEFAULT 1;
      /* Supermarket perishables opt in to expiry tracking; pharmacy products
         are always tracked because the module owns batches. */
      ALTER TABLE products ADD COLUMN expiry_tracking INTEGER NOT NULL DEFAULT 0;

      /* Sub-categories: a category may sit under a department-style parent. */
      ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id);
      CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);

      /* Structured adjustment reason (damaged / lost / correction / count). */
      ALTER TABLE stock_movements ADD COLUMN reason_type TEXT;
      CREATE INDEX IF NOT EXISTS idx_moves_type ON stock_movements(type, created_at DESC);

      /* Goods-received notes against a purchase (draft order -> received). */
      ALTER TABLE purchases ADD COLUMN grn_no TEXT;
      ALTER TABLE purchases ADD COLUMN received_at TEXT;
      ALTER TABLE purchases ADD COLUMN ordered_at TEXT;

      /* ---------------------------------------------------------------- *
       * Stock counts (stocktake) and their variance report.               *
       * ---------------------------------------------------------------- */
      CREATE TABLE IF NOT EXISTS stock_counts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_no TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
        scope TEXT NOT NULL DEFAULT 'ALL',
        note TEXT,
        items_counted INTEGER NOT NULL DEFAULT 0,
        variance_qty INTEGER NOT NULL DEFAULT 0,
        variance_value INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        posted_at TEXT,
        posted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_stock_counts_created ON stock_counts(created_at DESC);

      CREATE TABLE IF NOT EXISTS stock_count_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        count_id INTEGER NOT NULL REFERENCES stock_counts(id),
        product_id INTEGER NOT NULL,
        batch_id INTEGER,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        system_qty INTEGER NOT NULL,
        counted_qty INTEGER,
        variance INTEGER NOT NULL DEFAULT 0,
        cost_price INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_stock_count_items_count ON stock_count_items(count_id);

      /* Weighed sales record grams; this flag lets receipts print "1.500 kg". */
      ALTER TABLE sale_items ADD COLUMN is_weighed INTEGER NOT NULL DEFAULT 0;

      /* Alert window for near-expiry stock (pharmacy default 90 days). */
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
        ('expiry_alert_days', '90', datetime('now')),
        ('label_default_copies', '1', datetime('now'));
    `
  }
,
  {
    version: 6,
    name: 'pos_credit_promotions_and_receipts',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Point of sale: retail/wholesale tiers, promotions, loyalty and    *
       * credit balances, plus the printing trail.                         *
       * ---------------------------------------------------------------- */
      ALTER TABLE sales ADD COLUMN tier TEXT NOT NULL DEFAULT 'RETAIL';
      ALTER TABLE sales ADD COLUMN balance_due INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN promo_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN item_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN loyalty_redeemed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN loyalty_value INTEGER NOT NULL DEFAULT 0;
      /* VAT rate used on this document, in basis points (750 = 7.50%). */
      ALTER TABLE sales ADD COLUMN vat_rate INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN print_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sales ADD COLUMN last_printed_at TEXT;

      /* A line remembers its own manual discount and any promotion used. */
      ALTER TABLE sale_items ADD COLUMN line_discount INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE sale_items ADD COLUMN promotion_id INTEGER;
      ALTER TABLE sale_items ADD COLUMN promotion_name TEXT;

      /* Money taken at the till belongs to the drawer shift it was taken in,
         which also lets credit payments collected later count towards the
         cashier's expected cash. */
      ALTER TABLE payments ADD COLUMN shift_id INTEGER;
      CREATE INDEX IF NOT EXISTS idx_payments_shift ON payments(shift_id);

      /* Held (parked) baskets: the till can recall a sale later, offline. */
      CREATE TABLE IF NOT EXISTS held_sales (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hold_no TEXT NOT NULL UNIQUE,
        label TEXT,
        payload TEXT NOT NULL,
        lines_count INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL DEFAULT 0,
        customer_name TEXT,
        user_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_held_sales_created ON held_sales(created_at DESC);

      /* Every receipt/invoice print and reprint, so DUPLICATE is provable. */
      CREATE TABLE IF NOT EXISTS document_prints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id INTEGER NOT NULL REFERENCES sales(id),
        layout TEXT NOT NULL,
        duplicate INTEGER NOT NULL DEFAULT 0,
        user_id INTEGER,
        username TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_document_prints_sale ON document_prints(sale_id);

      /* ---------------------------------------------------------------- *
       * Settings added for the till: payment methods, discount cap, VAT,  *
       * receipt layout/footer and loyalty rates.                          *
       * ---------------------------------------------------------------- */
      /* Prices on the shelf are treated as VAT-exclusive when VAT is on, so   *
       * the tax line is added on top of the discounted subtotal.              */
      INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
        ('vat_enabled', 'false', datetime('now')),
        ('vat_rate', '7.5', datetime('now')),
        ('max_discount_percent', '10', datetime('now')),
        ('payment_cash', 'true', datetime('now')),
        ('payment_transfer', 'true', datetime('now')),
        ('payment_pos', 'true', datetime('now')),
        ('payment_credit', 'false', datetime('now')),
        ('powered_by_footer', 'true', datetime('now')),
        ('receipt_layout', 'THERMAL_80', datetime('now')),
        ('customer_display', 'false', datetime('now')),
        ('require_shift', 'false', datetime('now')),
        ('loyalty_points_per_100', '1', datetime('now')),
        ('loyalty_point_value', '100', datetime('now')),
        ('loyalty_redeem_enabled', 'true', datetime('now'));
    `
  },
  {
    version: 7,
    name: 'returns_reasons_refunds_and_writeoffs',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Returns: fixed reason codes, refund/store-credit/exchange types,  *
       * proportional loyalty and promotion reversal, and a write-off     *
       * record for goods that cannot go back on the shelf.               *
       * ---------------------------------------------------------------- */
      ALTER TABLE returns ADD COLUMN return_type TEXT NOT NULL DEFAULT 'REFUND';
      ALTER TABLE returns ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'OTHER';
      ALTER TABLE returns ADD COLUMN sale_receipt_no TEXT;
      ALTER TABLE returns ADD COLUMN refund_method TEXT;
      ALTER TABLE returns ADD COLUMN exchange_note TEXT;
      /* Proportional reversals, computed when the return completes. */
      ALTER TABLE returns ADD COLUMN discount_reversed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN promo_reversed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN loyalty_points_reversed INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN loyalty_value_reversed INTEGER NOT NULL DEFAULT 0;
      /* How an out-of-window or over-limit return was authorised. */
      ALTER TABLE returns ADD COLUMN window_override INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE returns ADD COLUMN approved_via TEXT;

      /* Each line remembers why it came back and whether it can be resold. */
      ALTER TABLE return_items ADD COLUMN reason_code TEXT NOT NULL DEFAULT 'OTHER';
      ALTER TABLE return_items ADD COLUMN resellable INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE return_items ADD COLUMN net_total INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE return_items ADD COLUMN writeoff_id INTEGER;

      /* Goods that cannot be resold are recorded, valued at cost. */
      CREATE TABLE IF NOT EXISTS stock_writeoffs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        return_id INTEGER,
        product_id INTEGER NOT NULL,
        batch_id INTEGER,
        batch_no TEXT,
        qty INTEGER NOT NULL,
        cost_price INTEGER NOT NULL DEFAULT 0,
        value INTEGER NOT NULL DEFAULT 0,
        reason_code TEXT NOT NULL DEFAULT 'OTHER',
        reason TEXT,
        user_id INTEGER,
        username TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_writeoffs_return ON stock_writeoffs(return_id);
      CREATE INDEX IF NOT EXISTS idx_writeoffs_product ON stock_writeoffs(product_id);

      /* Credit notes reuse the print trail, distinguished by kind. */
      ALTER TABLE document_prints ADD COLUMN return_id INTEGER;
      ALTER TABLE document_prints ADD COLUMN kind TEXT NOT NULL DEFAULT 'SALE';

      /* Reconciled on upgrade: the receipt number is copied onto every
         existing return so old credit notes can still be looked up. */
      UPDATE returns
         SET sale_receipt_no = (SELECT s.receipt_no FROM sales s WHERE s.id = returns.sale_id);
    `
  },
  {
    version: 8,
    name: 'demo_data_register',
    sql: /* sql */ `
      /* ---------------------------------------------------------------- *
       * Demo data: which rows the "Load demo data" button created, so the *
       * administrator can take them all out again without touching real   *
       * trading data. Nothing here is referenced by a foreign key — it is  *
       * a register, not a relationship.                                   *
       * ---------------------------------------------------------------- */
      CREATE TABLE IF NOT EXISTS demo_data (
        entity TEXT NOT NULL,
        entity_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (entity, entity_id)
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
