/**
 * Bulk product import / export.
 *
 * Excel and CSV files are read with the same column mapping so a shopkeeper can
 * prepare a sheet in Excel, save it as CSV, and get an identical result. Import
 * always runs in two steps from the UI: a dry run that reports every problem
 * row-by-row, then the real import once the operator has seen the report.
 */
import ExcelJS from 'exceljs';
import type { Database } from '../db';
import type {
  ImportRowError,
  Money,
  Product,
  ProductExportFile,
  ProductImportResult,
  ProductInput
} from '../shared/types';
import { validation } from '../shared/errors';
import { audit } from './audit';
import { createProduct, findProductByCode, listProducts, updateProduct, type ProductQuery } from './products';
import type { Actor } from './stock';

export interface EditionFeatures {
  pharmacy: boolean;
  supermarket: boolean;
}

export const PRODUCT_COLUMNS = [
  { key: 'sku', header: 'SKU / Code', width: 16, example: 'PANA-500' },
  { key: 'barcode', header: 'Barcode', width: 18, example: '6151100012345' },
  { key: 'name', header: 'Name', width: 34, example: 'Paracetamol 500mg Tablet' },
  { key: 'brand', header: 'Brand', width: 20, example: 'Emzor' },
  { key: 'category', header: 'Category', width: 18, example: 'Analgesics' },
  { key: 'unit', header: 'Unit', width: 10, example: 'tablet' },
  { key: 'pack_size', header: 'Pack Size', width: 11, example: '100' },
  { key: 'cost_price', header: 'Cost Price', width: 13, example: '4500' },
  { key: 'price', header: 'Retail Price', width: 13, example: '6000' },
  { key: 'wholesale_price', header: 'Wholesale Price', width: 15, example: '5500' },
  { key: 'wholesale_min_qty', header: 'Wholesale Min Qty', width: 17, example: '10' },
  { key: 'reorder_level', header: 'Reorder Level', width: 14, example: '20' },
  { key: 'opening_stock', header: 'Opening Stock', width: 14, example: '50' },
  { key: 'opening_batch', header: 'Batch No', width: 14, example: 'B2401' },
  { key: 'expiry_date', header: 'Expiry Date', width: 14, example: '2027-06-30' },
  { key: 'generic_name', header: 'Generic Name', width: 24, example: 'Paracetamol' },
  { key: 'requires_prescription', header: 'Prescription Only', width: 18, example: 'no' },
  { key: 'department', header: 'Department', width: 16, example: 'Grocery' },
  { key: 'shelf_location', header: 'Shelf / Aisle', width: 16, example: 'A3' },
  { key: 'plu_code', header: 'PLU Code', width: 12, example: '4011' },
  { key: 'price_per_kg', header: 'Price per kg', width: 14, example: '1200' },
  { key: 'is_weighed', header: 'Weighed Item', width: 14, example: 'no' },
  { key: 'expiry_tracking', header: 'Track Expiry', width: 13, example: 'yes' },
  { key: 'supplier', header: 'Supplier', width: 22, example: 'Emzor Pharma' }
] as const;

type ColumnKey = (typeof PRODUCT_COLUMNS)[number]['key'];
type RawRow = Record<string, string>;

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

const normalizeHeader = (value: string): string =>
  value
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const HEADER_LOOKUP: Map<string, ColumnKey> = (() => {
  const map = new Map<string, ColumnKey>();
  for (const column of PRODUCT_COLUMNS) {
    map.set(normalizeHeader(column.header), column.key);
    map.set(normalizeHeader(column.key.replace(/_/g, ' ')), column.key);
  }
  // Friendly alternatives people type by hand.
  const aliases: Record<string, ColumnKey> = {
    code: 'sku',
    'product code': 'sku',
    'sku code': 'sku',
    'item name': 'name',
    product: 'name',
    description: 'name',
    'buying price': 'cost_price',
    cost: 'cost_price',
    'cost price': 'cost_price',
    'selling price': 'price',
    'retail price': 'price',
    selling: 'price',
    'wholesale price': 'wholesale_price',
    'wholesale min qty': 'wholesale_min_qty',
    'minimum wholesale qty': 'wholesale_min_qty',
    'reorder level': 'reorder_level',
    're order level': 'reorder_level',
    'opening stock': 'opening_stock',
    qty: 'opening_stock',
    quantity: 'opening_stock',
    batch: 'opening_batch',
    'batch no': 'opening_batch',
    expiry: 'expiry_date',
    'expiry date': 'expiry_date',
    generic: 'generic_name',
    'generic name': 'generic_name',
    rx: 'requires_prescription',
    prescription: 'requires_prescription',
    'shelf': 'shelf_location',
    aisle: 'shelf_location',
    'shelf aisle': 'shelf_location',
    plu: 'plu_code',
    'plu code': 'plu_code',
    'price per kg': 'price_per_kg',
    weighed: 'is_weighed',
    'weighed item': 'is_weighed',
    'track expiry': 'expiry_tracking',
    supplier: 'supplier'
  };
  for (const [alias, key] of Object.entries(aliases)) map.set(normalizeHeader(alias), key);
  return map;
})();

/**
 * Minimal RFC-4180 CSV reader: handles quoted fields, embedded commas and
 * doubled quotes. Excel writes exactly this shape, so a parsed sheet and a CSV
 * behave the same.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((line) => line.some((cell) => cell.trim() !== ''));
}

async function readSheet(buffer: Buffer): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw validation('The spreadsheet has no sheets.');
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      cells.push(cellText(cell.value));
    });
    rows.push(cells);
  });
  return rows;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const rich = value as { text?: string; result?: unknown; richText?: Array<{ text: string }>; hyperlink?: string };
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join('');
    if (typeof rich.text === 'string') return rich.text;
    if (rich.result !== undefined && rich.result !== null) return String(rich.result);
    if (rich.hyperlink) return rich.hyperlink;
    return '';
  }
  return String(value);
}

function toMatrix(file: { filename: string; data: string; encoding: 'base64' | 'utf8' }): Promise<string[][]> {
  const name = file.filename.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    if (file.encoding !== 'utf8') throw validation('CSV files must be sent as text.');
    return Promise.resolve(parseCsv(file.data));
  }
  if (!name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    throw validation('Use a .xlsx or .csv file.');
  }
  if (file.encoding !== 'base64') throw validation('Excel files must be sent as base64.');
  return readSheet(Buffer.from(file.data, 'base64')).catch(() => {
    throw validation('That file could not be opened. Save it as .xlsx or .csv and try again.');
  });
}

const numberFrom = (value: string): number | null => {
  const cleaned = value.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

/** "1,250.50" or "₦1 250.5" -> 125050 kobo. */
export function moneyFromText(value: string): number | null {
  const parsed = numberFrom(value);
  if (parsed === null) return null;
  return Math.round(parsed * 100);
}

const intFrom = (value: string): number | null => {
  const parsed = numberFrom(value);
  return parsed === null ? null : Math.round(parsed);
};

const boolFrom = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return ['1', 'yes', 'y', 'true', 't', 'x', '✓'].includes(normalized);
};

const isoDate = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return trimmed;
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed);
  if (slash) {
    const [, a, b, year] = slash;
    // Nigerian sheets are written day/month/year.
    const day = Number(a) > 12 ? Number(a) : Number(b) > 12 ? Number(b) : Number(a);
    const month = day === Number(a) ? Number(b) : Number(a);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
};

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

export interface ImportOptions {
  features: EditionFeatures;
  mode: 'DRY_RUN' | 'IMPORT';
}

export async function importProducts(
  db: Database,
  file: { filename: string; data: string; encoding: 'base64' | 'utf8' },
  options: ImportOptions,
  actor: Actor
): Promise<ProductImportResult> {
  if (!file || !file.filename || !file.data) throw validation('Choose a file to import.');
  const matrix = await toMatrix(file);
  if (matrix.length < 2) throw validation('The file only has a header row — nothing to import.');

  const header = matrix[0].map((cell) => HEADER_LOOKUP.get(normalizeHeader(cell)) ?? null);
  if (!header.includes('name')) {
    throw validation('The file needs a "Name" column. Download the template to see the expected headings.');
  }

  const errors: ImportRowError[] = [];
  const validRows: Array<{ rowNo: number; input: ProductInput }> = [];
  const preview: ProductImportResult['preview'] = [];
  const seenCodes = new Map<string, number>();

  for (let index = 1; index < matrix.length; index += 1) {
    const rowNo = index + 1;
    const raw: RawRow = {};
    matrix[index].forEach((cell, cellIndex) => {
      const key = header[cellIndex];
      if (key) raw[key] = (cell ?? '').trim();
    });
    if (!Object.values(raw).some((value) => value !== '')) continue;
    const rowErrors: ImportRowError[] = [];
    const push = (field: string, message: string) => rowErrors.push({ row: rowNo, field, message });

    const name = raw.name ?? '';
    if (!name) push('name', 'Name is required.');
    if (name.length > 120) push('name', 'Name is too long (120 characters max).');

    const costPrice = raw.cost_price ? moneyFromText(raw.cost_price) : 0;
    if (raw.cost_price && costPrice === null) push('cost_price', 'Cost price must be a number.');
    const price = raw.price ? moneyFromText(raw.price) : null;
    if (price === null) push('price', 'Retail price is required.');
    else if (price < 0) push('price', 'Retail price cannot be negative.');
    const wholesalePrice = raw.wholesale_price ? moneyFromText(raw.wholesale_price) : null;
    if (raw.wholesale_price && wholesalePrice === null) push('wholesale_price', 'Wholesale price must be a number.');

    const packSize = raw.pack_size ? intFrom(raw.pack_size) : 1;
    if (packSize === null || packSize < 1) push('pack_size', 'Pack size must be one or more.');
    const wholesaleMinQty = raw.wholesale_min_qty ? intFrom(raw.wholesale_min_qty) : 1;
    if (wholesaleMinQty === null || wholesaleMinQty < 1) push('wholesale_min_qty', 'Minimum quantity must be one or more.');
    const reorderLevel = raw.reorder_level ? intFrom(raw.reorder_level) : 0;
    if (reorderLevel === null || reorderLevel < 0) push('reorder_level', 'Reorder level cannot be negative.');
    const openingStock = raw.opening_stock ? intFrom(raw.opening_stock) : 0;
    if (openingStock === null || openingStock < 0) push('opening_stock', 'Opening stock cannot be negative.');
    const pricePerKg = raw.price_per_kg ? moneyFromText(raw.price_per_kg) : null;
    if (raw.price_per_kg && pricePerKg === null) push('price_per_kg', 'Price per kg must be a number.');

    const expiryRaw = raw.expiry_date ?? '';
    const expiry = isoDate(expiryRaw);
    if (expiryRaw && !expiry) push('expiry_date', 'Expiry date must look like 2027-06-30.');

    const isWeighed = boolFrom(raw.is_weighed ?? '');
    if (isWeighed && !options.features.supermarket) push('is_weighed', 'Weighed items are only available in the Supermarket edition.');
    if (isWeighed && !pricePerKg) push('price_per_kg', 'A weighed item needs a price per kg.');

    const code = (raw.sku || raw.barcode || '').trim();
    if (code) {
      const earlier = seenCodes.get(code.toUpperCase());
      if (earlier) push('sku', `Duplicate of row ${earlier} in this file.`);
      else seenCodes.set(code.toUpperCase(), rowNo);
    }

    if (rowErrors.length > 0 || !price) {
      errors.push(...rowErrors);
      continue;
    }

    const existing =
      (raw.sku ? findProductByCode(db, raw.sku) : null) ??
      (raw.barcode ? findProductByCode(db, raw.barcode) : null) ??
      findByName(db, name);
    if (existing && !existing.active) {
      push('name', 'A product with this code exists but is inactive. Reactivate it from the products list first.');
      errors.push(...rowErrors);
      continue;
    }

    const pharmacy = options.features.pharmacy;
    const supermarket = options.features.supermarket;

    const input: ProductInput = {
      id: existing?.id,
      sku: raw.sku || existing?.sku,
      barcode: raw.barcode || existing?.barcode || null,
      name,
      brand: raw.brand || existing?.brand || null,
      category: raw.category || existing?.category || null,
      unit: raw.unit || existing?.unit || 'unit',
      packSize: packSize ?? 1,
      packUnit: existing?.packUnit ?? 'pack',
      costPrice: (costPrice ?? 0) as Money,
      price: price as Money,
      wholesalePrice: (wholesalePrice ?? existing?.wholesalePrice ?? price) as Money,
      wholesaleMinQty: wholesaleMinQty ?? 1,
      reorderLevel: reorderLevel ?? 0,
      expiryTracking: supermarket
        ? boolFrom(raw.expiry_tracking ?? '') || Boolean(expiry) || Boolean(existing?.expiryTracking)
        : Boolean(expiry) || Boolean(existing?.expiryTracking),
      rxRequired: pharmacy ? boolFrom(raw.requires_prescription ?? '') : false,
      genericName: pharmacy ? raw.generic_name || existing?.genericName || null : null,
      openingStock: existing ? 0 : openingStock ?? 0,
      openingBatchNo: raw.opening_batch || undefined,
      openingExpiry: expiry ?? undefined,
      departmentId: supermarket ? existing?.departmentId ?? null : null,
      shelfLocation: supermarket ? raw.shelf_location || existing?.shelfLocation || null : null,
      pluCode: supermarket ? raw.plu_code || existing?.pluCode || null : null,
      pricePerKg: supermarket && isWeighed ? pricePerKg : null,
      isWeighed: supermarket ? isWeighed : false,
      supplierId: existing?.supplierId ?? null
    };

    if (existing && (existing.price === input.price && existing.costPrice === input.costPrice)) {
      // Still real work if names/pack sizes changed; only flag as skipped when
      // nothing at all moved, so the report is honest.
      const unchanged =
        existing.name === input.name &&
        existing.brand === (input.brand ?? null) &&
        existing.category === (input.category ?? null) &&
        existing.unit === input.unit &&
        existing.packSize === input.packSize &&
        existing.reorderLevel === input.reorderLevel;
      if (unchanged) {
        errors.push({ row: rowNo, field: '', message: `${name} is unchanged — skipped.` });
        continue;
      }
    }

    validRows.push({ rowNo, input });
    if (preview.length < 8) {
      preview.push({
        row: rowNo,
        sku: input.sku ?? '',
        name,
        price: input.price,
        action: existing ? 'UPDATE' : 'CREATE'
      });
    }
  }

  const errorCount = errors.filter((error) => error.field !== '').length;
  const result: ProductImportResult = {
    mode: options.mode,
    totalRows: matrix.length - 1,
    validRows: validRows.length,
    created: validRows.filter((row) => !row.input.id).length,
    updated: validRows.filter((row) => row.input.id).length,
    skipped: errors.filter((error) => error.field === '').length,
    errors,
    preview
  };
  if (options.mode === 'DRY_RUN') return result;
  if (validRows.length === 0) {
    throw validation(
      errorCount > 0
        ? `Nothing could be imported — ${errorCount} problem${errorCount === 1 ? '' : 's'} found. Fix the sheet and try again.`
        : 'Nothing to import.'
    );
  }

  return db.transaction(() => {
    for (const row of validRows) {
      if (row.input.id) updateProduct(db, row.input, actor);
      else createProduct(db, row.input, actor);
    }
    audit(db, {
      action: 'product.import',
      entity: 'product',
      userId: actor.userId,
      username: actor.username,
      severity: 'WARN',
      details: { file: file.filename, created: result.created, updated: result.updated, skipped: result.skipped }
    });
    return result;
  });
}

function findByName(db: Database, name: string): Product | null {
  const row = db.handle
    .prepare('SELECT id FROM products WHERE name = ? COLLATE NOCASE AND active = 1 LIMIT 1')
    .get(name.trim()) as { id: number } | undefined;
  if (!row) return null;
  return listProducts(db, { search: name, limit: 5 }).find((p) => p.id === row.id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

export function exportProducts(db: Database, query: ProductQuery = {}): ProductExportFile {
  const products = dedupe(listProducts(db, { ...query, limit: query.limit ?? 2000 }));
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `products-${stamp}.csv`,
    encoding: 'utf8',
    rows: products.length,
    data: csvOf(products)
  };
}

function dedupe(products: Product[]): Product[] {
  const seen = new Set<number>();
  return products.filter((product) => {
    if (seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

function csvOf(products: Product[]): string {
  const header = PRODUCT_COLUMNS.map((column) => column.header);
  const lines = [header.map(csvCell).join(',')];
  for (const product of products) {
    lines.push(
      [
        product.sku,
        product.barcode ?? '',
        product.name,
        product.brand ?? '',
        product.category ?? '',
        product.unit,
        String(product.packSize),
        naira(product.costPrice),
        naira(product.price),
        naira(product.wholesalePrice),
        String(product.wholesaleMinQty),
        String(product.reorderLevel),
        String(product.stockQty),
        '',
        product.nearestExpiry ?? '',
        product.genericName ?? '',
        product.rxRequired ? 'yes' : 'no',
        '',
        product.shelfLocation ?? '',
        product.pluCode ?? '',
        product.pricePerKg ? naira(product.pricePerKg) : '',
        product.isWeighed ? 'yes' : 'no',
        product.expiryTracking ? 'yes' : 'no',
        ''
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

const csvCell = (value: string): string => {
  const text = value ?? '';
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const naira = (kobo: number): string => (kobo / 100).toFixed(2);

/** Excel export (used by the "Export to Excel" button). */
export async function exportProductsXlsx(db: Database, query: ProductQuery = {}): Promise<ProductExportFile> {
  const products = dedupe(listProducts(db, { ...query, limit: query.limit ?? 2000 }));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.columns = PRODUCT_COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } };
  for (const product of products) {
    sheet.addRow({
      sku: product.sku,
      barcode: product.barcode ?? '',
      name: product.name,
      brand: product.brand ?? '',
      category: product.category ?? '',
      unit: product.unit,
      pack_size: product.packSize,
      cost_price: product.costPrice / 100,
      price: product.price / 100,
      wholesale_price: product.wholesalePrice / 100,
      wholesale_min_qty: product.wholesaleMinQty,
      reorder_level: product.reorderLevel,
      opening_stock: product.stockQty,
      opening_batch: '',
      expiry_date: product.nearestExpiry ?? '',
      generic_name: product.genericName ?? '',
      requires_prescription: product.rxRequired ? 'yes' : 'no',
      department: '',
      shelf_location: product.shelfLocation ?? '',
      plu_code: product.pluCode ?? '',
      price_per_kg: product.pricePerKg ? product.pricePerKg / 100 : '',
      is_weighed: product.isWeighed ? 'yes' : 'no',
      expiry_tracking: product.expiryTracking ? 'yes' : 'no',
      supplier: ''
    });
  }
  sheet.getColumn('cost_price').numFmt = '#,##0.00';
  sheet.getColumn('price').numFmt = '#,##0.00';
  sheet.getColumn('wholesale_price').numFmt = '#,##0.00';
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `products-${new Date().toISOString().slice(0, 10)}.xlsx`,
    encoding: 'base64',
    rows: products.length,
    data: buffer.toString('base64')
  };
}

/** A blank sheet with the exact headings the importer expects. */
export async function exportTemplate(features: EditionFeatures): Promise<ProductExportFile> {
  const hidden = new Set<string>();
  if (!features.pharmacy) hidden.add('Pharmacy');
  if (!features.supermarket) hidden.add('Supermarket');
  const columns = PRODUCT_COLUMNS.filter((column) => {
    if (hidden.has('Pharmacy')) {
      if (['generic_name', 'requires_prescription'].includes(column.key)) return false;
    }
    if (hidden.has('Supermarket')) {
      if (['department', 'shelf_location', 'plu_code', 'price_per_kg', 'is_weighed'].includes(column.key)) return false;
    }
    return true;
  });
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.columns = columns.map((column) => ({ header: column.header, key: column.key, width: column.width }));
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } };
  const example: Record<string, string> = {};
  for (const column of columns) example[column.key] = column.example;
  sheet.addRow(example);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: 'product-import-template.xlsx',
    encoding: 'base64',
    rows: 1,
    data: buffer.toString('base64')
  };
}
