/**
 * Bulk price-label printing (supermarket module).
 *
 * Builds one printable sheet of shelf labels — store name, product name, price,
 * and the product barcode rendered as Code 128 — so a shop can re-label a whole
 * aisle from the products list in one action.
 */
import type { Database } from '../db';
import type { PriceLabelOptions, Product } from '../shared/types';
import { formatMoney } from '../shared/money';
import { validation } from '../shared/errors';
import { audit } from './audit';
import { code128Svg } from '../shared/barcode';
import { listProducts } from './products';
import type { Actor } from './stock';

const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export interface PriceLabelSheet {
  html: string;
  count: number;
  copies: number;
  title: string;
}

export function buildPriceLabels(
  db: Database,
  options: PriceLabelOptions,
  actor: Actor,
  store: { name: string; address?: string | null; phone?: string | null }
): PriceLabelSheet {
  const copies = options.copies ?? 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > 50) {
    throw validation('Copies per product must be between 1 and 50.');
  }
  const ids = (options.productIds ?? []).filter((id) => Number.isInteger(id) && id > 0);
  if (options.productIds && options.productIds.length > 0 && ids.length === 0) {
    throw validation('Choose at least one product to label.');
  }
  const products = (ids.length > 0
    ? listProducts(db, { limit: 2000 }).filter((product) => ids.includes(product.id))
    : listProducts(db, { limit: 2000 })) as Product[];
  if (products.length === 0) throw validation('There are no products to label.');
  if (!store?.name) throw validation('Set the store name in Settings first — it prints on every label.');

  const labels: string[] = [];
  for (const product of products) {
    for (let copy = 0; copy < copies; copy += 1) labels.push(labelHtml(product, options, store.name));
  }

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(options.title ?? 'Price Labels')}</title>
<style>
  :root { --navy:#1F3F73; --gold:#C9A24B; }
  * { box-sizing: border-box; }
  body { margin:0; padding:8mm; font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif; color:#111; background:#fff; }
  .sheet-head { display:flex; justify-content:space-between; align-items:baseline; border-bottom:2px solid var(--navy);
    padding-bottom:6px; margin-bottom:8px; }
  .sheet-head h1 { margin:0; font-size:14px; text-transform:uppercase; letter-spacing:1.2px; color:var(--navy); }
  .sheet-head .meta { font-size:10px; color:#5a6472; }
  .grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:4mm; }
  .label { border:1px dashed #b9c0ca; border-radius:3px; padding:4mm 3mm; height:30mm;
    display:flex; flex-direction:column; justify-content:space-between; overflow:hidden; page-break-inside:avoid; }
  .label .store { font-size:7.5px; letter-spacing:1.1px; text-transform:uppercase; color:var(--gold); }
  .label .name { font-size:11px; font-weight:700; line-height:1.2; color:var(--navy);
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .label .price { font-size:17px; font-weight:800; color:#111; letter-spacing:.2px; }
  .label .bar { display:flex; align-items:center; justify-content:center; }
  .label .bar svg { max-width:100%; height:auto; }
  .label .code { font-size:8px; color:#5a6472; text-align:center; letter-spacing:.5px; }
  .footer { margin-top:6px; font-size:9px; color:#5a6472; text-align:center; }
  @media print { body { padding:0; } @page { size:A4; margin:8mm; } }
</style></head>
<body>
  <div class="sheet-head">
    <h1>${escapeHtml(store.name)} — ${escapeHtml(options.title ?? 'Price Labels')}</h1>
    <div class="meta">${labels.length} label${labels.length === 1 ? '' : 's'} &middot; ${escapeHtml(
    new Date().toLocaleString('en-NG')
  )}</div>
  </div>
  <div class="grid">${labels.join('')}</div>
  <div class="footer"><span style="color:var(--gold)">Infoflex</span> &middot; Strategy | Consulting | Innovation</div>
</body></html>`;

  audit(db, {
    action: 'labels.print',
    entity: 'product',
    userId: actor.userId,
    username: actor.username,
    details: { products: products.length, copies, labels: labels.length }
  });

  return { html, count: products.length, copies, title: options.title ?? 'Price Labels' };
}

function labelHtml(product: Product, options: PriceLabelOptions, storeName: string): string {
  const showName = options.showName !== false;
  const showPrice = options.showPrice !== false;
  const showBarcode = options.showBarcode !== false;
  const barcodeValue = product.barcode || product.pluCode || product.sku;
  const price = product.isWeighed && product.pricePerKg ? product.pricePerKg : product.price;
  return `<div class="label">
    <div class="store">${escapeHtml(storeName)}</div>
    ${showName ? `<div class="name">${escapeHtml(product.name)}</div>` : '<div></div>'}
    ${showPrice ? `<div class="price">${escapeHtml(formatMoney(price))}${product.isWeighed ? '<span style="font-size:9px">/kg</span>' : ''}</div>` : '<div></div>'}
    ${
      showBarcode
        ? `<div class="bar">${code128Svg(barcodeValue, { height: 26, moduleWidth: 1.15, showText: false })}</div>
           <div class="code">${escapeHtml(barcodeValue)}</div>`
        : ''
    }
  </div>`;
}
