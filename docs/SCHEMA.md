# Database schema

Infoflex keeps everything in one SQLite file inside the OS application-data folder, so the app works fully offline:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Infoflex\data\infoflex.db` |
| macOS | `~/Library/Application Support/Infoflex/data/infoflex.db` |
| Linux | `~/.config/Infoflex/data/infoflex.db` |

Set `INFOFLEX_DATA_DIR` to override the folder (the browser preview and the smoke test do this).

Schema version: **8** (`PRAGMA user_version`), migrations: v1 initial, v2 shared_catalogue_partners_documents_and_edition_modules, v3 account_lockout_store_profile_and_idle_policy, v4 licence_periods_hmac_and_attempt_throttle, v5 product_packs_brands_stock_counts_and_grn, v6 pos_credit_promotions_and_receipts, v7 returns_reasons_refunds_and_writeoffs, v8 demo_data_register.

## Rules that apply to every table

- **Money is integer kobo.** ₦1,500.00 is stored as `150000`. Formatting happens at the edge (`src/shared/money.ts`).
- **Timestamps are ISO-8601 UTC strings** (`2026-10-30T12:00:00.000Z`); business dates are `YYYY-MM-DD`.
- **Sales, sale items and payments are never deleted.** A mistake is voided (`sales.status = 'VOIDED'`, `voided_by`, `voided_at`, audit entry).
- **Money and stock changes run in one `IMMEDIATE` transaction** (`Database.transaction`), so a failed payment can never leave stock short.
- **Receipt numbers are sequential and unique** (`counters` → `RCP-000001`), likewise invoices (`INV-`), credit notes (`CN-`), purchase numbers (`PUR-`) and product codes (`SKU-`).
- **Every table below is reachable through a typed repository** in `src/db/repositories/`.

## Tables by edition

- **Shared (all editions):** `users`, `roles`, `settings`, `audit_log`, `license_state`, `license_history`, `license_attempts`, `license_guard`, `held_sales`, `document_prints`, `stock_writeoffs`, `categories`, `suppliers`, `customers`, `products`, `stock_movements`, `sales`, `sale_items`, `payments`, `returns`, `return_items`, `purchases`, `purchase_items`, `day_closings`, `counters`, `sessions_meta`, `demo_data`
- **Pharmacy module:** `product_batches`
- **Supermarket module:** `stock_counts`, `stock_count_items`, `departments`, `promotions`, `price_rules`, `loyalty_members`, `loyalty_transactions`, `cashier_shifts`, `cash_drawer_events`, `product_barcodes`, `product_variants`

Edition tables are created by the migration (a shop that later upgrades from pharmacy to pharmacy+supermarket keeps its data), but the main process only mounts a module's IPC channels when the signed licence enables it — see `handlerMapFor()` in `src/main/api/registry.ts`.

## Shared tables

### `users`

Accounts and roles (ADMIN / SUPERVISOR / CASHIER) with scrypt password hashes.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `username` | TEXT | NOT NULL | — |  |
| `full_name` | TEXT | NOT NULL | — |  |
| `role` | TEXT | NOT NULL | — |  |
| `password_hash` | TEXT | NOT NULL | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `must_change_password` | INTEGER | NOT NULL | `0` |  |
| `last_login_at` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |
| `failed_attempts` | INTEGER | NOT NULL | `0` |  |
| `locked_until` | TEXT | yes | — |  |
| `locked_reason` | TEXT | yes | — |  |
| `password_algo` | TEXT | NOT NULL | `'bcrypt'` |  |
| `email` | TEXT | yes | — |  |

Indexes: `idx_users_locked`

### `roles`

Reserved for custom roles; the three built-in roles live in the users.role CHECK constraint.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `description` | TEXT | yes | — |  |
| `is_system` | INTEGER | NOT NULL | `1` |  |
| `permissions` | TEXT | NOT NULL | `'[]'` |  |
| `created_at` | TEXT | NOT NULL | — |  |

### `settings`

Key/value store: store identity, receipt footer, return limits, licence warning window.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `key` | TEXT | yes | — | PK |
| `value` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

### `audit_log`

Append-only log of sales, voids, returns, price changes, stock counts, logins and denials.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `created_at` | TEXT | NOT NULL | — |  |
| `user_id` | INTEGER | yes | — |  |
| `username` | TEXT | yes | — |  |
| `action` | TEXT | NOT NULL | — |  |
| `entity` | TEXT | yes | — |  |
| `entity_id` | TEXT | yes | — |  |
| `details` | TEXT | yes | — |  |
| `severity` | TEXT | NOT NULL | `'INFO'` |  |

Indexes: `idx_audit_action`, `idx_audit_action_created`, `idx_audit_created`

### `license_state`

Active licence: edition, start/end business dates, HMAC, last-seen stamp and lock reason. Single row (id = 1).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `edition` | TEXT | NOT NULL | — |  |
| `customer_name` | TEXT | NOT NULL | — |  |
| `license_id` | TEXT | NOT NULL | — |  |
| `activation_code` | TEXT | NOT NULL | — |  |
| `issued_at` | TEXT | NOT NULL | — |  |
| `expires_at` | TEXT | NOT NULL | — |  |
| `activated_at` | TEXT | NOT NULL | — |  |
| `activated_by` | TEXT | yes | — |  |
| `note` | TEXT | yes | — |  |
| `starts_on` | TEXT | yes | — |  |
| `ends_on` | TEXT | yes | — |  |
| `hmac` | TEXT | yes | — |  |
| `period_hmac` | TEXT | yes | — |  |
| `signed_at` | TEXT | yes | — |  |
| `renewed_at` | TEXT | yes | — |  |
| `last_seen_at` | TEXT | yes | — |  |
| `last_seen_hmac` | TEXT | yes | — |  |
| `lock_reason` | TEXT | yes | — |  |
| `locked_at` | TEXT | yes | — |  |
| `integrity_algo` | TEXT | NOT NULL | `'hmac-sha256'` |  |

### `license_history`

Append-only history of every licence period, renewal and edition change.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `license_id` | TEXT | NOT NULL | — |  |
| `edition` | TEXT | NOT NULL | — |  |
| `customer_name` | TEXT | NOT NULL | `''` |  |
| `starts_on` | TEXT | NOT NULL | — |  |
| `ends_on` | TEXT | NOT NULL | — |  |
| `action` | TEXT | NOT NULL | — |  |
| `period_hmac` | TEXT | NOT NULL | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `created_by` | TEXT | NOT NULL | `'vendor'` |  |

Indexes: `idx_license_history_created`, `idx_license_history_period`

### `license_attempts`

Master-password attempt outcomes that drive the 30s/1m/5m delay ladder (never stores the typed value).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `created_at` | TEXT | NOT NULL | — |  |
| `outcome` | TEXT | NOT NULL | — |  |
| `failures_after` | INTEGER | NOT NULL | `0` |  |
| `delay_seconds` | INTEGER | NOT NULL | `0` |  |
| `source` | TEXT | NOT NULL | `'vendor'` |  |

Indexes: `idx_license_attempts_created`

### `license_guard`

Per-install random secret used to derive the licence HMAC key.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `secret` | TEXT | NOT NULL | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

### `held_sales`

Parked (held) baskets that can be recalled at the till; payload holds the cart as JSON.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `hold_no` | TEXT | NOT NULL | — |  |
| `label` | TEXT | yes | — |  |
| `payload` | TEXT | NOT NULL | — |  |
| `lines_count` | INTEGER | NOT NULL | `0` |  |
| `total` | INTEGER | NOT NULL | `0` |  |
| `customer_name` | TEXT | yes | — |  |
| `user_id` | INTEGER | NOT NULL | — |  |
| `username` | TEXT | NOT NULL | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_held_sales_created`

### `document_prints`

Every receipt/invoice/credit-note print, layout and DUPLICATE reprint trail.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `sale_id` | INTEGER | NOT NULL | — |  |
| `layout` | TEXT | NOT NULL | — |  |
| `duplicate` | INTEGER | NOT NULL | `0` |  |
| `user_id` | INTEGER | yes | — |  |
| `username` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `return_id` | INTEGER | yes | — |  |
| `kind` | TEXT | NOT NULL | `'SALE'` |  |

Indexes: `idx_document_prints_sale`

### `stock_writeoffs`

Returned goods that cannot be resold (damaged, expired, opened), valued at cost.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `return_id` | INTEGER | yes | — |  |
| `product_id` | INTEGER | NOT NULL | — |  |
| `batch_id` | INTEGER | yes | — |  |
| `batch_no` | TEXT | yes | — |  |
| `qty` | INTEGER | NOT NULL | — |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `value` | INTEGER | NOT NULL | `0` |  |
| `reason_code` | TEXT | NOT NULL | `'OTHER'` |  |
| `reason` | TEXT | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `username` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_writeoffs_product`, `idx_writeoffs_return`

### `categories`

Product categories; products.category keeps a denormalised display name.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `description` | TEXT | yes | — |  |
| `sort_order` | INTEGER | NOT NULL | `0` |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |
| `parent_id` | INTEGER | yes | — |  |

Indexes: `idx_categories_parent`

### `suppliers`

Suppliers used by purchases.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `contact_person` | TEXT | yes | — |  |
| `phone` | TEXT | yes | — |  |
| `email` | TEXT | yes | — |  |
| `address` | TEXT | yes | — |  |
| `notes` | TEXT | yes | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

### `customers`

Customer directory for invoices and credit charges.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `phone` | TEXT | yes | — |  |
| `email` | TEXT | yes | — |  |
| `address` | TEXT | yes | — |  |
| `credit_limit` | INTEGER | NOT NULL | `0` |  |
| `loyalty_member_id` | INTEGER | yes | — |  |
| `notes` | TEXT | yes | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_customers_phone`

### `products`

Catalogue: prices in kobo, stock reorder level, pharmacy and supermarket extension columns.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `sku` | TEXT | NOT NULL | — |  |
| `barcode` | TEXT | yes | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `category` | TEXT | yes | — |  |
| `unit` | TEXT | NOT NULL | `'unit'` |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `price` | INTEGER | NOT NULL | `0` |  |
| `wholesale_price` | INTEGER | NOT NULL | `0` |  |
| `reorder_level` | INTEGER | NOT NULL | `0` |  |
| `requires_prescription` | INTEGER | NOT NULL | `0` |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |
| `generic_name` | TEXT | yes | — |  |
| `category_id` | INTEGER | yes | — |  |
| `supplier_id` | INTEGER | yes | — |  |
| `department_id` | INTEGER | yes | — |  |
| `shelf_location` | TEXT | yes | — |  |
| `plu_code` | TEXT | yes | — |  |
| `price_per_kg` | INTEGER | yes | — |  |
| `is_weighed` | INTEGER | NOT NULL | `0` |  |
| `brand` | TEXT | yes | — |  |
| `pack_size` | INTEGER | NOT NULL | `1` |  |
| `pack_unit` | TEXT | NOT NULL | `'pack'` |  |
| `wholesale_min_qty` | INTEGER | NOT NULL | `1` |  |
| `expiry_tracking` | INTEGER | NOT NULL | `0` |  |

Indexes: `idx_products_barcode`, `idx_products_category`, `idx_products_department`, `idx_products_name`, `idx_products_plu`

### `stock_movements`

Stock ledger: every purchase, sale, return, void and adjustment with reference and user.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `product_id` | INTEGER | NOT NULL | — |  |
| `batch_id` | INTEGER | yes | — |  |
| `qty_change` | INTEGER | NOT NULL | — |  |
| `type` | TEXT | NOT NULL | — |  |
| `ref_type` | TEXT | yes | — |  |
| `ref_id` | INTEGER | yes | — |  |
| `note` | TEXT | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `reason_type` | TEXT | yes | — |  |

Indexes: `idx_moves_product`, `idx_moves_ref`, `idx_moves_type`

### `sales`

Sales and wholesale invoices, with store snapshot and void trail. Never deleted.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `receipt_no` | TEXT | NOT NULL | — |  |
| `doc_type` | TEXT | NOT NULL | `'RECEIPT'` |  |
| `customer_name` | TEXT | yes | — |  |
| `customer_phone` | TEXT | yes | — |  |
| `customer_address` | TEXT | yes | — |  |
| `prescription_ref` | TEXT | yes | — |  |
| `subtotal` | INTEGER | NOT NULL | — |  |
| `discount` | INTEGER | NOT NULL | `0` |  |
| `tax` | INTEGER | NOT NULL | `0` |  |
| `total` | INTEGER | NOT NULL | — |  |
| `amount_paid` | INTEGER | NOT NULL | — |  |
| `change_due` | INTEGER | NOT NULL | `0` |  |
| `payment_method` | TEXT | NOT NULL | — |  |
| `status` | TEXT | NOT NULL | `'COMPLETED'` |  |
| `void_reason` | TEXT | yes | — |  |
| `void_requested_by` | INTEGER | yes | — |  |
| `void_requested_at` | TEXT | yes | — |  |
| `voided_by` | INTEGER | yes | — |  |
| `voided_at` | TEXT | yes | — |  |
| `approved_by` | INTEGER | yes | — |  |
| `price_override_by` | INTEGER | yes | — |  |
| `user_id` | INTEGER | NOT NULL | — |  |
| `username` | TEXT | NOT NULL | — |  |
| `store_name` | TEXT | NOT NULL | — |  |
| `store_address` | TEXT | NOT NULL | — |  |
| `store_phone` | TEXT | NOT NULL | — |  |
| `note` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `customer_id` | INTEGER | yes | — |  |
| `loyalty_member_id` | INTEGER | yes | — |  |
| `shift_id` | INTEGER | yes | — |  |
| `tier` | TEXT | NOT NULL | `'RETAIL'` |  |
| `balance_due` | INTEGER | NOT NULL | `0` |  |
| `promo_discount` | INTEGER | NOT NULL | `0` |  |
| `item_discount` | INTEGER | NOT NULL | `0` |  |
| `loyalty_points` | INTEGER | NOT NULL | `0` |  |
| `loyalty_redeemed` | INTEGER | NOT NULL | `0` |  |
| `loyalty_value` | INTEGER | NOT NULL | `0` |  |
| `vat_rate` | INTEGER | NOT NULL | `0` |  |
| `print_count` | INTEGER | NOT NULL | `0` |  |
| `last_printed_at` | TEXT | yes | — |  |

Indexes: `idx_sales_created`, `idx_sales_customer`, `idx_sales_user`

### `sale_items`

Immutable line snapshots: SKU, name, qty, price, cost, batch.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `sale_id` | INTEGER | NOT NULL | — |  |
| `product_id` | INTEGER | NOT NULL | — |  |
| `sku` | TEXT | NOT NULL | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `qty` | INTEGER | NOT NULL | — |  |
| `unit_price` | INTEGER | NOT NULL | — |  |
| `list_price` | INTEGER | NOT NULL | — |  |
| `cost_price` | INTEGER | NOT NULL | — |  |
| `line_total` | INTEGER | NOT NULL | — |  |
| `batch_id` | INTEGER | yes | — |  |
| `batch_no` | TEXT | yes | — |  |
| `rx_required` | INTEGER | NOT NULL | `0` |  |
| `is_weighed` | INTEGER | NOT NULL | `0` |  |
| `line_discount` | INTEGER | NOT NULL | `0` |  |
| `promotion_id` | INTEGER | yes | — |  |
| `promotion_name` | TEXT | yes | — |  |

Indexes: `idx_sale_items_product`, `idx_sale_items_sale`

### `payments`

One row per money movement against a sale (cash, transfer, POS, split).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `sale_id` | INTEGER | NOT NULL | — |  |
| `method` | TEXT | NOT NULL | — |  |
| `amount` | INTEGER | NOT NULL | — |  |
| `reference` | TEXT | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `shift_id` | INTEGER | yes | — |  |

Indexes: `idx_payments_created`, `idx_payments_sale`, `idx_payments_shift`

### `returns`

Returns/credit notes with approval state and store snapshot.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `credit_note_no` | TEXT | yes | — |  |
| `sale_id` | INTEGER | NOT NULL | — |  |
| `customer_name` | TEXT | yes | — |  |
| `reason` | TEXT | NOT NULL | — |  |
| `total` | INTEGER | NOT NULL | — |  |
| `status` | TEXT | NOT NULL | — |  |
| `requested_by` | INTEGER | NOT NULL | — |  |
| `requested_at` | TEXT | NOT NULL | — |  |
| `approved_by` | INTEGER | yes | — |  |
| `approved_at` | TEXT | yes | — |  |
| `reject_reason` | TEXT | yes | — |  |
| `store_name` | TEXT | NOT NULL | — |  |
| `store_address` | TEXT | NOT NULL | — |  |
| `store_phone` | TEXT | NOT NULL | — |  |
| `return_type` | TEXT | NOT NULL | `'REFUND'` |  |
| `reason_code` | TEXT | NOT NULL | `'OTHER'` |  |
| `sale_receipt_no` | TEXT | yes | — |  |
| `refund_method` | TEXT | yes | — |  |
| `exchange_note` | TEXT | yes | — |  |
| `discount_reversed` | INTEGER | NOT NULL | `0` |  |
| `promo_reversed` | INTEGER | NOT NULL | `0` |  |
| `loyalty_points_reversed` | INTEGER | NOT NULL | `0` |  |
| `loyalty_value_reversed` | INTEGER | NOT NULL | `0` |  |
| `window_override` | INTEGER | NOT NULL | `0` |  |
| `approved_via` | TEXT | yes | — |  |

Indexes: `idx_returns_credit_note`, `idx_returns_sale`, `idx_returns_status`

### `return_items`

Returned quantities per sale line, with restock flag.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `return_id` | INTEGER | NOT NULL | — |  |
| `sale_item_id` | INTEGER | NOT NULL | — |  |
| `product_id` | INTEGER | NOT NULL | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `qty` | INTEGER | NOT NULL | — |  |
| `unit_price` | INTEGER | NOT NULL | — |  |
| `line_total` | INTEGER | NOT NULL | — |  |
| `batch_id` | INTEGER | yes | — |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `restock` | INTEGER | NOT NULL | `1` |  |
| `reason_code` | TEXT | NOT NULL | `'OTHER'` |  |
| `resellable` | INTEGER | NOT NULL | `1` |  |
| `net_total` | INTEGER | NOT NULL | `0` |  |
| `writeoff_id` | INTEGER | yes | — |  |

Indexes: `idx_return_items_return`

### `purchases`

Supplier purchase headers (received stock).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `purchase_no` | TEXT | NOT NULL | — |  |
| `supplier_id` | INTEGER | yes | — |  |
| `supplier_name` | TEXT | yes | — |  |
| `invoice_no` | TEXT | yes | — |  |
| `purchase_date` | TEXT | NOT NULL | — |  |
| `subtotal` | INTEGER | NOT NULL | `0` |  |
| `discount` | INTEGER | NOT NULL | `0` |  |
| `total` | INTEGER | NOT NULL | `0` |  |
| `amount_paid` | INTEGER | NOT NULL | `0` |  |
| `status` | TEXT | NOT NULL | `'RECEIVED'` |  |
| `note` | TEXT | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `username` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `grn_no` | TEXT | yes | — |  |
| `received_at` | TEXT | yes | — |  |
| `ordered_at` | TEXT | yes | — |  |

Indexes: `idx_purchases_date`, `idx_purchases_supplier`

### `purchase_items`

Purchase lines with batch and expiry for receiving.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `purchase_id` | INTEGER | NOT NULL | — |  |
| `product_id` | INTEGER | NOT NULL | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `qty` | INTEGER | NOT NULL | — |  |
| `cost_price` | INTEGER | NOT NULL | — |  |
| `line_total` | INTEGER | NOT NULL | — |  |
| `batch_no` | TEXT | yes | — |  |
| `expiry_date` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_purchase_items_purchase`

### `day_closings`

End-of-day cash reconciliation, one row per business date.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `business_date` | TEXT | NOT NULL | — |  |
| `opened_at` | TEXT | NOT NULL | — |  |
| `closed_at` | TEXT | yes | — |  |
| `opening_float` | INTEGER | NOT NULL | `0` |  |
| `cash_sales` | INTEGER | NOT NULL | `0` |  |
| `transfer_sales` | INTEGER | NOT NULL | `0` |  |
| `pos_sales` | INTEGER | NOT NULL | `0` |  |
| `other_sales` | INTEGER | NOT NULL | `0` |  |
| `returns_total` | INTEGER | NOT NULL | `0` |  |
| `expected_cash` | INTEGER | NOT NULL | `0` |  |
| `counted_cash` | INTEGER | NOT NULL | `0` |  |
| `variance` | INTEGER | NOT NULL | `0` |  |
| `sales_count` | INTEGER | NOT NULL | `0` |  |
| `closed_by` | INTEGER | yes | — |  |
| `closed_by_name` | TEXT | yes | — |  |
| `note` | TEXT | yes | — |  |

### `counters`

Atomic document sequences (RCP, INV, CN, SKU, PUR).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `name` | TEXT | yes | — | PK |
| `value` | INTEGER | NOT NULL | — |  |

### `sessions_meta`

Reserved internal metadata (installation notes); no business data.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `key` | TEXT | yes | — | PK |
| `value` | TEXT | NOT NULL | — |  |

### `demo_data`

Register of rows created by "Load demo data", so they can be removed again in one step.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `entity` | TEXT | NOT NULL | — | PK |
| `entity_id` | INTEGER | NOT NULL | — | PK |
| `created_at` | TEXT | NOT NULL | — |  |

## Pharmacy module tables

### `product_batches`

Batch/expiry stock engine (batch no, expiry, qty, cost). Supermarket uses a single DEFAULT batch.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `product_id` | INTEGER | NOT NULL | — |  |
| `batch_no` | TEXT | NOT NULL | — |  |
| `expiry_date` | TEXT | yes | — |  |
| `qty` | INTEGER | NOT NULL | `0` |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_batches_expiry`, `idx_batches_product`, `idx_batches_unique`

## Supermarket module tables

### `stock_counts`

Stocktake header: draft/posted counts with variance totals.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `count_no` | TEXT | NOT NULL | — |  |
| `status` | TEXT | NOT NULL | `'DRAFT'` |  |
| `scope` | TEXT | NOT NULL | `'ALL'` |  |
| `note` | TEXT | yes | — |  |
| `items_counted` | INTEGER | NOT NULL | `0` |  |
| `variance_qty` | INTEGER | NOT NULL | `0` |  |
| `variance_value` | INTEGER | NOT NULL | `0` |  |
| `created_by` | INTEGER | yes | — |  |
| `username` | TEXT | NOT NULL | — |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `posted_at` | TEXT | yes | — |  |
| `posted_by` | TEXT | yes | — |  |

Indexes: `idx_stock_counts_created`

### `stock_count_items`

Counted quantity per product/batch with the system quantity and variance.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `count_id` | INTEGER | NOT NULL | — |  |
| `product_id` | INTEGER | NOT NULL | — |  |
| `batch_id` | INTEGER | yes | — |  |
| `sku` | TEXT | NOT NULL | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `system_qty` | INTEGER | NOT NULL | — |  |
| `counted_qty` | INTEGER | yes | — |  |
| `variance` | INTEGER | NOT NULL | `0` |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_stock_count_items_count`

### `departments`

Store departments (aisles/brands) used for grouping and price rules.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `description` | TEXT | yes | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

### `promotions`

Percent/amount/BOGO/multibuy promotions with validity window.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `promo_type` | TEXT | NOT NULL | — |  |
| `value` | INTEGER | NOT NULL | `0` |  |
| `product_id` | INTEGER | yes | — |  |
| `category_id` | INTEGER | yes | — |  |
| `department_id` | INTEGER | yes | — |  |
| `min_qty` | INTEGER | NOT NULL | `1` |  |
| `starts_at` | TEXT | yes | — |  |
| `ends_at` | TEXT | yes | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_promotions_product`

### `price_rules`

Price overrides by product/category/department, with supervisor flag.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `name` | TEXT | NOT NULL | — |  |
| `scope` | TEXT | NOT NULL | — |  |
| `product_id` | INTEGER | yes | — |  |
| `category_id` | INTEGER | yes | — |  |
| `department_id` | INTEGER | yes | — |  |
| `rule_type` | TEXT | NOT NULL | — |  |
| `value` | INTEGER | NOT NULL | `0` |  |
| `min_qty` | INTEGER | NOT NULL | `1` |  |
| `starts_at` | TEXT | yes | — |  |
| `ends_at` | TEXT | yes | — |  |
| `requires_supervisor` | INTEGER | NOT NULL | `1` |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

### `loyalty_members`

Loyalty member records with points balance.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `member_no` | TEXT | NOT NULL | — |  |
| `name` | TEXT | NOT NULL | — |  |
| `phone` | TEXT | yes | — |  |
| `email` | TEXT | yes | — |  |
| `points` | INTEGER | NOT NULL | `0` |  |
| `joined_at` | TEXT | NOT NULL | — |  |
| `active` | INTEGER | NOT NULL | `1` |  |

Indexes: `idx_loyalty_phone`

### `loyalty_transactions`

Points earned/redeemed against a member and sale.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `member_id` | INTEGER | NOT NULL | — |  |
| `sale_id` | INTEGER | yes | — |  |
| `points_change` | INTEGER | NOT NULL | — |  |
| `reason` | TEXT | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_loyalty_tx_member`

### `cashier_shifts`

Cashier shift open/close with float, expected cash and variance.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `user_id` | INTEGER | NOT NULL | — |  |
| `username` | TEXT | NOT NULL | — |  |
| `opened_at` | TEXT | NOT NULL | — |  |
| `closed_at` | TEXT | yes | — |  |
| `opening_float` | INTEGER | NOT NULL | `0` |  |
| `counted_cash` | INTEGER | yes | — |  |
| `expected_cash` | INTEGER | NOT NULL | `0` |  |
| `variance` | INTEGER | NOT NULL | `0` |  |
| `status` | TEXT | NOT NULL | `'OPEN'` |  |
| `note` | TEXT | yes | — |  |

Indexes: `idx_shifts_user`

### `cash_drawer_events`

Drawer open, no-sale, paid-in, paid-out and close events.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `shift_id` | INTEGER | yes | — |  |
| `user_id` | INTEGER | yes | — |  |
| `username` | TEXT | yes | — |  |
| `event_type` | TEXT | NOT NULL | — |  |
| `amount` | INTEGER | NOT NULL | `0` |  |
| `reason` | TEXT | yes | — |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_drawer_shift`

### `product_barcodes`

Multiple barcodes per product (pack sizes).

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `product_id` | INTEGER | NOT NULL | — |  |
| `barcode` | TEXT | NOT NULL | — |  |
| `pack_qty` | INTEGER | NOT NULL | `1` |  |
| `is_primary` | INTEGER | NOT NULL | `0` |  |
| `created_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_product_barcodes_product`

### `product_variants`

Product variants (size/flavour) with their own SKU, barcode and price.

| Column | Type | Null | Default | Key |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | yes | — | PK |
| `product_id` | INTEGER | NOT NULL | — |  |
| `variant_name` | TEXT | NOT NULL | — |  |
| `sku` | TEXT | NOT NULL | — |  |
| `barcode` | TEXT | yes | — |  |
| `price` | INTEGER | NOT NULL | `0` |  |
| `cost_price` | INTEGER | NOT NULL | `0` |  |
| `stock_qty` | INTEGER | NOT NULL | `0` |  |
| `active` | INTEGER | NOT NULL | `1` |  |
| `created_at` | TEXT | NOT NULL | — |  |
| `updated_at` | TEXT | NOT NULL | — |  |

Indexes: `idx_product_variants_product`

## Edition-specific columns

These columns live on shared tables but only carry data in the edition that owns them.

| Table | Column | Owner | Notes |
| --- | --- | --- | --- |
| `products` | `generic_name` | pharmacy | Generic (INN) name shown on dispensing screens. |
| `products` | `requires_prescription` | pharmacy | Sale blocked unless a prescription reference is captured. |
| `products` | `department_id` | supermarket | Links a product to a store department. |
| `products` | `shelf_location` | supermarket | Aisle/bay/shelf label. |
| `products` | `plu_code` | supermarket | PLU for weighed items (scale label). |
| `products` | `price_per_kg` | supermarket | Kobo per kilogram for weighed items. |
| `products` | `is_weighed` | supermarket | Item is sold by weight. |
| `sales` | `loyalty_member_id` | supermarket | Loyalty member attached to the sale. |
| `sales` | `shift_id` | supermarket | Cashier shift that produced the sale. |
| `product_batches` | `expiry_date` | pharmacy | FEFO selling and expiry alerts. |

## Migrations

`src/db/migrations.ts` holds an append-only list. On startup `migrate()` reads `PRAGMA user_version`,
applies every newer migration inside a transaction (rollback on error) and bumps the version.

| Version | Name |
| --- | --- |
| 1 | initial |
| 2 | shared_catalogue_partners_documents_and_edition_modules |
| 3 | account_lockout_store_profile_and_idle_policy |
| 4 | licence_periods_hmac_and_attempt_throttle |
| 5 | product_packs_brands_stock_counts_and_grn |
| 6 | pos_credit_promotions_and_receipts |
| 7 | returns_reasons_refunds_and_writeoffs |
| 8 | demo_data_register |

To add a migration: append a `{ version, name, sql }` entry, add any new table/column to
`src/db/schema.ts`, run `npm run db:verify` (writes and reads a row in every table, checks the
manifest against the database) and `npm run db:schema` to refresh this page.

### Counting rows

```sql
-- what a shop actually has
SELECT 'sales', COUNT(*) FROM sales UNION ALL SELECT 'products', COUNT(*) FROM products;
```

_39 tables documented; generated 2026-10-31T11:47:31.790Z by scripts/gen-schema-doc.ts._
