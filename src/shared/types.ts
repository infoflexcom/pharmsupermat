/**
 * Shared domain contracts used by the main process, the renderer and the
 * dev harness. No Electron / Node imports allowed here.
 */

export type Edition = 'PHARMACY' | 'SUPERMARKET' | 'BOTH';

export type Role = 'ADMIN' | 'SUPERVISOR' | 'CASHIER';

export type Money = number; // integer kobo (1 naira = 100 kobo)

export type PaymentMethod = 'CASH' | 'TRANSFER' | 'POS' | 'CREDIT' | 'SPLIT';

/** Retail (counter) or wholesale (invoice) pricing tier. */
export type PriceTier = 'RETAIL' | 'WHOLESALE';

/** Printable document shapes. Thermal sizes are paper widths in millimetres. */
export type ReceiptLayout = 'THERMAL_80' | 'THERMAL_58' | 'A4_RECEIPT' | 'A4_INVOICE';

export const RECEIPT_LAYOUTS: { value: ReceiptLayout; label: string }[] = [
  { value: 'THERMAL_80', label: '80mm thermal receipt' },
  { value: 'THERMAL_58', label: '58mm thermal receipt' },
  { value: 'A4_RECEIPT', label: 'A4 receipt' },
  { value: 'A4_INVOICE', label: 'A4 wholesale invoice' }
];

export type ApprovalPurpose = 'PRICE_OVERRIDE' | 'DISCOUNT' | 'VOID';

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

/**
 * Licence states. Everything except VALID / EXPIRING locks the app: NONE means
 * the install has never been activated, NOT_STARTED means the period has not
 * begun, EXPIRED means today is on or after the end date, TAMPERED means the
 * stored record no longer matches its HMAC, CLOCK_ROLLBACK means the machine
 * clock moved backwards.
 */
export type LicenseState =
  | 'NONE'
  | 'VALID'
  | 'EXPIRING'
  | 'EXPIRED'
  | 'NOT_STARTED'
  | 'TAMPERED'
  | 'CLOCK_ROLLBACK'
  | 'INVALID';

export type LicenseLockReason = 'NONE' | 'EXPIRED' | 'NOT_STARTED' | 'TAMPERED' | 'CLOCK_ROLLBACK';

/** Business dates are local `YYYY-MM-DD`; the end date is exclusive. */
export interface LicensePeriod {
  startsOn: string;
  endsOn: string;
}

export interface LicenseStatus {
  state: LicenseState;
  edition: Edition | null;
  customerName: string | null;
  issuedAt: string | null;
  /** ISO timestamp of the last valid instant (endsOn at 00:00 local). */
  expiresAt: string | null;
  startsOn: string | null;
  /** Exclusive: the app locks at 00:00 on this date. */
  endsOn: string | null;
  daysRemaining: number | null;
  features: FeatureFlags | null;
  productName: string;
  message?: string;
  /** True only for VALID / EXPIRING — every other state blocks the app. */
  usable: boolean;
  lockReason: LicenseLockReason | null;
  /** Inside the last ten minutes before the period ends. */
  endingSoon: boolean;
  /** Admin banner threshold: 30, 14, 7 or 1 days before expiry. */
  warning: { level: 30 | 14 | 7 | 1; daysRemaining: number } | null;
  /** Main-process clock when the status was computed (renderer skew guard). */
  serverTime: string;
}

export interface LicenseHistoryEntry {
  id: number;
  licenseId: string;
  edition: Edition;
  customerName: string;
  startsOn: string;
  endsOn: string;
  action: 'ACTIVATE' | 'RENEW' | 'EDITION_CHANGE' | 'UNLOCK';
  createdAt: string;
  createdBy: string;
}

/** What the activation / renewal screen sends. */
export interface LicenseSetupInput {
  masterPassword: string;
  edition?: Edition;
  startsOn?: string;
  endsOn?: string;
  customerName?: string;
  activationCode?: string;
  note?: string;
}

export interface MasterPasswordResult {
  ok: true;
  failures: number;
  /** Seconds until the next attempt is accepted (0 when not throttled). */
  retryAfterSeconds: number;
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
  /* ---- till behaviour (phase 6) ---- */
  vatEnabled: boolean;
  /** VAT percentage, e.g. 7.5. Stored on each sale in basis points. */
  vatRate: number;
  /** Maximum manual discount a non-Admin may give, as a percentage of subtotal. */
  maxDiscountPercent: number;
  paymentCash: boolean;
  paymentTransfer: boolean;
  paymentPos: boolean;
  paymentCredit: boolean;
  /** Show the small "Powered by Infoflex …" line under the footer. */
  poweredByFooter: boolean;
  receiptLayout: ReceiptLayout;
  /** Offer the customer-facing totals window on the till. */
  customerDisplay: boolean;
  /** Supermarket: require an open cashier shift before selling. */
  requireShift: boolean;
  /** Loyalty: points earned per ₦100 spent. */
  loyaltyPointsPer100: number;
  /** Loyalty: value of one point in kobo when redeeming. */
  loyaltyPointValue: Money;
  loyaltyRedeemEnabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Products / stock                                                    */
/* ------------------------------------------------------------------ */

export interface Product {
  id: number;
  sku: string;
  barcode: string | null;
  name: string;
  brand: string | null;
  category: string | null;
  unit: string;
  /** How many base units one pack/carton contains (1 when not packed). */
  packSize: number;
  /** What the pack is called: carton, pack, crate… */
  packUnit: string;
  costPrice: Money;
  price: Money;
  wholesalePrice: Money;
  /** Wholesale pricing only applies from this many units. */
  wholesaleMinQty: number;
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
  /** Perishables opt in to expiry tracking and near-expiry alerts. */
  expiryTracking: boolean;
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
  brand?: string | null;
  category?: string | null;
  unit?: string;
  packSize?: number;
  packUnit?: string;
  costPrice: Money;
  price: Money;
  wholesalePrice?: Money;
  wholesaleMinQty?: number;
  reorderLevel?: number;
  expiryTracking?: boolean;
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
  /** Base units received (packs are converted by `packs` below). */
  qty?: number;
  /** Packs received; multiplied by the product's pack size. */
  packs?: number;
  batchNo?: string;
  expiryDate?: string | null;
  costPrice?: Money;
  note?: string;
  /** Weighed products: kilograms received, converted to grams internally. */
  weightKg?: number;
}

export type StockAdjustReason = 'DAMAGED' | 'LOST' | 'CORRECTION' | 'COUNT';

export interface StockAdjustInput {
  productId: number;
  batchId?: number;
  /** New base-unit quantity for the batch (used by CORRECTION/COUNT). */
  newQty?: number;
  /** Quantity removed (used by DAMAGED/LOST). */
  removeQty?: number;
  reason: string;
  reasonType: StockAdjustReason;
}

/* ------------------------------------------------------------------ */
/* Stock counts (stocktake)                                            */
/* ------------------------------------------------------------------ */

export interface StockCountRow {
  id: number;
  count_no: string;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  scope: string;
  note: string | null;
  items_counted: number;
  variance_qty: number;
  variance_value: Money;
  username: string;
  created_at: string;
  posted_at: string | null;
  posted_by: string | null;
}

export interface StockCountItemRow {
  id: number;
  count_id: number;
  product_id: number;
  batch_id: number | null;
  sku: string;
  name: string;
  system_qty: number;
  counted_qty: number | null;
  variance: number;
  cost_price: Money;
}

export interface StockCountDetail {
  count: StockCountRow;
  items: StockCountItemRow[];
  totals: { counted: number; varianceQty: number; varianceValue: Money };
}

/* ------------------------------------------------------------------ */
/* Purchases: orders and goods-received notes                          */
/* ------------------------------------------------------------------ */

export interface PurchaseOrderInput {
  supplierId?: number | null;
  supplierName?: string | null;
  invoiceNo?: string | null;
  purchaseDate?: string;
  note?: string;
  items: Array<{
    productId: number;
    qty: number;
    costPrice: Money;
    batchNo?: string;
    expiryDate?: string | null;
  }>;
}

/* ------------------------------------------------------------------ */
/* Product import / export and price labels                            */
/* ------------------------------------------------------------------ */

export type ImportRowError = { row: number; field: string; message: string };

export interface ProductImportResult {
  mode: 'DRY_RUN' | 'IMPORT';
  totalRows: number;
  validRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  /** First few parsed rows, for the on-screen preview. */
  preview: Array<{ row: number; name: string; sku: string; price: Money; action: 'CREATE' | 'UPDATE' }>;
}

export interface ProductExportFile {
  filename: string;
  /** base64 for xlsx, utf8 text for csv. */
  data: string;
  encoding: 'base64' | 'utf8';
  rows: number;
}

export interface PriceLabelOptions {
  productIds?: number[];
  copies?: number;
  showBarcode?: boolean;
  showPrice?: boolean;
  showName?: boolean;
  title?: string;
}

/* ------------------------------------------------------------------ */
/* Sales                                                               */
/* ------------------------------------------------------------------ */

export interface CartLineInput {
  productId: number;
  qty: number;
  /** Optional negotiated unit price (kobo). Requires override permission when it differs. */
  unitPrice?: Money;
  /** Manual line discount in kobo (counts towards the discount cap). */
  discount?: Money;
  batchId?: number;
}

export interface SalePaymentInput {
  method: PaymentMethod;
  amount: Money;
  reference?: string | null;
}

export interface SaleInput {
  docType: DocType;
  /** RETAIL keeps list prices, WHOLESALE uses the wholesale tier. */
  tier?: PriceTier;
  lines: CartLineInput[];
  customerName?: string;
  customerPhone?: string;
  customerAddress?: string;
  prescriptionRef?: string;
  /** Sale-level manual discount in kobo (counts towards the discount cap). */
  discount?: Money;
  paymentMethod: PaymentMethod;
  /** What the customer actually handed over (may exceed the total: change due). */
  amountPaid: Money;
  note?: string;
  /** Supervisor/admin who approved a price override on this sale. */
  priceOverrideApprovedBy?: number;
  /** Split payment: one entry per method. Amounts are what the customer tendered. */
  payments?: SalePaymentInput[];
  /* ---- shared directory / supermarket module ---- */
  customerId?: number | null;
  loyaltyMemberId?: number | null;
  shiftId?: number | null;
  /** Points the customer is spending on this sale. */
  loyaltyRedeemed?: number;
  /** Short-lived approval token from pos.approve() for overrides/discounts. */
  approvalToken?: string;
  /** Recall a held basket: the hold is removed once the sale completes. */
  holdId?: number | null;
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
  /** Weighed line: qty is grams and the unit price is per kilogram. */
  isWeighed: boolean;
  /** Manual discount given on this line, in kobo. */
  lineDiscount: Money;
  promotionName: string | null;
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
  tier: PriceTier;
  /** Credit left on the invoice after the payments recorded with it. */
  balanceDue: Money;
  promoDiscount: Money;
  itemDiscount: Money;
  loyaltyPoints: number;
  loyaltyRedeemed: number;
  loyaltyValue: Money;
  /** VAT percentage applied to this document (0 when disabled). */
  vatRate: number;
  printCount: number;
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
  /** Weighed line: qty is grams and the unit price is per kilogram. */
  isWeighed: boolean;
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

/* ------------------------------------------------------------------ */
/* Point of sale (phase 6)                                             */
/* ------------------------------------------------------------------ */

/** One cart line as the server prices it, before anything is written. */
export interface QuoteLine {
  productId: number;
  sku: string;
  name: string;
  qty: number;
  unitPrice: Money;
  listPrice: Money;
  isWeighed: boolean;
  /** qty × unit price (weighed: grams × kobo/kg ÷ 1000). */
  gross: Money;
  lineDiscount: Money;
  promoDiscount: Money;
  promotionId: number | null;
  promotionName: string | null;
  /** gross − lineDiscount − promoDiscount. */
  net: Money;
  rxRequired: boolean;
  priceOverridden: boolean;
}

export interface SaleQuote {
  tier: PriceTier;
  lines: QuoteLine[];
  subtotal: Money;
  itemDiscount: Money;
  promoDiscount: Money;
  manualDiscount: Money;
  /** itemDiscount + promoDiscount + manualDiscount. */
  totalDiscount: Money;
  /** Percentage of the subtotal that manual discounts represent. */
  manualDiscountPercent: number;
  vatRate: number;
  tax: Money;
  loyaltyValue: Money;
  /** Points the buyer is spending on this sale. */
  loyaltyRedeemed: number;
  total: Money;
  /** Points the buyer will earn (supermarket loyalty). */
  loyaltyEarned: number;
  /** True when the actor cannot complete this basket without an approval. */
  requiresApproval: boolean;
  /** Reason approval is needed, for the message shown at the till. */
  approvalReason: string | null;
  /** A line price differs from the shelf price and the actor cannot override it. */
  needsPriceApproval: boolean;
  /** Discounts exceed the administrator's cap and the actor is not an administrator. */
  exceedsDiscountCap: boolean;
  /** Total discount as a percentage of the subtotal. */
  discountPercent: number;
  blocked?: string | null;
}

export interface HeldSale {
  id: number;
  holdNo: string;
  label: string | null;
  linesCount: number;
  total: Money;
  customerName: string | null;
  username: string;
  createdAt: string;
}

export interface PosConfig {
  paymentMethods: { method: PaymentMethod; label: string; enabled: boolean }[];
  vatEnabled: boolean;
  vatRate: number;
  maxDiscountPercent: number;
  canDiscountFreely: boolean;
  canOverridePrice: boolean;
  loyaltyEnabled: boolean;
  loyaltyPointsPer100: number;
  loyaltyPointValue: Money;
  loyaltyRedeemEnabled: boolean;
  requireShift: boolean;
  shift: { id: number; openedAt: string; openingFloat: Money; expectedCash: Money } | null;
  customerDisplay: boolean;
  receiptLayout: ReceiptLayout;
  poweredByFooter: boolean;
  wholesaleEnabled: boolean;
}

export interface ApprovalGrant {
  token: string;
  username: string;
  purpose: ApprovalPurpose;
  expiresAt: string;
}

export interface CustomerBalance {
  customerId: number;
  name: string;
  phone: string | null;
  creditLimit: Money;
  outstanding: Money;
  invoices: number;
}

export interface CreditPaymentInput {
  saleId: number;
  amount: Money;
  method: PaymentMethod;
  reference?: string | null;
}

/** What the customer-facing display shows. */
export interface DisplayState {
  storeName: string;
  lines: { name: string; qty: number; amount: Money; isWeighed: boolean }[];
  subtotal: Money;
  discount: Money;
  tax: Money;
  total: Money;
  paid: Money;
  change: Money;
  updatedAt: string;
}

export interface SaleDocumentPayload {
  html: string;
  sale: Sale;
  layout: ReceiptLayout;
  duplicate: boolean;
}
