/**
 * Machine-readable schema manifest.
 *
 * The migration SQL is the source of truth for structure; this manifest adds
 * the two things SQL cannot express on its own:
 *   - which licence module owns a table (shared / pharmacy / supermarket)
 *   - a short human description used by docs/SCHEMA.md and the DB verifier
 *
 * Anything added to a migration must be added here too — `npm run db:verify`
 * cross-checks the two and fails when they drift.
 */

export type TableOwner = 'shared' | 'pharmacy' | 'supermarket';

export interface TableSpec {
  name: string;
  owner: TableOwner;
  description: string;
}

export const TABLES: TableSpec[] = [
  /* ---------------------------------------------------------------- */
  /* Shared                                                             */
  /* ---------------------------------------------------------------- */
  { name: 'users', owner: 'shared', description: 'Accounts and roles (ADMIN / SUPERVISOR / CASHIER) with scrypt password hashes.' },
  { name: 'roles', owner: 'shared', description: 'Reserved for custom roles; the three built-in roles live in the users.role CHECK constraint.' },
  { name: 'settings', owner: 'shared', description: 'Key/value store: store identity, receipt footer, return limits, licence warning window.' },
  { name: 'audit_log', owner: 'shared', description: 'Append-only log of sales, voids, returns, price changes, stock counts, logins and denials.' },
  { name: 'license_state', owner: 'shared', description: 'Active licence: edition, start/end business dates, HMAC, last-seen stamp and lock reason. Single row (id = 1).' },
  { name: 'license_history', owner: 'shared', description: 'Append-only history of every licence period, renewal and edition change.' },
  { name: 'license_attempts', owner: 'shared', description: 'Master-password attempt outcomes that drive the 30s/1m/5m delay ladder (never stores the typed value).' },
  { name: 'license_guard', owner: 'shared', description: 'Per-install random secret used to derive the licence HMAC key.' },
  { name: 'categories', owner: 'shared', description: 'Product categories; products.category keeps a denormalised display name.' },
  { name: 'suppliers', owner: 'shared', description: 'Suppliers used by purchases.' },
  { name: 'customers', owner: 'shared', description: 'Customer directory for invoices and credit charges.' },
  { name: 'products', owner: 'shared', description: 'Catalogue: prices in kobo, stock reorder level, pharmacy and supermarket extension columns.' },
  { name: 'product_batches', owner: 'pharmacy', description: 'Batch/expiry stock engine (batch no, expiry, qty, cost). Supermarket uses a single DEFAULT batch.' },
  { name: 'stock_movements', owner: 'shared', description: 'Stock ledger: every purchase, sale, return, void and adjustment with reference and user.' },
  { name: 'sales', owner: 'shared', description: 'Sales and wholesale invoices, with store snapshot and void trail. Never deleted.' },
  { name: 'sale_items', owner: 'shared', description: 'Immutable line snapshots: SKU, name, qty, price, cost, batch.' },
  { name: 'payments', owner: 'shared', description: 'One row per money movement against a sale (cash, transfer, POS, split).' },
  { name: 'returns', owner: 'shared', description: 'Returns/credit notes with approval state and store snapshot.' },
  { name: 'return_items', owner: 'shared', description: 'Returned quantities per sale line, with restock flag.' },
  { name: 'purchases', owner: 'shared', description: 'Supplier purchase headers (received stock).' },
  { name: 'purchase_items', owner: 'shared', description: 'Purchase lines with batch and expiry for receiving.' },
  { name: 'day_closings', owner: 'shared', description: 'End-of-day cash reconciliation, one row per business date.' },
  { name: 'counters', owner: 'shared', description: 'Atomic document sequences (RCP, INV, CN, SKU, PUR).' },
  { name: 'sessions_meta', owner: 'shared', description: 'Reserved internal metadata (installation notes); no business data.' },

  /* ---------------------------------------------------------------- */
  /* Supermarket module                                                 */
  /* ---------------------------------------------------------------- */
  { name: 'departments', owner: 'supermarket', description: 'Store departments (aisles/brands) used for grouping and price rules.' },
  { name: 'promotions', owner: 'supermarket', description: 'Percent/amount/BOGO/multibuy promotions with validity window.' },
  { name: 'price_rules', owner: 'supermarket', description: 'Price overrides by product/category/department, with supervisor flag.' },
  { name: 'loyalty_members', owner: 'supermarket', description: 'Loyalty member records with points balance.' },
  { name: 'loyalty_transactions', owner: 'supermarket', description: 'Points earned/redeemed against a member and sale.' },
  { name: 'cashier_shifts', owner: 'supermarket', description: 'Cashier shift open/close with float, expected cash and variance.' },
  { name: 'cash_drawer_events', owner: 'supermarket', description: 'Drawer open, no-sale, paid-in, paid-out and close events.' },
  { name: 'product_barcodes', owner: 'supermarket', description: 'Multiple barcodes per product (pack sizes).' },
  { name: 'product_variants', owner: 'supermarket', description: 'Product variants (size/flavour) with their own SKU, barcode and price.' }
];

export const TABLE_NAMES = TABLES.map((t) => t.name);

export const SHARED_TABLES = TABLES.filter((t) => t.owner === 'shared').map((t) => t.name);
export const PHARMACY_TABLES = TABLES.filter((t) => t.owner === 'pharmacy').map((t) => t.name);
export const SUPERMARKET_TABLES = TABLES.filter((t) => t.owner === 'supermarket').map((t) => t.name);

export function tablesForEdition(edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH'): string[] {
  const pharmacy = edition === 'PHARMACY' || edition === 'BOTH';
  const supermarket = edition === 'SUPERMARKET' || edition === 'BOTH';
  return [
    ...SHARED_TABLES,
    ...(pharmacy ? PHARMACY_TABLES : []),
    ...(supermarket ? SUPERMARKET_TABLES : [])
  ];
}

/** Columns that exist only for one edition (documented in SCHEMA.md). */
export const EDITION_COLUMNS: { table: string; column: string; owner: TableOwner; note: string }[] = [
  { table: 'products', column: 'generic_name', owner: 'pharmacy', note: 'Generic (INN) name shown on dispensing screens.' },
  { table: 'products', column: 'requires_prescription', owner: 'pharmacy', note: 'Sale blocked unless a prescription reference is captured.' },
  { table: 'products', column: 'department_id', owner: 'supermarket', note: 'Links a product to a store department.' },
  { table: 'products', column: 'shelf_location', owner: 'supermarket', note: 'Aisle/bay/shelf label.' },
  { table: 'products', column: 'plu_code', owner: 'supermarket', note: 'PLU for weighed items (scale label).' },
  { table: 'products', column: 'price_per_kg', owner: 'supermarket', note: 'Kobo per kilogram for weighed items.' },
  { table: 'products', column: 'is_weighed', owner: 'supermarket', note: 'Item is sold by weight.' },
  { table: 'sales', column: 'loyalty_member_id', owner: 'supermarket', note: 'Loyalty member attached to the sale.' },
  { table: 'sales', column: 'shift_id', owner: 'supermarket', note: 'Cashier shift that produced the sale.' },
  { table: 'product_batches', column: 'expiry_date', owner: 'pharmacy', note: 'FEFO selling and expiry alerts.' }
];
