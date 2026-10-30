import type { Database } from '../index';
import { Table } from './base';

/* ------------------------------------------------------------------ */
/* Row types (mirror the migration columns exactly)                    */
/* ------------------------------------------------------------------ */

export interface UserRow {
  id: number; username: string; full_name: string; role: 'ADMIN' | 'SUPERVISOR' | 'CASHIER';
  password_hash: string; active: number; must_change_password: number; last_login_at: string | null;
  created_at: string; updated_at: string;
}
export interface RoleRow { id: number; name: string; description: string | null; is_system: number; permissions: string; created_at: string; }
export interface SettingRow { key: string; value: string; updated_at: string; }
export interface AuditRow {
  id: number; created_at: string; user_id: number | null; username: string | null; action: string;
  entity: string | null; entity_id: string | null; details: string | null; severity: string;
}
export interface LicenseStateRow {
  id: number; edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH'; customer_name: string; license_id: string;
  activation_code: string; issued_at: string; expires_at: string; activated_at: string;
  activated_by: string | null; note: string | null;
}
export interface CategoryRow {
  id: number; name: string; description: string | null; sort_order: number; active: number;
  created_at: string; updated_at: string;
}
export interface SupplierRow {
  id: number; name: string; contact_person: string | null; phone: string | null; email: string | null;
  address: string | null; notes: string | null; active: number; created_at: string; updated_at: string;
}
export interface CustomerRow {
  id: number; name: string; phone: string | null; email: string | null; address: string | null;
  credit_limit: number; loyalty_member_id: number | null; notes: string | null; active: number;
  created_at: string; updated_at: string;
}
export interface ProductRow {
  id: number; sku: string; barcode: string | null; name: string; category: string | null;
  unit: string; cost_price: number; price: number; wholesale_price: number; reorder_level: number;
  requires_prescription: number; active: number; created_at: string; updated_at: string;
  generic_name: string | null; category_id: number | null; supplier_id: number | null;
  department_id: number | null; shelf_location: string | null; plu_code: string | null;
  price_per_kg: number | null; is_weighed: number;
}
export interface ProductBatchRow {
  id: number; product_id: number; batch_no: string; expiry_date: string | null; qty: number;
  cost_price: number; created_at: string; updated_at: string;
}
export interface StockMovementRow {
  id: number; product_id: number; batch_id: number | null; qty_change: number; type: string;
  ref_type: string | null; ref_id: number | null; note: string | null; user_id: number | null; created_at: string;
}
export interface SaleRow {
  id: number; receipt_no: string; doc_type: string; customer_name: string | null; customer_phone: string | null;
  customer_address: string | null; prescription_ref: string | null; subtotal: number; discount: number;
  tax: number; total: number; amount_paid: number; change_due: number; payment_method: string;
  status: 'COMPLETED' | 'VOIDED'; void_reason: string | null; void_requested_by: number | null;
  void_requested_at: string | null; voided_by: number | null; voided_at: string | null;
  approved_by: number | null; price_override_by: number | null; user_id: number; username: string;
  store_name: string; store_address: string; store_phone: string; note: string | null; created_at: string;
  customer_id: number | null; loyalty_member_id: number | null; shift_id: number | null;
}
export interface SaleItemRow {
  id: number; sale_id: number; product_id: number; sku: string; name: string; qty: number;
  unit_price: number; list_price: number; cost_price: number; line_total: number;
  batch_id: number | null; batch_no: string | null; rx_required: number;
}
export interface PaymentRow {
  id: number; sale_id: number; method: string; amount: number; reference: string | null;
  user_id: number | null; created_at: string;
}
export interface ReturnRow {
  id: number; credit_note_no: string | null; sale_id: number; customer_name: string | null;
  reason: string; total: number; status: 'PENDING' | 'COMPLETED' | 'REJECTED';
  requested_by: number; requested_at: string; approved_by: number | null; approved_at: string | null;
  reject_reason: string | null; store_name: string; store_address: string; store_phone: string;
}
export interface ReturnItemRow {
  id: number; return_id: number; sale_item_id: number; product_id: number; name: string; qty: number;
  unit_price: number; line_total: number; batch_id: number | null; cost_price: number; restock: number;
}
export interface PurchaseRow {
  id: number; purchase_no: string; supplier_id: number | null; supplier_name: string | null;
  invoice_no: string | null; purchase_date: string; subtotal: number; discount: number; total: number;
  amount_paid: number; status: 'DRAFT' | 'RECEIVED' | 'CANCELLED'; note: string | null;
  user_id: number | null; username: string | null; created_at: string;
}
export interface PurchaseItemRow {
  id: number; purchase_id: number; product_id: number; name: string; qty: number; cost_price: number;
  line_total: number; batch_no: string | null; expiry_date: string | null; created_at: string;
}
export interface DayClosingRow {
  id: number; business_date: string; opened_at: string; closed_at: string | null;
  opening_float: number; cash_sales: number; transfer_sales: number; pos_sales: number;
  other_sales: number; returns_total: number; expected_cash: number; counted_cash: number;
  variance: number; sales_count: number; closed_by: number | null; closed_by_name: string | null;
  note: string | null;
}
export interface CounterRow { name: string; value: number; }
export interface SessionMetaRow { key: string; value: string; }
export interface DepartmentRow {
  id: number; name: string; description: string | null; active: number; created_at: string; updated_at: string;
}
export interface PromotionRow {
  id: number; name: string; promo_type: 'PERCENT' | 'AMOUNT' | 'BOGO' | 'MULTIBUY'; value: number;
  product_id: number | null; category_id: number | null; department_id: number | null; min_qty: number;
  starts_at: string | null; ends_at: string | null; active: number; created_at: string; updated_at: string;
}
export interface PriceRuleRow {
  id: number; name: string; scope: 'PRODUCT' | 'CATEGORY' | 'DEPARTMENT';
  product_id: number | null; category_id: number | null; department_id: number | null;
  rule_type: 'DISCOUNT_PERCENT' | 'DISCOUNT_AMOUNT' | 'SET_PRICE'; value: number; min_qty: number;
  starts_at: string | null; ends_at: string | null; requires_supervisor: number; active: number;
  created_at: string; updated_at: string;
}
export interface LoyaltyMemberRow {
  id: number; member_no: string; name: string; phone: string | null; email: string | null;
  points: number; joined_at: string; active: number;
}
export interface LoyaltyTransactionRow {
  id: number; member_id: number; sale_id: number | null; points_change: number;
  reason: string | null; user_id: number | null; created_at: string;
}
export interface CashierShiftRow {
  id: number; user_id: number; username: string; opened_at: string; closed_at: string | null;
  opening_float: number; counted_cash: number | null; expected_cash: number; variance: number;
  status: 'OPEN' | 'CLOSED'; note: string | null;
}
export interface CashDrawerEventRow {
  id: number; shift_id: number | null; user_id: number | null; username: string | null;
  event_type: 'OPEN' | 'NO_SALE' | 'PAID_IN' | 'PAID_OUT' | 'CLOSE'; amount: number;
  reason: string | null; created_at: string;
}
export interface ProductBarcodeRow {
  id: number; product_id: number; barcode: string; pack_qty: number; is_primary: number; created_at: string;
}
export interface ProductVariantRow {
  id: number; product_id: number; variant_name: string; sku: string; barcode: string | null;
  price: number; cost_price: number; stock_qty: number; active: number; created_at: string; updated_at: string;
}

/* ------------------------------------------------------------------ */
/* Table bindings                                                      */
/* ------------------------------------------------------------------ */

const P = <T extends object>(columns: (keyof T & string)[]) => columns;

export interface Repositories {
  users: Table<UserRow>;
  roles: Table<RoleRow>;
  settings: Table<SettingRow>;
  audit: Table<AuditRow>;
  license: Table<LicenseStateRow>;
  categories: Table<CategoryRow>;
  suppliers: Table<SupplierRow>;
  customers: Table<CustomerRow>;
  products: Table<ProductRow>;
  productBatches: Table<ProductBatchRow>;
  stockMovements: Table<StockMovementRow>;
  sales: Table<SaleRow>;
  saleItems: Table<SaleItemRow>;
  payments: Table<PaymentRow>;
  returns: Table<ReturnRow>;
  returnItems: Table<ReturnItemRow>;
  purchases: Table<PurchaseRow>;
  purchaseItems: Table<PurchaseItemRow>;
  dayClosings: Table<DayClosingRow>;
  counters: Table<CounterRow>;
  sessionsMeta: Table<SessionMetaRow>;
  departments: Table<DepartmentRow>;
  promotions: Table<PromotionRow>;
  priceRules: Table<PriceRuleRow>;
  loyaltyMembers: Table<LoyaltyMemberRow>;
  loyaltyTransactions: Table<LoyaltyTransactionRow>;
  shifts: Table<CashierShiftRow>;
  drawerEvents: Table<CashDrawerEventRow>;
  productBarcodes: Table<ProductBarcodeRow>;
  productVariants: Table<ProductVariantRow>;
}

/**
 * Builds the typed data-access layer for a database handle. Cheap: it only
 * captures the connection, statements are prepared on first use.
 */
export function createRepositories(db: Database): Repositories {
  return {
    users: new Table<UserRow>(db, {
      table: 'users',
      columns: P<UserRow>(['id', 'username', 'full_name', 'role', 'password_hash', 'active', 'must_change_password', 'last_login_at', 'created_at', 'updated_at']),
      orderBy: 'username'
    }),
    roles: new Table<RoleRow>(db, { table: 'roles', columns: P<RoleRow>(['id', 'name', 'description', 'is_system', 'permissions', 'created_at']), orderBy: 'name' }),
    settings: new Table<SettingRow>(db, {
      table: 'settings',
      columns: P<SettingRow>(['key', 'value', 'updated_at']),
      primaryKey: 'key',
      orderBy: 'key'
    }),
    audit: new Table<AuditRow>(db, {
      table: 'audit_log',
      columns: P<AuditRow>(['id', 'created_at', 'user_id', 'username', 'action', 'entity', 'entity_id', 'details', 'severity']),
      orderBy: 'id DESC'
    }),
    license: new Table<LicenseStateRow>(db, {
      table: 'license_state',
      columns: P<LicenseStateRow>(['id', 'edition', 'customer_name', 'license_id', 'activation_code', 'issued_at', 'expires_at', 'activated_at', 'activated_by', 'note'])
    }),
    categories: new Table<CategoryRow>(db, {
      table: 'categories',
      columns: P<CategoryRow>(['id', 'name', 'description', 'sort_order', 'active', 'created_at', 'updated_at']),
      orderBy: 'sort_order, name'
    }),
    suppliers: new Table<SupplierRow>(db, {
      table: 'suppliers',
      columns: P<SupplierRow>(['id', 'name', 'contact_person', 'phone', 'email', 'address', 'notes', 'active', 'created_at', 'updated_at']),
      orderBy: 'name'
    }),
    customers: new Table<CustomerRow>(db, {
      table: 'customers',
      columns: P<CustomerRow>(['id', 'name', 'phone', 'email', 'address', 'credit_limit', 'loyalty_member_id', 'notes', 'active', 'created_at', 'updated_at']),
      orderBy: 'name'
    }),
    products: new Table<ProductRow>(db, {
      table: 'products',
      columns: P<ProductRow>(['id', 'sku', 'barcode', 'name', 'category', 'unit', 'cost_price', 'price', 'wholesale_price', 'reorder_level', 'requires_prescription', 'active', 'created_at', 'updated_at', 'generic_name', 'category_id', 'supplier_id', 'department_id', 'shelf_location', 'plu_code', 'price_per_kg', 'is_weighed']),
      orderBy: 'name'
    }),
    productBatches: new Table<ProductBatchRow>(db, {
      table: 'product_batches',
      columns: P<ProductBatchRow>(['id', 'product_id', 'batch_no', 'expiry_date', 'qty', 'cost_price', 'created_at', 'updated_at']),
      orderBy: 'expiry_date, id'
    }),
    stockMovements: new Table<StockMovementRow>(db, {
      table: 'stock_movements',
      columns: P<StockMovementRow>(['id', 'product_id', 'batch_id', 'qty_change', 'type', 'ref_type', 'ref_id', 'note', 'user_id', 'created_at']),
      orderBy: 'id DESC'
    }),
    sales: new Table<SaleRow>(db, {
      table: 'sales',
      columns: P<SaleRow>(['id', 'receipt_no', 'doc_type', 'customer_name', 'customer_phone', 'customer_address', 'prescription_ref', 'subtotal', 'discount', 'tax', 'total', 'amount_paid', 'change_due', 'payment_method', 'status', 'void_reason', 'void_requested_by', 'void_requested_at', 'voided_by', 'voided_at', 'approved_by', 'price_override_by', 'user_id', 'username', 'store_name', 'store_address', 'store_phone', 'note', 'created_at', 'customer_id', 'loyalty_member_id', 'shift_id']),
      orderBy: 'id DESC'
    }),
    saleItems: new Table<SaleItemRow>(db, {
      table: 'sale_items',
      columns: P<SaleItemRow>(['id', 'sale_id', 'product_id', 'sku', 'name', 'qty', 'unit_price', 'list_price', 'cost_price', 'line_total', 'batch_id', 'batch_no', 'rx_required']),
      orderBy: 'id'
    }),
    payments: new Table<PaymentRow>(db, {
      table: 'payments',
      columns: P<PaymentRow>(['id', 'sale_id', 'method', 'amount', 'reference', 'user_id', 'created_at']),
      orderBy: 'id'
    }),
    returns: new Table<ReturnRow>(db, {
      table: 'returns',
      columns: P<ReturnRow>(['id', 'credit_note_no', 'sale_id', 'customer_name', 'reason', 'total', 'status', 'requested_by', 'requested_at', 'approved_by', 'approved_at', 'reject_reason', 'store_name', 'store_address', 'store_phone']),
      orderBy: 'id DESC'
    }),
    returnItems: new Table<ReturnItemRow>(db, {
      table: 'return_items',
      columns: P<ReturnItemRow>(['id', 'return_id', 'sale_item_id', 'product_id', 'name', 'qty', 'unit_price', 'line_total', 'batch_id', 'cost_price', 'restock']),
      orderBy: 'id'
    }),
    purchases: new Table<PurchaseRow>(db, {
      table: 'purchases',
      columns: P<PurchaseRow>(['id', 'purchase_no', 'supplier_id', 'supplier_name', 'invoice_no', 'purchase_date', 'subtotal', 'discount', 'total', 'amount_paid', 'status', 'note', 'user_id', 'username', 'created_at']),
      orderBy: 'id DESC'
    }),
    purchaseItems: new Table<PurchaseItemRow>(db, {
      table: 'purchase_items',
      columns: P<PurchaseItemRow>(['id', 'purchase_id', 'product_id', 'name', 'qty', 'cost_price', 'line_total', 'batch_no', 'expiry_date', 'created_at']),
      orderBy: 'id'
    }),
    dayClosings: new Table<DayClosingRow>(db, {
      table: 'day_closings',
      columns: P<DayClosingRow>(['id', 'business_date', 'opened_at', 'closed_at', 'opening_float', 'cash_sales', 'transfer_sales', 'pos_sales', 'other_sales', 'returns_total', 'expected_cash', 'counted_cash', 'variance', 'sales_count', 'closed_by', 'closed_by_name', 'note']),
      orderBy: 'business_date DESC'
    }),
    counters: new Table<CounterRow>(db, { table: 'counters', columns: P<CounterRow>(['name', 'value']), primaryKey: 'name', orderBy: 'name' }),
    sessionsMeta: new Table<SessionMetaRow>(db, {
      table: 'sessions_meta',
      columns: P<SessionMetaRow>(['key', 'value']),
      primaryKey: 'key',
      orderBy: 'key'
    }),
    departments: new Table<DepartmentRow>(db, {
      table: 'departments',
      columns: P<DepartmentRow>(['id', 'name', 'description', 'active', 'created_at', 'updated_at']),
      orderBy: 'name'
    }),
    promotions: new Table<PromotionRow>(db, {
      table: 'promotions',
      columns: P<PromotionRow>(['id', 'name', 'promo_type', 'value', 'product_id', 'category_id', 'department_id', 'min_qty', 'starts_at', 'ends_at', 'active', 'created_at', 'updated_at']),
      orderBy: 'id DESC'
    }),
    priceRules: new Table<PriceRuleRow>(db, {
      table: 'price_rules',
      columns: P<PriceRuleRow>(['id', 'name', 'scope', 'product_id', 'category_id', 'department_id', 'rule_type', 'value', 'min_qty', 'starts_at', 'ends_at', 'requires_supervisor', 'active', 'created_at', 'updated_at']),
      orderBy: 'id DESC'
    }),
    loyaltyMembers: new Table<LoyaltyMemberRow>(db, {
      table: 'loyalty_members',
      columns: P<LoyaltyMemberRow>(['id', 'member_no', 'name', 'phone', 'email', 'points', 'joined_at', 'active']),
      orderBy: 'name'
    }),
    loyaltyTransactions: new Table<LoyaltyTransactionRow>(db, {
      table: 'loyalty_transactions',
      columns: P<LoyaltyTransactionRow>(['id', 'member_id', 'sale_id', 'points_change', 'reason', 'user_id', 'created_at']),
      orderBy: 'id DESC'
    }),
    shifts: new Table<CashierShiftRow>(db, {
      table: 'cashier_shifts',
      columns: P<CashierShiftRow>(['id', 'user_id', 'username', 'opened_at', 'closed_at', 'opening_float', 'counted_cash', 'expected_cash', 'variance', 'status', 'note']),
      orderBy: 'id DESC'
    }),
    drawerEvents: new Table<CashDrawerEventRow>(db, {
      table: 'cash_drawer_events',
      columns: P<CashDrawerEventRow>(['id', 'shift_id', 'user_id', 'username', 'event_type', 'amount', 'reason', 'created_at']),
      orderBy: 'id DESC'
    }),
    productBarcodes: new Table<ProductBarcodeRow>(db, {
      table: 'product_barcodes',
      columns: P<ProductBarcodeRow>(['id', 'product_id', 'barcode', 'pack_qty', 'is_primary', 'created_at']),
      orderBy: 'product_id, is_primary DESC, id'
    }),
    productVariants: new Table<ProductVariantRow>(db, {
      table: 'product_variants',
      columns: P<ProductVariantRow>(['id', 'product_id', 'variant_name', 'sku', 'barcode', 'price', 'cost_price', 'stock_qty', 'active', 'created_at', 'updated_at']),
      orderBy: 'product_id, variant_name'
    })
  };
}

/** Lazily created per-database repository cache. */
const cache = new WeakMap<Database, Repositories>();

export function repositoriesFor(db: Database): Repositories {
  let repos = cache.get(db);
  if (!repos) {
    repos = createRepositories(db);
    cache.set(db, repos);
  }
  return repos;
}

export { Table, bool, num, text } from './base';
export type { DbRow, TableConfig } from './base';
