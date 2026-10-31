import { describe, expect, it } from 'vitest';
import type { Product, Sale } from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct, makeUser, today } from './helpers';

interface PurchaseResult {
  id: number;
  purchase_no: string;
  total: number;
  items: { name: string; qty: number }[];
}

interface SupplierRow {
  id: number;
  name: string;
}

describe('data-access layer through the IPC bridge', () => {
  it('receives a purchase: header, lines, stock and movement ledger', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      const product = await createProduct(h, admin, { openingStock: 5 });
      const supplier = await callOk<SupplierRow>(
        h,
        'directory.suppliers.save',
        { name: 'Emzor Pharmaceutical', phone: '08012345678' },
        admin.token
      );

      const purchase = await callOk<PurchaseResult>(
        h,
        'purchases.create',
        {
          supplierId: supplier.id,
          invoiceNo: 'INV-9001',
          items: [
            { productId: product.id, qty: 15, costPrice: 45_000, batchNo: 'PUR-1', expiryDate: '2028-01-31' }
          ]
        },
        admin.token
      );
      expect(purchase.purchase_no).toMatch(/^PUR-\d{6}$/);
      expect(purchase.items).toHaveLength(1);

      const refreshed = await callOk<Product>(h, 'products.get', { id: product.id }, admin.token);
      expect(refreshed.stockQty).toBe(20);

      const ledger = await callOk<{ type: string }[]>(
        h,
        'stock.ledger',
        { productId: product.id },
        admin.token
      );
      expect(ledger.some((entry) => entry.type === 'PURCHASE')).toBe(true);

      const listed = await callOk<PurchaseResult[]>(h, 'purchases.list', {}, admin.token);
      expect(listed.map((row) => row.id)).toContain(purchase.id);
    } finally {
      h.close();
    }
  });

  it('reconciles a day: totals, expected cash and variance', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      const product = await createProduct(h, admin, { openingStock: 10 });
      const sale = await callOk<Sale>(
        h,
        'sales.create',
        {
          docType: 'RECEIPT',
          lines: [{ productId: product.id, qty: 2 }],
          paymentMethod: 'CASH',
          amountPaid: product.price * 2
        },
        admin.token
      );

      const totals = await callOk<{ cashSales: number; salesCount: number; expectedCash: number }>(
        h,
        'operations.day.totals',
        { businessDate: today(), openingFloat: 100_000 },
        admin.token
      );
      expect(totals.salesCount).toBe(1);
      expect(totals.cashSales).toBe(sale.total);
      expect(totals.expectedCash).toBe(100_000 + sale.total);

      const closing = await callOk<{ variance: number; counted_cash: number; expected_cash: number }>(
        h,
        'operations.day.close',
        { businessDate: today(), openingFloat: 100_000, countedCash: 100_000 + sale.total - 500 },
        admin.token
      );
      expect(closing.variance).toBe(-500);
      expect(closing.counted_cash).toBe(closing.expected_cash - 500);

      const again = await callErr(
        h,
        'operations.day.close',
        { businessDate: today(), countedCash: 1 },
        admin.token
      );
      expect(again.code).toBe('CONFLICT');
    } finally {
      h.close();
    }
  });

  it('keeps master data with the admin but lets a supervisor receive stock', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    try {
      const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup1');
      const product = await createProduct(h, admin, { openingStock: 3, rxRequired: false });

      const deniedSupplier = await callErr(h, 'directory.suppliers.save', { name: 'Blocked Ltd' }, supervisor.token);
      expect(deniedSupplier.code).toBe('FORBIDDEN');

      const deniedDepartment = await callErr(h, 'mart.departments.save', { name: 'Blocked aisle' }, supervisor.token);
      expect(deniedDepartment.code).toBe('FORBIDDEN');

      const deniedPriceRule = await callErr(
        h,
        'mart.priceRules.save',
        { name: 'Supervisor discount', scope: 'PRODUCT', productId: product.id, ruleType: 'DISCOUNT_PERCENT', value: 10 },
        supervisor.token
      );
      expect(deniedPriceRule.code).toBe('FORBIDDEN');

      const purchase = await callOk<PurchaseResult>(
        h,
        'purchases.create',
        { items: [{ productId: product.id, qty: 4, costPrice: 40_000 }] },
        supervisor.token
      );
      expect(purchase.items[0].qty).toBe(4);

      const asAdmin = await callOk(
        h,
        'mart.priceRules.save',
        { name: 'Aisle promo', scope: 'PRODUCT', productId: product.id, ruleType: 'DISCOUNT_PERCENT', value: 5 },
        admin.token
      );
      expect((asAdmin as { name: string }).name).toBe('Aisle promo');
    } finally {
      h.close();
    }
  });

  it('stores weighed products, extra barcodes, variants and cashier shifts', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    try {
      const product = await callOk<Product>(
        h,
        'products.create',
        {
          name: 'Local Rice',
          unit: 'kg',
          costPrice: 120_000,
          price: 150_000,
          isWeighed: true,
          pricePerKg: 150_000,
          pluCode: '5010',
          shelfLocation: 'B2-04',
          openingStock: 25
        },
        admin.token
      );
      expect(product.isWeighed).toBe(true);
      expect(product.pricePerKg).toBe(150_000);
      expect(product.pluCode).toBe('5010');

      const barcodes = await callOk<{ barcode: string }[]>(
        h,
        'mart.barcodes.add',
        { productId: product.id, barcode: '6151100099999', packQty: 5 },
        admin.token
      );
      expect(barcodes.some((row) => row.barcode === '6151100099999')).toBe(true);

      // Lookup by a secondary barcode resolves the product (supermarket tills).
      const found = await callOk<Product | null>(h, 'products.lookup', { code: '6151100099999' }, admin.token);
      expect(found?.id).toBe(product.id);

      const variant = await callOk<{ sku: string; price: number }>(
        h,
        'mart.variants.save',
        { productId: product.id, variantName: '5kg bag', price: 700_000, costPrice: 600_000 },
        admin.token
      );
      expect(variant.price).toBe(700_000);

      const shift = await callOk<{ id: number; status: string }>(
        h,
        'mart.shifts.open',
        { openingFloat: 200_000 },
        admin.token
      );
      expect(shift.status).toBe('OPEN');

      await callOk(h, 'mart.drawer.log', { eventType: 'NO_SALE', reason: 'Change for a customer' }, admin.token);
      const events = await callOk<{ event_type: string }[]>(h, 'mart.drawer.list', {}, admin.token);
      expect(events.map((event) => event.event_type)).toContain('NO_SALE');

      const closed = await callOk<{ status: string; expected_cash: number; variance: number }>(
        h,
        'mart.shifts.close',
        { shiftId: shift.id, countedCash: 200_000 },
        admin.token
      );
      expect(closed.status).toBe('CLOSED');
      expect(closed.variance).toBe(0);
    } finally {
      h.close();
    }
  });
});
