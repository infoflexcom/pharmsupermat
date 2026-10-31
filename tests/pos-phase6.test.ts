import { describe, expect, it } from 'vitest';
import type { HeldSale, PosConfig, Sale, SaleQuote } from '../src/shared/types';
import { callErr, callOk, createProduct, makeUser, bootstrap, type Harness } from './helpers';

async function settings(h: Harness, token: string, patch: Record<string, unknown>) {
  return callOk(h, 'settings.update', patch, token);
}

async function promotion(
  h: Harness,
  token: string,
  payload: Record<string, unknown>
): Promise<{ id: number; name: string }> {
  return callOk(h, 'mart.promotions.save', payload, token);
}

describe('point of sale — phase 6', () => {
  it('prices a retail basket with a promotion, VAT and loyalty points', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Infoflex Mart Lekki' });
    const product = await createProduct(h, admin, { name: 'Golden Penny Semovita', price: 100_000, openingStock: 50 });
    await settings(h, admin.token, { vatEnabled: true, vatRate: 7.5, loyaltyPointsPer100: 2 });
    await promotion(h, admin.token, {
      name: 'Semovita 10% off',
      promoType: 'PERCENT',
      value: 10,
      productId: product.id
    });
    const member = await callOk<{ id: number; points: number }>(
      h,
      'mart.loyalty.save',
      { name: 'Ngozi Okafor', phone: '0803 111 2222' },
      admin.token
    );

    const quote = await callOk<SaleQuote>(
      h,
      'pos.quote',
      { lines: [{ productId: product.id, qty: 3 }] },
      admin.token
    );
    expect(quote.subtotal).toBe(300_000);
    expect(quote.promoDiscount).toBe(30_000);
    // VAT is added on top of the discounted subtotal.
    expect(quote.tax).toBe(20_250); // 270,000 × 7.5%
    expect(quote.total).toBe(290_250);

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 3 }],
        paymentMethod: 'CASH',
        amountPaid: 300_000,
        loyaltyMemberId: member.id
      },
      admin.token
    );
    expect(sale.promoDiscount).toBe(30_000);
    expect(sale.tax).toBe(20_250);
    expect(sale.total).toBe(290_250);
    expect(sale.changeDue).toBe(9_750);
    expect(sale.vatRate).toBe(750);
    // ₦2,902.50 spent at 2 points per ₦100 → 58 points.
    expect(sale.loyaltyPoints).toBe(58);

    const after = await callOk<{ id: number; points: number }[]>(h, 'mart.loyalty.list', {}, admin.token);
    expect(after.find((m) => m.id === member.id)?.points).toBe(58);
    expect((await callOk<{ stockQty: number }>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(47);
    h.close();
  });

  it('computes buy-one-get-one and bundle promotions', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const bogo = await createProduct(h, admin, { name: 'Peak Milk Sachet', price: 20_000, openingStock: 40 });
    const bundle = await createProduct(h, admin, { name: 'Indomie Pack', price: 15_000, openingStock: 40 });
    await promotion(h, admin.token, {
      name: 'Buy 1 get 1 free',
      promoType: 'BOGO',
      value: 0,
      productId: bogo.id,
      minQty: 2
    });
    await promotion(h, admin.token, {
      name: '3 for ₦40',
      promoType: 'MULTIBUY',
      value: 40_000,
      productId: bundle.id,
      minQty: 3
    });

    const quote = await callOk<SaleQuote>(
      h,
      'pos.quote',
      {
        lines: [
          { productId: bogo.id, qty: 4 },
          { productId: bundle.id, qty: 4 }
        ]
      },
      admin.token
    );
    // BOGO on 4 units = 2 free × ₦200 = ₦400 off.
    expect(quote.lines[0].promoDiscount).toBe(40_000);
    // 4 for ₦600 vs 3-for-₦400 + 1 at ₦150 = ₦550 → ₦50 off.
    expect(quote.lines[1].promoDiscount).toBe(5_000);
    expect(quote.total).toBe(40_000 + 55_000);
    h.close();
  });

  it('caps manual discounts for non-admins without counting promotions', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { price: 100_000, openingStock: 30 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashier1');
    await settings(h, admin.token, { maxDiscountPercent: 10 });

    // A 5% manual discount plus a 20% promotion is fine: promotions are not
    // the cashier's discretionary discount.
    await promotion(h, admin.token, { name: 'Big 20%', promoType: 'PERCENT', value: 20, productId: product.id });
    const ok = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1 }],
        discount: 5_000,
        paymentMethod: 'CASH',
        amountPaid: 75_000
      },
      cashier.token
    );
    expect(ok.total).toBe(75_000);

    const product2 = await createProduct(h, admin, { name: 'Rice 5kg', price: 500_000, openingStock: 10 });
    const blocked = await callErr(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product2.id, qty: 1 }],
        discount: 75_000, // 15% — above the 10% cap
        paymentMethod: 'CASH',
        amountPaid: 425_000
      },
      cashier.token
    );
    expect(blocked.code).toBe('APPROVAL_REQUIRED');
    expect(blocked.message).toMatch(/capped at 10%/);

    // Administrators set the cap, so they are not bound by it.
    const adminSale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product2.id, qty: 1 }],
        discount: 75_000,
        paymentMethod: 'CASH',
        amountPaid: 425_000
      },
      admin.token
    );
    expect(adminSale.total).toBe(425_000);
    expect(adminSale.discount).toBe(75_000);
    h.close();
  });

  it('issues a supervisor approval token for a price override, single use', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { price: 100_000 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashier2');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'super2');
    const payload = {
      docType: 'RECEIPT',
      lines: [{ productId: product.id, qty: 1, unitPrice: 90_000 }],
      paymentMethod: 'CASH',
      amountPaid: 100_000
    };

    const blocked = await callErr(h, 'sales.create', payload, cashier.token);
    expect(blocked.code).toBe('APPROVAL_REQUIRED');

    // The cashier cannot approve their own override.
    const selfApproval = await callErr(
      h,
      'pos.approve',
      { purpose: 'PRICE_OVERRIDE', username: 'cashier2', password: 'userpass123' },
      cashier.token
    );
    expect(selfApproval.code).toBe('FORBIDDEN');

    const grant = await callOk<{ token: string; username: string }>(
      h,
      'pos.approve',
      { purpose: 'PRICE_OVERRIDE', username: 'super2', password: 'userpass123' },
      cashier.token
    );
    expect(grant.token).toHaveLength(36);
    expect(grant.username).toBe('super2');

    const sale = await callOk<Sale>(h, 'sales.create', { ...payload, approvalToken: grant.token }, cashier.token);
    expect(sale.total).toBe(90_000);

    const reused = await callErr(h, 'sales.create', { ...payload, approvalToken: grant.token }, cashier.token);
    expect(reused.code).toBe('APPROVAL_REQUIRED');

    const audit = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pos.approval'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
    void supervisor;
    h.close();
  });

  it('splits payment across cash and transfer and hands back change', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { price: 100_000, openingStock: 10 });

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 2 }],
        paymentMethod: 'SPLIT',
        amountPaid: 250_000,
        payments: [
          { method: 'CASH', amount: 150_000 },
          { method: 'TRANSFER', amount: 100_000 }
        ]
      },
      admin.token
    );
    expect(sale.total).toBe(200_000);
    expect(sale.changeDue).toBe(50_000);
    expect(sale.payments?.map((p) => p.method)).toEqual(['CASH', 'TRANSFER']);
    expect(sale.balanceDue).toBe(0);

    // A payment method switched off cannot be used.
    await settings(h, admin.token, { paymentTransfer: false });
    const off = await callErr(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'TRANSFER', amountPaid: 100_000 },
      admin.token
    );
    expect(off.code).toBe('VALIDATION');
    expect(off.message).toMatch(/switched off/i);
    h.close();
  });

  it('sells wholesale on credit, collects part payment and enforces the credit limit', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { price: 100_000, wholesalePrice: 80_000, openingStock: 100 });
    const customer = await callOk<{ id: number }>(
      h,
      'directory.customers.save',
      { name: 'Sunrise Chemists', phone: '0805 555 5555', creditLimit: 5_000_000 },
      admin.token
    );
    await settings(h, admin.token, { paymentCredit: true });

    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'INVOICE',
        tier: 'WHOLESALE',
        lines: [{ productId: product.id, qty: 50 }],
        paymentMethod: 'SPLIT',
        amountPaid: 2_000_000,
        customerId: customer.id,
        payments: [
          { method: 'TRANSFER', amount: 2_000_000 },
          { method: 'CREDIT', amount: 2_000_000 }
        ]
      },
      admin.token
    );
    expect(sale.tier).toBe('WHOLESALE');
    expect(sale.total).toBe(4_000_000); // 50 × ₦800 trade price
    expect(sale.balanceDue).toBe(2_000_000);
    expect(sale.amountPaid).toBe(2_000_000);

    const balances = await callOk<{ name: string; outstanding: number }[]>(h, 'pos.credits.list', {}, admin.token);
    expect(balances[0]).toMatchObject({ name: 'Sunrise Chemists', outstanding: 2_000_000 });

    const paid = await callOk<Sale>(
      h,
      'pos.credits.pay',
      { saleId: sale.id, amount: 500_000, method: 'CASH' },
      admin.token
    );
    expect(paid.balanceDue).toBe(1_500_000);
    // The original invoice is untouched apart from the cached balance.
    expect(paid.status).toBe('COMPLETED');
    expect(paid.total).toBe(4_000_000);

    // Credit needs a customer and a limit that covers the balance.
    const walkIn = await callErr(
      h,
      'sales.create',
      {
        docType: 'INVOICE',
        lines: [{ productId: product.id, qty: 1 }],
        paymentMethod: 'CREDIT',
        amountPaid: 0
      },
      admin.token
    );
    expect(walkIn.code).toBe('VALIDATION');
    expect(walkIn.message).toMatch(/credit customer/i);

    const tooMuch = await callErr(
      h,
      'sales.create',
      {
        docType: 'INVOICE',
        lines: [{ productId: product.id, qty: 50 }],
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        customerId: customer.id
      },
      admin.token
    );
    expect(tooMuch.code).toBe('VALIDATION');
    expect(tooMuch.message).toMatch(/credit limit/i);

    // A cashier cannot collect credit payments.
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashier3');
    const denied = await callErr(
      h,
      'pos.credits.pay',
      { saleId: sale.id, amount: 100_000, method: 'CASH' },
      cashier.token
    );
    expect(denied.code).toBe('FORBIDDEN');
    h.close();
  });

  it('holds and recalls a basket without touching stock', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { openingStock: 10 });

    const held = await callOk<HeldSale>(
      h,
      'pos.holds.save',
      {
        label: 'Customer at the counter',
        customerName: 'Walk-in',
        total: 240_000,
        linesCount: 1,
        payload: { lines: [{ productId: product.id, qty: 3 }], tier: 'RETAIL' }
      },
      admin.token
    );
    expect(held.holdNo).toMatch(/^HLD-\d{6}$/);
    expect((await callOk<{ stockQty: number }>(h, 'products.get', { id: product.id }, admin.token)).stockQty).toBe(10);

    const listed = await callOk<HeldSale[]>(h, 'pos.holds.list', {}, admin.token);
    expect(listed).toHaveLength(1);

    const recalled = await callOk<HeldSale & { payload: string }>(h, 'pos.holds.get', { id: held.id }, admin.token);
    expect(JSON.parse(recalled.payload).lines[0].qty).toBe(3);

    await callOk(h, 'pos.holds.cancel', { id: held.id }, admin.token);
    expect(await callOk<HeldSale[]>(h, 'pos.holds.list', {}, admin.token)).toHaveLength(0);
    h.close();
  });

  it('prints a thermal receipt headed by the store name, marks reprints DUPLICATE and logs them', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET', { storeName: 'Infoflex Mart Lekki' });
    await settings(h, admin.token, { storeEmail: 'till@mart.example', storeLicenceNo: 'NG-4451' });
    const product = await createProduct(h, admin, { name: 'Bag of Rice', price: 100_000, openingStock: 10 });
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 2 }], paymentMethod: 'CASH', amountPaid: 200_000 },
      admin.token
    );

    const first = await callOk<{ html: string; duplicate: boolean; layout: string }>(
      h,
      'pos.print',
      { id: sale.id, layout: 'THERMAL_80' },
      admin.token
    );
    expect(first.duplicate).toBe(false);
    expect(first.html).toContain('Infoflex Mart Lekki');
    expect(first.html).toContain('80mm');
    expect(first.html).toContain('till@mart.example');
    expect(first.html).toContain('NG-4451');
    expect(first.html).toContain('Powered by Infoflex Mart');
    // The store name comes before the item table.
    expect(first.html.indexOf('Infoflex Mart Lekki')).toBeLessThan(first.html.indexOf('Bag of Rice'));

    const second = await callOk<{ html: string; duplicate: boolean }>(h, 'pos.print', { id: sale.id }, admin.token);
    expect(second.duplicate).toBe(true);
    expect(second.html).toContain('Duplicate');

    const log = await callOk<{ duplicate: number; layout: string }[]>(h, 'pos.prints', { saleId: sale.id }, admin.token);
    expect(log).toHaveLength(2);
    expect(log.map((l) => l.duplicate)).toEqual([1, 0]);

    // Renaming the store changes new receipts, never the reprint of an old one.
    await settings(h, admin.token, { storeName: 'Mart Lekki Phase 1' });
    const reprint = await callOk<{ html: string }>(h, 'pos.print', { id: sale.id }, admin.token);
    expect(reprint.html).toContain('Infoflex Mart Lekki');
    expect(reprint.html).not.toContain('Mart Lekki Phase 1');

    const newer = await callOk<Sale>(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'CASH', amountPaid: 100_000 },
      admin.token
    );
    expect((await callOk<Sale>(h, 'sales.get', { id: newer.id }, admin.token)).storeName).toBe('Mart Lekki Phase 1');

    const a4 = await callOk<{ html: string }>(h, 'pos.print', { id: sale.id, layout: 'A4_INVOICE' }, admin.token);
    expect(a4.html).toContain('@page');
    expect(a4.html).toContain('Sales Receipt');
    expect(a4.html).toContain('Retail pricing');
    h.close();
  });

  it('blocks printing when the store has no name', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin);
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [{ productId: product.id, qty: 1 }], paymentMethod: 'CASH', amountPaid: 100_000 },
      admin.token
    );
    // Wipe the store name the way a mis-configured install would.
    h.db.handle.prepare("UPDATE settings SET value = '' WHERE key = 'store_name'").run();
    const err = await callErr(h, 'pos.print', { id: sale.id }, admin.token);
    expect(err.code).toBe('PRINT_BLOCKED');
    expect(err.message).toMatch(/Settings/i);
    h.close();
  });

  it('exposes the till configuration including the open shift', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const config = await callOk<PosConfig>(h, 'pos.config', {}, admin.token);
    expect(config.paymentMethods.map((m) => m.method)).toEqual(['CASH', 'TRANSFER', 'POS', 'CREDIT']);
    expect(config.paymentMethods.find((m) => m.method === 'CREDIT')?.enabled).toBe(false);
    expect(config.maxDiscountPercent).toBe(10);
    expect(config.canDiscountFreely).toBe(true);
    expect(config.requireShift).toBe(false);

    await callOk(h, 'mart.shifts.open', { openingFloat: 500_000 }, admin.token);
    const withShift = await callOk<PosConfig>(h, 'pos.config', {}, admin.token);
    expect(withShift.shift?.openingFloat).toBe(500_000);

    const cashier = await makeUser(h, admin, 'CASHIER', 'cashier4');
    const cashierConfig = await callOk<PosConfig>(h, 'pos.config', {}, cashier.token);
    expect(cashierConfig.canDiscountFreely).toBe(false);
    expect(cashierConfig.canOverridePrice).toBe(false);
    expect(cashierConfig.shift).toBeNull();
    h.close();
  });
});
