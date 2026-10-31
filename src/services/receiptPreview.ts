/**
 * A live receipt preview for the Settings screen.
 *
 * The administrator types a new store name, footer or VAT rate and sees the
 * receipt change *before saving*. Nothing is written to the database: the draft
 * is merged over the saved settings in memory, a sample sale is built around it
 * and the normal document builder renders the page, so the preview cannot drift
 * from what the till prints.
 */
import type { Database } from '../db';
import type { PaymentMethod, PriceTier, ReceiptLayout, Sale, SaleItem, SettingsPayload } from '../shared/types';
import { buildSaleDocument } from './documents';
import { getAllSettings } from './settings';

/** Coerce a draft value to the type the setting expects, ignoring junk. */
function cleanDraft(draft: Partial<SettingsPayload>): Partial<SettingsPayload> {
  const out: Partial<SettingsPayload> = {};
  for (const [key, value] of Object.entries(draft ?? {}) as [keyof SettingsPayload, unknown][]) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      if (key === 'storeLogo' && value.length > 300_000) continue;
      out[key] = value.slice(0, 2000) as never;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value as never;
    } else if (typeof value === 'boolean') {
      out[key] = value as never;
    }
  }
  return out;
}

export interface ReceiptPreview {
  html: string;
  layout: ReceiptLayout;
  /** The settings actually used, so the page can show what is unsaved. */
  settings: SettingsPayload;
  /** True when the draft differs from what is stored. */
  dirty: boolean;
}

const SAMPLE_ITEMS: { name: string; sku: string; qty: number; unitPrice: number; weighed?: boolean }[] = [
  { name: 'Paracetamol 500mg (x10)', sku: 'SKU-1001', qty: 2, unitPrice: 15_000 },
  { name: 'Vitamin C 1000mg', sku: 'SKU-1002', qty: 1, unitPrice: 42_500 },
  { name: 'Golden Morn 900g', sku: 'SKU-2004', qty: 1, unitPrice: 155_000, weighed: false }
];

/**
 * Builds the sample sale: three lines, a small loyalty-style discount and the
 * shop's VAT rule applied exactly as the pricing service would apply it.
 */
export function buildSampleSale(settings: SettingsPayload): Sale {
  const items: SaleItem[] = SAMPLE_ITEMS.map((item, index) => ({
    id: index + 1,
    saleId: 0,
    productId: 9000 + index,
    sku: item.sku,
    name: item.name,
    qty: item.qty,
    unitPrice: item.unitPrice,
    listPrice: item.unitPrice,
    costPrice: Math.round(item.unitPrice * 0.6),
    lineTotal: item.qty * item.unitPrice,
    batchId: null,
    batchNo: null,
    rxRequired: false,
    isWeighed: false,
    lineDiscount: 0,
    promotionName: null
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const discount = 20_000;
  const taxable = Math.max(0, subtotal - discount);
  const vatRate = settings.vatEnabled ? Math.round(settings.vatRate * 100) / 100 : 0;
  const tax = settings.vatEnabled ? Math.round((taxable * vatRate) / 100) : 0;
  const total = taxable + tax;
  const amountPaid = Math.ceil(total / 50_000) * 50_000;

  return {
    id: 0,
    receiptNo: 'RCP-PREVIEW',
    docType: 'RECEIPT',
    customerName: 'Walk-in customer',
    customerPhone: null,
    customerAddress: null,
    prescriptionRef: null,
    subtotal,
    discount,
    tax,
    total,
    amountPaid,
    changeDue: amountPaid - total,
    paymentMethod: 'CASH' as PaymentMethod,
    tier: 'RETAIL' as PriceTier,
    balanceDue: 0,
    promoDiscount: 0,
    itemDiscount: discount,
    loyaltyPoints: 0,
    loyaltyRedeemed: 0,
    loyaltyValue: 0,
    vatRate,
    printCount: 0,
    status: 'COMPLETED',
    voidReason: null,
    voidRequestedBy: null,
    voidRequestedAt: null,
    voidedBy: null,
    voidedAt: null,
    approvedBy: null,
    userId: 0,
    username: 'preview',
    // The snapshot a real sale takes: the draft store details, not the saved ones.
    storeName: settings.storeName,
    storeAddress: settings.storeAddress,
    storePhone: settings.storePhone,
    note: null,
    createdAt: new Date().toISOString(),
    customerId: null,
    loyaltyMemberId: null,
    shiftId: null,
    payments: [{ id: 1, method: 'CASH', amount: amountPaid, reference: null }],
    items
  };
}

export function previewReceipt(
  db: Database,
  productName: string,
  draft: Partial<SettingsPayload>
): ReceiptPreview {
  const saved = getAllSettings(db);
  const merged: SettingsPayload = { ...saved, ...cleanDraft(draft) };
  // The store name is required on a real save; the preview simply falls back to
  // the saved name so a half-typed box never renders a blank receipt header.
  if (!merged.storeName.trim()) merged.storeName = saved.storeName;
  const layout: ReceiptLayout = merged.receiptLayout ?? 'THERMAL_80';
  const sale = buildSampleSale(merged);
  const html = buildSaleDocument(sale, merged, productName, {
    layout,
    poweredBy: merged.poweredByFooter
  });
  const dirty = (Object.keys(draft ?? {}) as (keyof SettingsPayload)[]).some(
    (key) => (draft[key] ?? saved[key]) !== saved[key]
  );
  return { html, layout, settings: merged, dirty };
}
