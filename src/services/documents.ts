import type { Sale, SaleReturn, StoreProfile } from '../shared/types';
import { formatMoney } from '../shared/money';

/**
 * Printable documents. Every customer facing document prints the CUSTOMER'S
 * OWN store name (taken from the snapshot stored on the document, never from
 * current settings), plus the Infoflex product name in a discreet footer.
 */

const BASE_CSS = `
  :root { --navy: #1F3F73; --gold: #C9A24B; --ink: #1b1b1b; --muted: #5a6472; --line: #d7dbe2; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: var(--ink); margin: 0; padding: 24px; background: #fff; }
  .doc { width: 100%; max-width: 780px; margin: 0 auto; }
  .store { text-align: center; border-bottom: 2px solid var(--navy); padding-bottom: 10px; margin-bottom: 14px; }
  .store h1 { margin: 0 0 4px; font-size: 22px; letter-spacing: .4px; color: var(--navy); text-transform: uppercase; }
  .store .addr { font-size: 12px; color: var(--muted); line-height: 1.5; }
  .store .store-logo { max-height: 46px; max-width: 150px; object-fit: contain; margin-bottom: 6px; }
  .store .tagline { font-size: 10px; color: var(--gold); letter-spacing: 1.4px; text-transform: uppercase; margin-top: 4px; }
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
  .sign { display: flex; justify-content: space-between; gap: 30px; margin-top: 34px; font-size: 11px; color: var(--muted); }
  .sign div { flex: 1; border-top: 1px solid #98a1ae; padding-top: 5px; text-align: center; }
  @media print { body { padding: 0; } .doc { max-width: none; } @page { margin: 12mm; } }
  @page { size: A4; margin: 12mm; }
`;

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

function storeHeader(storeName: string, address: string, phone: string, logo?: string): string {
  const safeLogo = typeof logo === 'string' && /^data:image\/(png|jpeg|jpg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logo);
  return `
    <div class="store">
      ${safeLogo ? `<img class="store-logo" src="${logo}" alt="" />` : ''}
      <h1>${escapeHtml(storeName)}</h1>
      <div class="addr">
        ${address ? escapeHtml(address) : ''}${address && phone ? ' &middot; ' : ''}${phone ? `Tel: ${escapeHtml(phone)}` : ''}
      </div>
      <div class="tagline">Strategy | Consulting | Innovation</div>
    </div>`;
}

function wrapper(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title><style>${BASE_CSS}</style></head><body><div class="doc">${body}</div></body></html>`;
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  POS: 'Card / POS',
  SPLIT: 'Split payment'
};

export function buildSaleDocument(sale: Sale, store?: StoreProfile, productName = 'Infoflex'): string {
  const isInvoice = sale.docType === 'INVOICE';
  const title = isInvoice ? 'Wholesale Invoice' : 'Sales Receipt';
  const items = sale.items ?? [];
  const rows = items
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}<br /><span class="meta">${escapeHtml(item.sku)}${
          item.batchNo ? ` &middot; batch ${escapeHtml(item.batchNo)}` : ''
        }</span></td>
        <td class="num">${item.isWeighed ? `${(item.qty / 1000).toFixed(3)} kg` : item.qty}</td>
        <td class="num">${formatMoney(item.unitPrice)}${item.isWeighed ? '<span class="meta">/kg</span>' : ''}</td>
        <td class="num">${formatMoney(item.lineTotal)}</td>
      </tr>`
    )
    .join('');

  const statusBadge =
    sale.status === 'VOIDED'
      ? '<span class="badge void">Voided</span>'
      : sale.voidRequestedAt
        ? '<span class="badge pending">Void pending</span>'
        : '';

  const body = `
    ${storeHeader(sale.storeName, sale.storeAddress, sale.storePhone, store?.storeLogo)}
    <div class="doc-title">
      <h2>${title} ${statusBadge}</h2>
      <div class="meta">
        <div><strong>${escapeHtml(sale.receiptNo)}</strong></div>
        <div>${escapeHtml(formatDate(sale.createdAt))}</div>
      </div>
    </div>
    <div class="meta">
      <div>Served by: <strong>${escapeHtml(sale.username)}</strong></div>
      ${sale.customerName ? `<div>Customer: <strong>${escapeHtml(sale.customerName)}</strong></div>` : ''}
      ${sale.customerPhone ? `<div>Phone: ${escapeHtml(sale.customerPhone)}</div>` : ''}
      ${sale.customerAddress ? `<div>Address: ${escapeHtml(sale.customerAddress)}</div>` : ''}
      ${sale.prescriptionRef ? `<div>Prescription ref: ${escapeHtml(sale.prescriptionRef)}</div>` : ''}
      <div>Payment: ${escapeHtml(PAYMENT_LABELS[sale.paymentMethod] ?? sale.paymentMethod)}</div>
      ${sale.note ? `<div>Note: ${escapeHtml(sale.note)}</div>` : ''}
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5">No items</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div class="row"><span>Subtotal</span><span>${formatMoney(sale.subtotal)}</span></div>
      ${sale.discount ? `<div class="row"><span>Discount</span><span>-${formatMoney(sale.discount)}</span></div>` : ''}
      ${sale.tax ? `<div class="row"><span>Tax</span><span>${formatMoney(sale.tax)}</span></div>` : ''}
      <div class="row grand"><span>Total</span><span>${formatMoney(sale.total)}</span></div>
      <div class="row"><span>Paid</span><span>${formatMoney(sale.amountPaid)}</span></div>
      <div class="row"><span>Change</span><span>${formatMoney(sale.changeDue)}</span></div>
    </div>
    ${sale.status === 'VOIDED' ? `<div class="meta" style="margin-top:14px"><strong>VOIDED:</strong> ${escapeHtml(sale.voidReason ?? '')} — ${escapeHtml(formatDate(sale.voidedAt ?? sale.createdAt))}</div>` : ''}
    <div class="footer">
      ${store?.thankYouNote ? escapeHtml(store.thankYouNote) : store?.receiptFooter ? escapeHtml(store.receiptFooter) : 'Thank you for your patronage.'}<br />
      ${store?.receiptFooter && store?.thankYouNote ? escapeHtml(store.receiptFooter) + '<br />' : ''}
      Goods sold in good condition. Returns accepted within ${
        store?.returnWindowDays ?? 7
      } days with this receipt.<br />
      <span style="color:var(--gold)">${escapeHtml(productName)}</span> &middot; Strategy | Consulting | Innovation
    </div>`;
  return wrapper(`${title} ${sale.receiptNo}`, body);
}

export function buildCreditNoteDocument(
  ret: SaleReturn,
  store?: StoreProfile,
  productName = 'Infoflex'
): string {
  const items = ret.items ?? [];
  const rows = items
    .map(
      (item, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(item.name)}</td>
        <td class="num">${item.isWeighed ? `${(item.qty / 1000).toFixed(3)} kg` : item.qty}</td>
        <td class="num">${formatMoney(item.unitPrice)}${item.isWeighed ? '<span class="meta">/kg</span>' : ''}</td>
        <td class="num">${formatMoney(item.lineTotal)}</td>
      </tr>`
    )
    .join('');
  const badge =
    ret.status === 'PENDING'
      ? '<span class="badge pending">Pending approval</span>'
      : ret.status === 'REJECTED'
        ? '<span class="badge void">Rejected</span>'
        : '';
  const body = `
    ${storeHeader(ret.storeName, ret.storeAddress, ret.storePhone, store?.storeLogo)}
    <div class="doc-title">
      <h2>Return / Credit Note ${badge}</h2>
      <div class="meta">
        <div><strong>${escapeHtml(ret.creditNoteNo ?? 'PENDING')}</strong></div>
        <div>${escapeHtml(formatDate(ret.requestedAt))}</div>
      </div>
    </div>
    <div class="meta">
      <div>Original receipt: <strong>${escapeHtml(ret.saleReceiptNo)}</strong></div>
      ${ret.customerName ? `<div>Customer: <strong>${escapeHtml(ret.customerName)}</strong></div>` : ''}
      <div>Reason: ${escapeHtml(ret.reason)}</div>
      <div>Requested by: ${escapeHtml(ret.requestedByName)}</div>
      ${ret.approvedByName ? `<div>Approved by: ${escapeHtml(ret.approvedByName)}</div>` : ''}
    </div>
    <table>
      <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Credit</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No items</td></tr>'}</tbody>
    </table>
    <div class="totals">
      <div class="row grand"><span>Total credited</span><span>${formatMoney(ret.total)}</span></div>
    </div>
    <div class="sign"><div>Customer signature</div><div>Authorised signature</div></div>
    <div class="footer">
      ${store?.thankYouNote ? escapeHtml(store.thankYouNote) + '<br />' : ''}
      <span style="color:var(--gold)">${escapeHtml(productName)}</span> &middot; Strategy | Consulting | Innovation
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
            const value =
              c.money && typeof raw === 'number' ? formatMoney(raw) : escapeHtml(raw ?? '');
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
    ${storeHeader(report.storeName, report.storeAddress, report.storePhone)}
    <div class="doc-title">
      <h2>${escapeHtml(report.title)}</h2>
      <div class="meta">${escapeHtml(new Date().toLocaleString('en-NG'))}</div>
    </div>
    <div class="meta">${escapeHtml(report.subtitle)}</div>
    ${meta}
    <table><thead><tr>${head}</tr></thead><tbody>${bodyRows || `<tr><td colspan="${report.columns.length}">No records for this period.</td></tr>`}</tbody>${
      totalsRow ? `<tfoot>${totalsRow}</tfoot>` : ''
    }</table>
    <div class="footer"><span style="color:var(--gold)">${escapeHtml(
      report.productName ?? 'Infoflex'
    )}</span> &middot; Strategy | Consulting | Innovation</div>`;
  return wrapper(report.title, body);
}
