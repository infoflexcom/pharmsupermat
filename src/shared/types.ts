/**
 * Shared domain contracts used by the main process, the renderer and the
 * dev harness. No Electron / Node imports allowed here.
 */

export type Edition = 'PHARMACY' | 'SUPERMARKET' | 'BOTH';

export type Role = 'ADMIN' | 'SUPERVISOR' | 'CASHIER';

export type Money = number; // integer kobo (1 naira = 100 kobo)

export type PaymentMethod = 'CASH' | 'TRANSFER' | 'POS' | 'SPLIT';

export type DocType = 'RECEIPT' | 'INVOICE';

export type SaleStatus = 'COMPLETED' | 'VOIDED';

export type ReturnStatus = 'PENDING' | 'COMPLETED' | 'REJECTED';

export type StockMoveType =
  | 'PURCHASE'
  | 'SALE'
  | 'SALE_VOID'
  | 'RETURN'
  | 'ADJUSTMENT'
  | 'OPENING';

/* ------------------------------------------------------------------ */
/* Feature flags                                                       */
/* ------------------------------------------------------------------ */

export interface FeatureFlags {
  edition: Edition;
  /** Pharmacy-only inventory behaviour (batches, expiry, FEFO). */
  pharmacy: boolean;
  /** Supermarket-only workflows (supervisor role, price override approval). */
  supermarket: boolean;
  /** Wholesale invoices are available in both editions. */
  wholesale: boolean;
  /** Pharmacy: sales may require a prescription reference. */
  prescriptions: boolean;
  /** Display helper: product label for the active edition. */
  itemLabel: 'Drug' | 'Product' | 'Item';
  productName: string;
}

export interface AppState {
  productName: string;
  features: FeatureFlags;
  license: LicenseStatus;
  setup: SetupStatus;
  session: SessionInfo | null;
  version: string;
  /** Customer's store name — shown on the login screen and in the header. */
  storeName: string | null;
  /** Minutes of inactivity before the main process ends the session. */
  idleTimeoutMinutes: number;
}

export interface SetupStatus {
  licensed: boolean;
  storeConfigured: boolean;
  adminConfigured: boolean;
  setupRequired: boolean;
  /** Label for the store-name field, worded for the active edition. */
  storeNameLabel: string;
}

/** Everything the first-run setup screen sends, saved in one transaction. */
export interface CompleteSetupInput {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeEmail?: string;
  storeLicenceNo?: string;
  storeVatNo?: string;
  /** Data URL of the store's own logo (optional, <= 200 KB). */
  storeLogo?: string | null;
  receiptFooter?: string;
  thankYouNote?: string;
  idleTimeoutMinutes?: number;
  adminUsername: string;
  adminFullName: string;
  adminEmail?: string;
  adminPassword: string;
}

export interface SessionInfo {
  token: string;
  userId: number;
  username: string;
  fullName: string;
  role: Role;
  permissions: string[];
  mustChangePassword: boolean;
  storeName: string;
}

/* ------------------------------------------------------------------ */
/* Licensing                                                           */
/* ------------------------------------------------------------------ */

export type LicenseState = 'NONE' | 'VALID' | 'EXPIRING' | 'EXPIRED' | 'INVALID';

export interface LicenseStatus {
  state: LicenseState;
  edition: Edition | null;
  customerName: string | null;
  issuedAt: string | null;
  expiresAt: string | null;
  daysRemaining: number | null;
  features: FeatureFlags | null;
  productName: string;
  message?: string;
}

export interface LicensePayload {
  v: 1;
  licenseId: string;
  edition: Edition;
  customerName: string;
  issuedAt: string; // ISO date-time
  expiresAt: string; // ISO date-time (23:59:59 local)
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Store + settings                                                    */
/* ------------------------------------------------------------------ */

export interface StoreProfile {
  storeName: string;
  storeAddress: string;
  storePhone: string;
  /** Pharmacy: PCN/NAFDAC number. Supermarket: business registration. Optional. */
  storeLicenceNo: string;
  storeVatNo: string;
  storeEmail: string;
  /** Data URL of the shop's own logo, printed on its documents. Empty when none. */
  storeLogo: string;
  receiptFooter: string;
  /** Thank-you line printed at the foot of a receipt. */
  thankYouNote: string;
  returnLimit: Money;
  returnWindowDays: number;
  lowStockAlerts: boolean;
}

export interface SettingsPayload extends StoreProfile {
  licenseExpiryWarningDays: number;
  /** Auto sign-out after this many minutes without activity (1-720). */
  idleTimeoutMinutes: number;
}

/* ------------------------------------------------------------------ */
/* Products / stock                                                    */
/* ------------------------------------------------------------------ */

export interface Product {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  category: string | null;
  unit: string;
  costPrice: Money;
  price: Money;
  wholesalePrice: Money;
  reorderLevel: number;
  rxRequired: boolean;
  active: boolean;
  stockQty: number;
  /** Nearest expiry across batches (pharmacy edition). */
  nearestExpiry: string | null;
  /* ---- pharmacy module ---- */
  genericName: string | null;
  /* ---- supermarket module ---- */
  categoryId: number | null;
  departmentId: number | null;
  shelfLocation: string | null;
  pluCode: string | null;
  pricePerKg: Money | null;
  isWeighed: boolean;
  /* ---- shared ---- */
  supplierId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface Batch {
  id: number;
  productId: number;
  batchNo: string;
  expiryDate: string | null;
  qty: number;
  costPrice: Money;
  createdAt: string;
}

export interface ProductInput {
  id?: number;
  sku?: string;
  barcode?: string | null;
  name: string;
  category?: string | null;
  unit?: string;
  costPrice: Money;
  price: Money;
  wholesalePrice?: Money;
  reorderLevel?: number;
  rxRequired?: boolean;
  openingStock?: number;
  openingBatchNo?: string;
  openingExpiry?: string | null;
  /* ---- pharmacy module ---- */
  genericName?: string | null;
  /* ---- supermarket module ---- */
  departmentId?: number | null;
  shelfLocation?: string | null;
  pluCode?: string | null;
  pricePerKg?: Money | null;
  isWeighed?: boolean;
  /* ---- shared ---- */
  supplierId?: number | null;
  categoryId?: number | null;
}

export interface StockReceiveInput {
  productId: number;
  qty: number;
  batchNo?: string;
  expiryDate?: string | null;
  costPrice?: Money;
  note?: string;
}

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

export interface CartLineInput {
  productId: number;
  qty: number;
  /** Optional negotiated unit price (kobo). Requires override permission when it differs. */
  unitPrice?: Money;
  batchId?: number;
}

export interface SaleInput {
  docType: DocType;
  lines: CartLineInput[];
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  prescriptionRef?: string;
  discount?: Money;
  paymentMethod: PaymentMethod;
  amountPaid: Money;
  note?: string;
  /** Supervisor/admin who approved a price override on this sale. */
  priceOverrideApprovedBy?: number;
  /** Split payment: one entry per method. Amounts are what the customer tendered. */
  payments?: { method: PaymentMethod; amount: Money; reference?: string | null }[];
  /* ---- shared directory / supermarket module ---- */
  customerId?: number | null;
  loyaltyMemberId?: number | null;
  shiftId?: number | null;
}

export interface SaleItem {
  id: number;
  saleId: number;
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPrice: Money;
  listPrice: Money;
  costPrice: Money;
  lineTotal: Money;
  batchId: number | null;
  batchNo: string | null;
  rxRequired: boolean;
}

export interface Sale {
  id: number;
  receiptNo: string;
  docType: DocType;
  customerName: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  prescriptionRef: string | null;
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  amountPaid: Money;
  changeDue: Money;
  paymentMethod: PaymentMethod;
  status: SaleStatus;
  voidReason: string | null;
  voidRequestedBy: number | null;
  voidRequestedAt: string | null;
  voidedBy: number | null;
  voidedAt: string | null;
  approvedBy: number | null;
  userId: number;
  username: string;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  note: string | null;
  createdAt: string;
  customerId: number | null;
  loyaltyMemberId: number | null;
  shiftId: number | null;
  payments: { id: number; method: string; amount: Money; reference: string | null }[];
  items?: SaleItem[];
}

export interface SaleSummary {
  id: number;
  receiptNo: string;
  docType: DocType;
  customerName: string | null;
  total: Money;
  paymentMethod: PaymentMethod;
  status: SaleStatus;
  username: string;
  createdAt: string;
  voidRequestedAt: string | null;
  itemsCount: number;
}

/* ------------------------------------------------------------------ */
/* Returns / credit notes                                              */
/* ------------------------------------------------------------------ */

export interface ReturnLineInput {
  saleItemId: number;
  qty: number;
  /** Put the goods back on the shelf (default true). */
  restock?: boolean;
}

export interface ReturnInput {
  saleId: number;
  lines: ReturnLineInput[];
  reason: string;
  restock?: boolean;
}

export interface ReturnLine {
  id: number;
  returnId: number;
  saleItemId: number;
  productId: number;
  name: string;
  qty: number;
  unitPrice: Money;
  lineTotal: Money;
  batchId: number | null;
  restock: boolean;
}

export interface SaleReturn {
  id: number;
  creditNoteNo: string | null;
  saleId: number;
  saleReceiptNo: string;
  customerName: string | null;
  reason: string;
  total: Money;
  status: ReturnStatus;
  requestedBy: number;
  requestedByName: string;
  requestedAt: string;
  approvedBy: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejectReason: string | null;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  items?: ReturnLine[];
}

/* ------------------------------------------------------------------ */
/* Users + audit                                                       */
/* ------------------------------------------------------------------ */

export interface UserAccount {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  email: string | null;
  /** Consecutive failed sign-ins since the last success or unlock. */
  failedAttempts: number;
  /** Set when the account is locked; the admin unlocks from Users. */
  lockedUntil: string | null;
  isLocked: boolean;
}

export interface AuditEntry {
  id: number;
  createdAt: string;
  userId: number | null;
  username: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  details: string | null;
  severity: 'INFO' | 'WARN' | 'SECURITY';
}

/* ------------------------------------------------------------------ */
/* Reports                                                             */
/* ------------------------------------------------------------------ */

export type ReportKind =
  | 'SALES_SUMMARY'
  | 'PRODUCT_SALES'
  | 'STOCK_VALUATION'
  | 'LOW_STOCK'
  | 'EXPIRY_WATCH'
  | 'RETURNS'
  | 'AUDIT';

export interface ReportRequest {
  kind: ReportKind;
  from?: string; // YYYY-MM-DD
  to?: string; // YYYY-MM-DD
  userId?: number;
  limit?: number;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  money?: boolean;
}

export interface ReportResult {
  kind: ReportKind;
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number>;
  meta: Record<string, string | number>;
  html: string;
}

export interface DashboardSummary {
  todaySales: Money;
  todayTransactions: number;
  todayReturns: Money;
  weekSales: Money;
  lowStockCount: number;
  expiringCount: number;
  pendingVoids: number;
  pendingReturns: number;
  recentSales: SaleSummary[];
  topProducts: { name: string; qty: number; total: Money }[];
}

/* ------------------------------------------------------------------ */
/* API envelope                                                        */
/* ------------------------------------------------------------------ */

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

export interface ReceiptDocument {
  html: string;
  sale: Sale;
  isCreditNote?: boolean;
}

export const CURRENCY_SYMBOL = '₦';
