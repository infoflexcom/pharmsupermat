/**
 * Report exports.
 *
 * CSV is the Excel format: UTF-8 with a BOM, one column per report column, a
 * header block carrying the store name, address and the period, and money as
 * plain naira decimals so a spreadsheet can sum the column.
 */
import type { ReportResult, StoreProfile } from '../shared/types';

const naira = (kobo: number): string => (kobo / 100).toFixed(2);

/**
 * Meta values are a mix of money (gross sales, VAT, profit) and counts
 * (transactions, members). The key says which: money keys are written as naira
 * decimals, counts stay whole numbers.
 */
const MONEY_META = /(sale|taking|discount|vat|return|profit|cost|owing|balance|total|value|float|limit)/i;
const COUNT_META = /count|transaction|scope|items|members|batches|suppliers|lines|entries|voids|overrides|departments|promotions|period/i;

function metaValue(key: string, value: string | number): string {
  if (typeof value !== 'number') return value;
  if (!COUNT_META.test(key) && MONEY_META.test(key)) return naira(value);
  return String(value);
}

function cell(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function line(values: (string | number | null)[]): string {
  return values.map(cell).join(',');
}

export function reportToCsv(report: ReportResult, store: StoreProfile): string {
  const rows: string[] = [];
  rows.push(line([store.storeName]));
  if (store.storeAddress) rows.push(line([store.storeAddress]));
  if (store.storePhone) rows.push(line([`Phone: ${store.storePhone}`]));
  rows.push(line([`${report.title} — ${report.subtitle}`]));
  rows.push(line([`Generated ${new Date().toLocaleString('en-NG')}`]));
  rows.push('');

  const metaEntries = Object.entries(report.meta);
  if (metaEntries.length > 0) {
    rows.push(line(['Summary']));
    for (const [key, value] of metaEntries) {
      rows.push(line([key, metaValue(key, value)]));
    }
    rows.push('');
  }

  rows.push(line(report.columns.map((column) => column.label)));
  for (const row of report.rows) {
    rows.push(
      line(
        report.columns.map((column) => {
          const value = row[column.key];
          if (column.money && typeof value === 'number') return naira(value);
          return value ?? '';
        })
      )
    );
  }

  if (Object.keys(report.totals).length > 0) {
    rows.push(
      line(
        report.columns.map((column, index) => {
          if (index === 0) return 'Total';
          const value = report.totals[column.key];
          if (value === undefined) return '';
          return column.money ? naira(value) : value;
        })
      )
    );
  }

  // The BOM makes Excel open the file as UTF-8 (₦, store names with accents).
  return `\uFEFF${rows.join('\r\n')}\r\n`;
}

export function reportFileName(report: ReportResult, from?: string): string {
  const stamp = from ?? new Date().toISOString().slice(0, 10);
  return `${report.kind.toLowerCase()}-${stamp}.csv`;
}

/**
 * Excel export: a real .xlsx workbook with the store identity at the top, the
 * report table below and a bold total row. Money cells are numbers formatted as
 * naira, so the sheet can be summed or charted straight away.
 */
export async function reportToExcel(report: ReportResult, store: StoreProfile): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Infoflex';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(report.title.slice(0, 30) || 'Report');

  sheet.addRow([store.storeName]).font = { bold: true, size: 14, color: { argb: 'FF1F3F73' } };
  if (store.storeAddress) sheet.addRow([store.storeAddress]);
  if (store.storePhone) sheet.addRow([`Phone: ${store.storePhone}`]);
  sheet.addRow([`${report.title} — ${report.subtitle}`]).font = { bold: true };
  sheet.addRow([`Generated ${new Date().toLocaleString('en-NG')}`]).font = { size: 9, color: { argb: 'FF66707F' } };
  sheet.addRow([]);

  const metaEntries = Object.entries(report.meta);
  for (const [key, value] of metaEntries) {
    const isMoney = typeof value === 'number' && !COUNT_META.test(key) && MONEY_META.test(key);
    const row = sheet.addRow([key, isMoney ? (value as number) / 100 : value]);
    row.getCell(1).font = { bold: true };
    if (isMoney) row.getCell(2).numFmt = '#,##0.00';
  }
  if (metaEntries.length > 0) sheet.addRow([]);

  const header = sheet.addRow(report.columns.map((column) => column.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3F73' } };
  header.alignment = { vertical: 'middle' };

  const moneyColumns = report.columns
    .map((column, index) => (column.money ? index + 1 : 0))
    .filter((index) => index > 0);

  for (const record of report.rows) {
    const values = report.columns.map((column) => {
      const value = record[column.key];
      if (typeof value === 'number' && column.money) return value / 100;
      return value ?? '';
    });
    const added = sheet.addRow(values);
    for (const index of moneyColumns) added.getCell(index).numFmt = '#,##0.00';
  }

  if (Object.keys(report.totals).length > 0) {
    const totals = report.columns.map((column, index) => {
      if (index === 0) return 'Total';
      const value = report.totals[column.key];
      if (value === undefined) return '';
      return column.money ? value / 100 : value;
    });
    const totalRow = sheet.addRow(totals);
    totalRow.font = { bold: true };
    for (const index of moneyColumns) totalRow.getCell(index).numFmt = '#,##0.00';
  }

  sheet.columns.forEach((column, index) => {
    const label = report.columns[index]?.label ?? '';
    column.width = Math.max(12, Math.min(42, label.length + 6));
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
