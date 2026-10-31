import { RETURN_REASONS, type ReceiptLayout, type Sale, type SaleReturn, type StoreProfile } from '../shared/types';
import { formatMoney } from '../shared/money';

/**
 * Printable documents.
 *
 * Two rules decide everything on the page:
 *   1. The customer's own store name sits at the top, large and bold. It is
 *      the snapshot taken when the sale was made, never today's settings, so a
 *      reprint of an old receipt looks exactly like the original.
 *   2. Infoflex only ever appears in the small footer ("Powered by …"), and an
 *      administrator can switch even that off.
 */

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  POS: 'Card / POS',
  CREDIT: 'On account',
  SPLIT: 'Split payment'
};

export interface DocumentHeader {
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  licenceNo?: string | null;
  vatNo?: string | null;
  logo?: string | null;
}

export interface SaleDocumentOptions {
  layout?: ReceiptLayout;
  /** A reprint: the page is stamped DUPLICATE so it cannot pass as the original. */
  duplicate?: boolean;
  /** Small "Powered by Infoflex …" line (administrator setting, default on). */
  poweredBy?: boolean;
  productName?: string;
  /** Store identity for the details that are not snapshotted (email, licence, VAT, logo). */
  store?: StoreProfile;
}

const SAFE_LOGO = /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-NG', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatQty(qty: number, isWeighed: boolean): string {
  return isWeighed ? `${(qty / 1000).toFixed(3)} kg` : String(qty);
}

const BASE_CSS = `
  :root { --navy: #1F3F73; --gold: #C9A24B; --ink: #1b1b1b; --muted: #5a6472; --line: #d7dbe2; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .doc { width: 100%; max-width: 780px; margin: 0 auto; }
  .store { text-align: center; border-bottom: 2px solid var(--navy); padding-bottom: 10px; margin-bottom: 14px; }
  .store h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .4px; color: var(--navy); text-transform: uppercase; }
  .store .addr { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .store .store-logo { max-height: 46px; max-width: 150px; object-fit: contain; margin-bottom: 6px; }
  .doc-title { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin: 12px 0 8px; }
  .doc-title h2 { margin: 0; font-size: 15px; letter-spacing: 1px; text-transform: uppercase; color: var(--navy); }
  .meta { font-size: 12px; color: var(--muted); line-height: 1.6; }
  .meta strong { color: var(--ink); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th { background: #f2f4f8; text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--navy); }
  td { padding: 6px 8px; border-bottom: 1px solid #eef0f4; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-top: 10px; margin-left: auto; width: 300px; }
  .totals .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12.5px; }
  .totals .row.grand { border-top: 2px solid var(--navy); margin-top: 6px; padding-top: 8px; font-size: 15px; font-weight: 700; color: var(--navy); }
  .footer { margin-top: 22px; border-top: 1px dashed var(--line); padding-top: 10px; font-size: 11px; color: var(--muted); text-align: center; line-height: 1.6; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px; letter-spacing: .8px; text-transform: uppercase; border: 1px solid var(--line); }
  .badge.void { border-color: #b42318; color: #b42318; }
  .badge.pending { border-color: var(--gold); color: #8a6d21; }
  .badge.duplicate { border-color: #b42318; color: #b42318; font-weight: 700; }
  .sign { display: flex; justify-content: space-between; gap: 30px; margin-top: 34px; font-size: 11px; color: var(--muted); }
  .sign div { flex: 1; border-top: 1px solid #98a1ae; padding-top: 5px; text-align: center; }
  .billto { display: flex; justify-content: space-between; gap: 24px; margin-top: 10px; font-size: 12px; }
  .billto .box { flex: 1; border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
  .powered { font-size: 9.5px; letter-spacing: .6px; text-transform: uppercase; color: #9aa3af; margin-top: 6px; }
  @media print { body { padding: 0; } .doc { max-width: none; } @page { margin: 12mm; } }
  @page { size: A4; margin: 12mm; }
`;

const THERMAL_CSS = `
  :root { --navy: #000; --gold: #444; --ink: #000; --muted: #333; --line: #bbb; }
  * { box-sizing: border-box; }
  body { font-family: "Consolas", "Courier New", monospace; color: #000; margin: 0; padding: 4px; background: #fff; }
  .doc { width: 100%; margin: 0 auto; }
  .store { text-align: center; border-bottom: 1px dashed var(--line); padding-bottom: 4px; margin-bottom: 6px; }
  .store h1 { margin: 0; font-size: 15px; font-weight: 800; letter-spacing: .5px; text-transform: uppercase; }
  .store .addr { font-size: 9px; line-height: 1.35; margin-top: 2px; }
  /* Thermal heads are one colour, so the logo is forced to greyscale. */
  .store .store-logo { max-height: 38px; max-width: 110px; object-fit: contain; margin-bottom: 3px; filter: grayscale(100%); }
  .doc-title { display: flex; justify-content: space-between; align-items: baseline; font-size: 9px; margin: 4px 0; }
  .doc-title h2 { margin: 0; font-size: 10px; letter-spacing: .8px; text-transform: uppercase; }
  .meta { font-size: 9px; line-height: 1.45; }
  .meta strong { color: #000; }
  table { width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 4px; }
  th { text-align: left; border-bottom: 1px dashed var(--line); padding: 2px 0; font-size: 8.5px; text-transform: uppercase; }
  td { padding: 2px 0; vertical-align: top; }
  td.num, th.num { text-align: right; }
  .totals { margin-top: 4px; border-top: 1px dashed var(--line); padding-top: 3px; }
  .totals .row { display: flex; justify-content: space-between; font-size: 9.5px; padding: 1px 0; }
  .totals .row.grand { font-size: 12px; font-weight: 800; border-top: 1px solid #000; margin-top: 2px; padding-top: 3px; }
  .footer { margin-top: 6px; border-top: 1px dashed var(--line); padding-top: 4px; font-size: 8.5px; text-align: center; line-height: 1.45; }
  .badge { display: inline-block; padding: 1px 5px; border: 1px solid #000; font-size: 8px; letter-spacing: .6px; text-transform: uppercase; }
  .badge.void, .badge.duplicate { font-weight: 800; }
  .sign { display: none; }
  .billto, .box { display: block; }
  .powered { font-size: 7.5px; letter-spacing: .4px; text-transform: uppercase; color: #555; margin-top: 3px; }
  @media print { body { padding: 0; } }
`;

function layoutCss(layout: ReceiptLayout): string {
  if (layout === 'THERMAL_80' || layout === 'THERMAL_58') return THERMAL_CSS;
  return BASE_CSS;
}

function pageCss(layout: ReceiptLayout): string {
  switch (layout) {
    case 'THERMAL_80':
      return '@page { size: 80mm auto; margin: 3mm; } .doc { max-width: 74mm; }';
    case 'THERMAL_58':
      return '@page { size: 58mm auto; margin: 2mm; } .doc { max-width: 54mm; } body { font-size: 9px; }';
    case 'A4_INVOICE':
      return '@page { size: A4; margin: 12mm; }';
    default:
      return '@page { size: A4; margin: 12mm; } .doc { max-width: 680px; }';
  }
}

function wrapper(title: string, body: string, layout: ReceiptLayout = 'A4_RECEIPT'): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${layoutCss(
    layout
  )}\n${pageCss(layout)}</style></head><body><div class="doc">${body}</div></body></html>`;
}

/** Store name first, then only the details the administrator actually filled in. */
function storeHeader(header: DocumentHeader): string {
  const logo = typeof header.logo === 'string' && SAFE_LOGO.test(header.logo) ? header.logo : null;
  const contact = [
    header.address ? escapeHtml(header.address) : null,
    header.phone ? `Tel: ${escapeHtml(header.phone)}` : null
  ].filter(Boolean);
  const legal = [
    header.email ? escapeHtml(header.email) : null,
    header.licenceNo ? `Licence: ${escapeHtml(header.licenceNo)}` : null,
    header.vatNo ? `VAT: ${escapeHtml(header.vatNo)}` : null
  ].filter(Boolean);
  return `
    <div class="store">
      ${logo ? `<img class="store-logo" src="${logo}" alt="" />` : ''}
      <h1>${escapeHtml(header.name)}</h1>
      ${contact.length ? `<div class="addr">${contact.join(' &middot; ')}</div>` : ''}
      ${legal.length ? `<div class="addr">${legal.join(' &middot; ')}</div>` : ''}
    </div>`;
}

/** Header object for a sale: the snapshot wins, current settings fill the gaps. */
export function headerForSale(sale: Sale, store?: StoreProfile): DocumentHeader {
  return {
    name: sale.storeName || store?.storeName || '',
    address: sale.storeAddress || store?.storeAddress || null,
    phone: sale.storePhone || store?.storePhone || null,
    email: store?.storeEmail || null,
    licenceNo: store?.storeLicenceNo || null,
    vatNo: store?.storeVatNo || null,
    logo: store?.storeLogo || null
  };
}

/** Footer text: the shop's own notes, one line each, with a sensible default. */
function footerText(store?: StoreProfile): string {
  const lines = [store?.thankYouNote, store?.receiptFooter]
    .map((l) => (l ?? '').trim())
    .filter((l) => l.length > 0);
  const unique = lines.filter((line, index) => lines.indexOf(line) === index);
  return (unique.length ? unique : ['Thank you for your patronage.']).map(escapeHtml).join('<br />');
}

function poweredByLine(productName: string): string {
  return `<div class="powered">Powered by ${escapeHtml(productName)}</div>`;
}

function paymentRows(sale: Sale): { label: string; amount: number }[] {
  const payments = sale.payments ?? [];
  if (payments.length > 1 || (payments.length === 1 && sale.paymentMethod === 'SPLIT')) {
    return payments.map((p) => ({
      label: PAYMENT_LABELS[p.method] ?? p.method,
      amount: p.amount
    }));
  }
  return [{ label: PAYMENT_LABELS[sale.paymentMethod] ?? sale.paymentMethod, amount: sale.amountPaid }];
}

function totalsBlock(sale: Sale): string {
  const rows: string[] = [];
  rows.push(`<div class="row"><span>Subtotal</span><span>${formatMoney(sale.subtotal)}</span></div>`);
  if (sale.promoDiscount) {
    rows.push(`<div class="row"><span>Promotions</span><span>-${formatMoney(sale.promoDiscount)}</span></div>`);
  }
  if (sale.itemDiscount) {
    rows.push(`<div class="row"><span>Item discounts</span><span>-${formatMoney(sale.itemDiscount)}</span></div>`);
  }
  if (sale.discount && sale.discount !== sale.promoDiscount + sale.itemDiscount) {
    rows.push(
      `<div class="row"><span>Discount</span><span>-${formatMoney(
        sale.discount - sale.promoDiscount - sale.itemDiscount
      )}</span></div>`
    );
  }
  if (sale.loyaltyValue) {
    rows.push(`<div class="row"><span>Loyalty points</span><span>-${formatMoney(sale.loyaltyValue)}</span></div>`);
  }
  if (sale.tax) {
    const rate = sale.vatRate ? ` (${(sale.vatRate / 100).toFixed(2)}%)` : '';
    rows.push(`<div class="row"><span>VAT${rate}</span><span>${formatMoney(sale.tax)}</span></div>`);
  }
  rows.push(`<div class="row grand"><span>Total</span><span>${formatMoney(sale.total)}</span></div>`);
  return `<div class="totals">${rows.join('')}</div>`;
}

function paymentBlock(sale: Sale): string {
  const rows: string[] = [];
  for (const payment of paymentRows(sale)) {
    rows.push(`<div class="row"><span>${escapeHtml(payment.label)}</span><span>${formatMoney(payment.amount)}</span></div>`);
  }
  rows.push(`<div class="row"><span>Amount paid</span><span>${formatMoney(sale.amountPaid)}</span></div>`);
  if (sale.changeDue) rows.push(`<div class="row"><span>Change</span><span>${formatMoney(sale.changeDue)}</span></div>`);
  if (sale.balanceDue) {
    rows.push(`<div class="row"><span>Balance due</span><span>${formatMoney(sale.balanceDue)}</span></div>`);
  }
  return `<div class="totals">${rows.join('')}</div>`;
}

function statusBadges(sale: Sale, duplicate: boolean): string {
  const badges: string[] = [];
  if (sale.status === 'VOIDED') badges.push('<span class="badge void">Voided</span>');
  if (sale.voidRequestedAt) badges.push('<span class="badge pending">Void pending</span>');
  if (duplicate) badges.push('<span class="badge duplicate">Duplicate</span>');
  return badges.join(' ');
}

function thermalBody(sale: Sale, header: DocumentHeader, options: Required<Pick<SaleDocumentOptions, 'duplicate' | 'poweredBy'>> & { productName: string; store?: StoreProfile }): string {
  const lines = (sale.items ?? [])
    .map(
      (item) => `
      <tr>
        <td colspan="2">${escapeHtml(item.name)}${
          item.promotionName ? `<br /><span class="meta">Promo: ${escapeHtml(item.promotionName)}</span>` : ''
        }</td>
      </tr>
      <tr>
        <td>${formatQty(item.qty, item.isWeighed)} × ${formatMoney(item.unitPrice)}${
          item.isWeighed ? '/kg' : ''
        }</td>
        <td class="num">${formatMoney(
          item.lineTotal - item.lineDiscount
        )}</td>
      </tr>`
    )
    .join('');

  return `
    ${storeHeader(header)}
    <div class="doc-title">
      <h2>${sale.docType === 'INVOICE' ? 'Wholesale Invoice' : 'Sales Receipt'}</h2>
      <span>${statusBadges(sale, options.duplicate)}</span>
    </div>
    <div class="meta">
      <div>No: <strong>${escapeHtml(sale.receiptNo)}</strong></div>
      <div>${escapeHtml(formatDate(sale.createdAt))}</div>
      <div>Cashier: ${escapeHtml(sale.username)}</div>
      ${sale.customerName ? `<div>Customer: ${escapeHtml(sale.customerName)}</div>` : ''}
      ${sale.customerPhone ? `<div>Phone: ${escapeHtml(sale.customerPhone)}</div>` : ''}
      ${sale.prescriptionRef ? `<div>Rx: ${escapeHtml(sale.prescriptionRef)}</div>` : ''}
      ${sale.tier === 'WHOLESALE' ? '<div>Tier: Wholesale</div>' : ''}
    </div>
    <table><tbody>${lines || '<tr><td colspan="2">No items</td></tr>'}</tbody></table>
    ${totalsBlock(sale)}
    ${paymentBlock(sale)}
    ${sale.loyaltyPoints ? `<div class="meta">Points earned: ${sale.loyaltyPoints}</div>` : ''}
    ${sale.status === 'VOIDED' ? `<div class="meta"><strong>VOIDED:</strong> ${escapeHtml(sale.voidReason ?? '')}</div>` : ''}
    ${sale.note ? `<div class="meta">Note: ${escapeHtml(sale.note)}</div>` : ''}
    <div class="footer">
      ${footerText(options.store)}<br />
      Goods sold in good condition. Returns accepted within ${options.store?.returnWindowDays ?? 7} days with this receipt.
      ${options.poweredBy ? poweredByLine(options.productName) : ''}
    </div>`;
}

function a4Body(
  sale: Sale,
  header: DocumentHeader,
  options: Required<Pick<SaleDocumentOptions, 'duplicate' | 'poweredBy'>> & {
    productName: string;
    store?: StoreProfile;
    layout: 'A4_RECEIPT' | 'A4_INVOICE';
  }
): string {
  const invoice = options.layout === 'A4_INVOICE';
  const title = invoice ? 'Wholesale Invoice' : 'Sales Receipt';
  const rows = (sale.items ?? [])
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}${
          item.promotionName ? `<br /><span class="meta">Promotion: ${escapeHtml(item.promotionName)}</span>` : ''
        }<br /><span class="meta">${escapeHtml(item.sku)}${item.batchNo ? ` &middot; batch ${escapeHtml(item.batchNo)}` : ''}</span></td>
        <td class="num">${formatQty(item.qty, item.isWeighed)}</td>
        <td class="num">${formatMoney(item.unitPrice)}${item.isWeighed ? '<span class="meta">/kg</span>' : ''}</td>
        <td class="num">${item.lineDiscount ? `-${formatMoney(item.lineDiscount)}` : '—'}</td>
        <td class="num">${formatMoney(item.lineTotal - item.lineDiscount)}</td>
      </tr>`
    )
    .join('');

  const paid = paymentBlock(sale);

  return `
    ${storeHeader(header)}
    <div class="doc-title">
      <h2>${title} ${statusBadges(sale, options.duplicate)}</h2>
      <div class="meta">
        <div><strong>${escapeHtml(sale.receiptNo)}</strong></div>
        <div>${escapeHtml(formatDate(sale.createdAt))}</div>
        <div>Cashier: ${escapeHtml(sale.username)}</div>
      </div>
    </div>
    <div class="billto">
      <div class="box">
        <div class="meta">${invoice ? 'Billed to' : 'Customer'}</div>
        <strong>${escapeHtml(sale.customerName ?? (invoice ? 'Walk-in wholesale customer' : 'Walk-in customer'))}</strong>
        ${sale.customerPhone ? `<div class="meta">${escapeHtml(sale.customerPhone)}</div>` : ''}
        ${sale.customerAddress ? `<div class="meta">${escapeHtml(sale.customerAddress)}</div>` : ''}
      </div>
      <div class="box">
        <div class="meta">${sale.tier === 'WHOLESALE' ? 'Wholesale pricing' : 'Retail pricing'}</div>
        ${sale.prescriptionRef ? `<div class="meta">Prescription: ${escapeHtml(sale.prescriptionRef)}</div>` : ''}
        ${sale.loyaltyPoints ? `<div class="meta">Loyalty points earned: ${sale.loyaltyPoints}</div>` : ''}
        ${sale.loyaltyRedeemed ? `<div class="meta">Points redeemed: ${sale.loyaltyRedeemed}</div>` : ''}
        ${sale.note ? `<div class="meta">Note: ${escapeHtml(sale.note)}</div>` : ''}
      </div>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Discount</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="6">No items</td></tr>'}</tbody>
    </table>
    ${totalsBlock(sale)}
    ${paid}
    ${sale.status === 'VOIDED' ? `<div class="meta" style="margin-top:14px"><strong>VOIDED:</strong> ${escapeHtml(sale.voidReason ?? '')} — ${escapeHtml(formatDate(sale.voidedAt ?? sale.createdAt))}</div>` : ''}
    ${invoice ? '<div class="sign"><div>Received by</div><div>Authorised signature</div></div>' : ''}
    <div class="footer">
      ${footerText(options.store)}<br />
      Goods sold in good condition. Returns accepted within ${options.store?.returnWindowDays ?? 7} days with this receipt.
      ${options.poweredBy ? poweredByLine(options.productName) : ''}
    </div>`;
}

/**
 * Builds a receipt or invoice. The layout decides the page: 80mm and 58mm
 * thermal rolls (greyscale header, condensed columns) or A4 receipt/invoice.
 */
export function buildSaleDocument(
  sale: Sale,
  store?: StoreProfile,
  productName = 'Infoflex',
  options: SaleDocumentOptions = {}
): string {
  const layout: ReceiptLayout =
    options.layout ?? ((sale.docType === 'INVOICE' ? 'A4_INVOICE' : 'A4_RECEIPT') as ReceiptLayout);
  const duplicate = Boolean(options.duplicate);
  const poweredBy = options.poweredBy ?? true;
  const header = headerForSale(sale, store);
  const title = sale.docType === 'INVOICE' ? 'Wholesale Invoice' : 'Sales Receipt';

  const body =
    layout === 'THERMAL_80' || layout === 'THERMAL_58'
      ? thermalBody(sale, header, { duplicate, poweredBy, productName, store })
      : a4Body(sale, header, {
          duplicate,
          poweredBy,
          productName,
          store,
          layout: layout === 'A4_INVOICE' ? 'A4_INVOICE' : 'A4_RECEIPT'
        });

  return wrapper(`${title} ${sale.receiptNo}${duplicate ? ' (Duplicate)' : ''}`, body, layout);
}

export function buildCreditNoteDocument(
  ret: SaleReturn,
  store?: StoreProfile,
  productName = 'Infoflex',
  options: { duplicate?: boolean; poweredBy?: boolean } = {}
): string {
  const items = ret.items ?? [];
  const typeLabel =
    ret.returnType === 'STORE_CREDIT' ? 'Store credit' : ret.returnType === 'EXCHANGE' ? 'Exchange' : 'Refund';
  const reasonLabel = RETURN_REASONS.find((r) => r.value === ret.reasonCode)?.label ?? 'Return';
  const rows = items
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}${
          item.resellable ? '' : '<br /><span class="meta">Not resellable — written off</span>'
        }</td>
        <td class="num">${formatQty(item.qty, item.isWeighed)}</td>
        <td class="num">${formatMoney(item.unitPrice)}${item.isWeighed ? '<span class="meta">/kg</span>' : ''}</td>
        <td class="num">${formatMoney(item.lineTotal)}</td>
        <td class="num">${formatMoney(item.netTotal)}</td>
      </tr>`
    )
    .join('');

  const badge =
    ret.status === 'PENDING'
      ? '<span class="badge pending">Pending approval</span>'
      : ret.status === 'REJECTED'
        ? '<span class="badge void">Rejected</span>'
        : '';
  const duplicate = options.duplicate ? '<span class="badge duplicate">Duplicate</span>' : '';
  const reversalRows = [
    ret.promoReversed ? `<div class="row"><span>Promotion reversed</span><span>-${formatMoney(ret.promoReversed)}</span></div>` : '',
    ret.discountReversed ? `<div class="row"><span>Discount reversed</span><span>-${formatMoney(ret.discountReversed)}</span></div>` : '',
    ret.loyaltyPointsReversed
      ? `<div class="row"><span>Loyalty points reversed</span><span>${ret.loyaltyPointsReversed}</span></div>`
      : '',
    ret.loyaltyValueReversed
      ? `<div class="row"><span>Points value</span><span>${formatMoney(ret.loyaltyValueReversed)}</span></div>`
      : ''
  ]
    .filter(Boolean)
    .join('');

  const body = `
    ${storeHeader({
      name: ret.storeName,
      address: ret.storeAddress,
      phone: ret.storePhone,
      email: store?.storeEmail,
      licenceNo: store?.storeLicenceNo,
      vatNo: store?.storeVatNo,
      logo: store?.storeLogo
    })}
    <div class="doc-title">
      <h2>Return / Credit Note ${badge} ${duplicate}</h2>
      <div class="meta">
        <div><strong>${escapeHtml(ret.creditNoteNo ?? 'PENDING')}</strong></div>
        <div>${escapeHtml(formatDate(ret.requestedAt))}</div>
      </div>
    </div>
    <div class="meta">
      <div>Original receipt: <strong>${escapeHtml(ret.saleReceiptNo)}</strong></div>
      ${ret.customerName ? `<div>Customer: <strong>${escapeHtml(ret.customerName)}</strong></div>` : ''}
      <div>Type: <strong>${escapeHtml(typeLabel)}</strong>${ret.refundMethod ? ` &middot; ${escapeHtml(PAYMENT_LABELS[ret.refundMethod] ?? ret.refundMethod)}` : ''}</div>
      <div>Reason: ${escapeHtml(reasonLabel)} — ${escapeHtml(ret.reason)}</div>
      ${ret.exchangeNote ? `<div>Exchange: ${escapeHtml(ret.exchangeNote)}</div>` : ''}
      <div>Processed by: ${escapeHtml(ret.requestedByName)}</div>
      ${ret.approvedByName ? `<div>Approved by: ${escapeHtml(ret.approvedByName)}</div>` : ''}
      ${ret.windowOverride ? '<div>Outside the return window: administrator override</div>' : ''}
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line value</th><th class="num">Credit</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="6">No items</td></tr>'}</tbody>
    </table>
    ${reversalRows ? `<div class="totals">${reversalRows}</div>` : ''}
    <div class="totals">
      <div class="row grand"><span>Total ${typeLabel.toLowerCase()}</span><span>${formatMoney(ret.total)}</span></div>
    </div>
    ${ret.status === 'REJECTED' ? `<div class="meta" style="margin-top:12px"><strong>REJECTED:</strong> ${escapeHtml(ret.rejectReason ?? '')}</div>` : ''}
    <div class="sign"><div>Customer signature</div><div>Authorised signature</div></div>
    <div class="footer">
      ${footerText(store)}<br />
      Keep this credit note for your records. Goods sold in good condition; returns accepted within ${
        store?.returnWindowDays ?? 7
      } days with the original receipt.
      ${options.poweredBy === false ? '' : poweredByLine(productName)}
    </div>`;
  return wrapper(`Credit Note ${ret.creditNoteNo ?? ''}`, body);
}

export interface ReportTable {
  title: string;
  subtitle: string;
  columns: { key: string; label: string; align?: 'left' | 'right'; money?: boolean }[];
  rows: Record<string, string | number | null>[];
  totals?: Record<string, number>;
  meta?: Record<string, string | number>;
  storeName: string;
  storeAddress: string;
  storePhone: string;
  productName?: string;
}

export function buildReportDocument(report: ReportTable): string {
  const head = report.columns
    .map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${escapeHtml(c.label)}</th>`)
    .join('');
  const bodyRows = report.rows
    .map(
      (row) =>
        `<tr>${report.columns
          .map((c) => {
            const raw = row[c.key];
            const value = c.money && typeof raw === 'number' ? formatMoney(raw) : escapeHtml(raw ?? '');
            return `<td class="${c.align === 'right' ? 'num' : ''}">${value}</td>`;
          })
          .join('')}</tr>`
    )
    .join('');
  const totalsRow = report.totals
    ? `<tr style="font-weight:700"><td>Total</td>${report.columns
        .slice(1)
        .map((c) =>
          report.totals && report.totals[c.key] !== undefined
            ? `<td class="num">${c.money ? formatMoney(report.totals[c.key]) : report.totals[c.key]}</td>`
            : '<td></td>'
        )
        .join('')}</tr>`
    : '';
  const meta = report.meta
    ? `<div class="meta" style="margin-top:6px">${Object.entries(report.meta)
        .map(([k, v]) => `${escapeHtml(k.replace(/([A-Z])/g, ' $1'))}: <strong>${escapeHtml(v)}</strong>`)
        .join(' &middot; ')}</div>`
    : '';
  const body = `
    ${storeHeader({ name: report.storeName, address: report.storeAddress, phone: report.storePhone })}
    <div class="doc-title">
      <h2>${escapeHtml(report.title)}</h2>
      <div class="meta">${escapeHtml(new Date().toLocaleString('en-NG'))}</div>
    </div>
    <div class="meta">${escapeHtml(report.subtitle)}</div>
    ${meta}
    <table><thead><tr>${head}</tr></thead><tbody>${
      bodyRows || `<tr><td colspan="${report.columns.length}">No records for this period.</td></tr>`
    }</tbody>${totalsRow ? `<tfoot>${totalsRow}</tfoot>` : ''}</table>
    <div class="footer">${poweredByLine(report.productName ?? 'Infoflex')}</div>`;
  return wrapper(report.title, body);
}
