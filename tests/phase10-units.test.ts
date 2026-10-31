/**
 * Phase 10 — the money and date rules, in one place.
 *
 * Every assertion here is worked out by hand in the comment above it, so the
 * file doubles as the shop's arithmetic specification. Where a rule changed in
 * an earlier phase, the test still pins the current behaviour.
 */
import { describe, expect, it } from 'vitest';
import type { Product, ReportResult, Sale, SaleQuote, SaleReturn } from '../src/shared/types';
import {
  bootstrap,
  callErr,
  callOk,
  controllableClock,
  createHarness,
  createProduct,
  makeUser,
  requireMasterPassword,
  today,
  type Harness
} from './helpers';
import type { SessionInfo } from '../src/shared/types';

function sell(
  h: Harness,
  token: string,
  lines: { productId: number; qty: number }[],
  extra: Record<string, unknown> = {}
): Promise<Sale> {
  const gross = lines.reduce((sum, line) => sum + line.qty, 0) * 10_000_000;
  return callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'RECEIPT',
      lines,
      paymentMethod: 'CASH',
      amountPaid: (extra.amountPaid as number | undefined) ?? gross,
      ...extra
    },
    token
  );
}

async function settings(h: Harness, token: string, patch: Record<string, unknown>): Promise<void> {
  await callOk(h, 'settings.update', patch, token);
}

/* ------------------------------------------------------------------ */
/* 1 + 2. Prices and stock                                             */
/* ------------------------------------------------------------------ */

describe('retail vs wholesale pricing', () => {
  it('keeps shelf prices at retail and drops to the trade price at the minimum quantity', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, {
      name: 'Amoxicillin 500mg',
      price: 100_000,
      wholesalePrice: 80_000,
      wholesaleMinQty: 5,
      openingStock: 40
    });

    // One pack is retail: ₦1,000.00.
    const retail = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: product.id, qty: 1 }] }, admin.token);
    expect(retail.tier).toBe('RETAIL');
    expect(retail.lines[0].unitPrice).toBe(100_000);
    expect(retail.total).toBe(100_000);

    // Four packs are still below the wholesale minimum.
    const four = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: product.id, qty: 4 }] }, admin.token);
    expect(four.lines[0].unitPrice).toBe(100_000);
    expect(four.total).toBe(400_000);

    // A receipt never uses the trade tier, however many packs are bought.
    const five = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: product.id, qty: 5 }] }, admin.token);
    expect(five.lines[0].unitPrice).toBe(100_000);

    // An invoice is wholesale — but the trade price only applies once the
    // wholesale minimum (5 packs) is reached.
    const invoiceOne = await callOk<SaleQuote>(
      h,
      'pos.quote',
      { docType: 'INVOICE', lines: [{ productId: product.id, qty: 1 }] },
      admin.token
    );
    expect(invoiceOne.tier).toBe('WHOLESALE');
    expect(invoiceOne.lines[0].unitPrice).toBe(100_000);

    const invoiceFive = await callOk<SaleQuote>(
      h,
      'pos.quote',
      { docType: 'INVOICE', lines: [{ productId: product.id, qty: 5 }] },
      admin.token
    );
    expect(invoiceFive.lines[0].unitPrice).toBe(80_000);
    expect(invoiceFive.total).toBe(400_000);

    // The sale itself stores the price it charged, not the shelf price.
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'INVOICE',
        lines: [{ productId: product.id, qty: 5 }],
        paymentMethod: 'CASH',
        amountPaid: 400_000,
        customerName: 'Sunrise Stores'
      },
      admin.token
    );
    expect(sale.items![0].unitPrice).toBe(80_000);
    expect(sale.total).toBe(400_000);
    h.close();
  });
});

describe('FEFO stock deduction', () => {
  it('sells the earliest-expiring batch first and never the expired one', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, {
      name: 'Ranitidine 150mg',
      price: 50_000,
      costPrice: 30_000,
      openingStock: 4,
      openingBatchNo: 'LATE',
      openingExpiry: new Date(Date.now() + 200 * 86_400_000).toISOString().slice(0, 10)
    });
    // A second, earlier batch: 4 packs expiring in 30 days.
    await callOk(
      h,
      'stock.receive',
      {
        productId: product.id,
        qty: 4,
        batchNo: 'EARLY',
        expiryDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
      },
      admin.token
    );

    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 6 }]);
    const batches = await callOk<{ batchNo: string; qty: number }[]>(
      h,
      'stock.batches',
      { productId: product.id },
      admin.token
    );
    const byName = Object.fromEntries(batches.map((batch) => [batch.batchNo, batch.qty]));
    // 4 from EARLY, 2 from LATE: the near-expiry stock leaves the shelf first.
    expect(byName.EARLY).toBe(0);
    expect(byName.LATE).toBe(2);
    expect(sale.items!.every((item) => item.qty > 0)).toBe(true);

    // An expired batch is never sold, even when it is the only stock left.
    const perishable = await createProduct(h, admin, { name: 'Expired Syrup', price: 20_000, openingStock: 0 });
    await callOk(
      h,
      'stock.receive',
      {
        productId: perishable.id,
        qty: 3,
        batchNo: 'OLD',
        expiryDate: new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10)
      },
      admin.token
    );
    const refused = await callErr(h, 'sales.create', {
      docType: 'RECEIPT',
      lines: [{ productId: perishable.id, qty: 1 }],
      paymentMethod: 'CASH',
      amountPaid: 20_000
    }, admin.token);
    expect(refused.code).toBe('INSUFFICIENT_STOCK');
    expect(refused.message.toLowerCase()).toContain('expir');
    h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 3. Promotions and loyalty                                           */
/* ------------------------------------------------------------------ */

describe('promotions and loyalty maths', () => {
  it('applies the best offer per line and never stacks them', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const product = await createProduct(h, admin, { name: 'Geisha Mackerel', price: 100_000, openingStock: 100 });

    // 10% off: 3 × ₦1,000 = ₦3,000 → ₦300 off.
    await callOk(h, 'mart.promotions.save', {
      name: 'Geisha 10% off',
      promoType: 'PERCENT',
      value: 10,
      productId: product.id
    }, admin.token);
    const percent = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: product.id, qty: 3 }] }, admin.token);
    expect(percent.subtotal).toBe(300_000);
    expect(percent.promoDiscount).toBe(30_000);
    expect(percent.total).toBe(270_000);

    // Buy one get one free: 4 units → 2 free → ₦2,000 off. The BOGO offer is
    // bigger than 10%, so it is the one applied (they do not stack).
    const promoRow = await callOk<{ id: number }[]>(h, 'mart.promotions.list', {}, admin.token);
    const percentRow = promoRow.find((row) => (row as { name?: string }).name === 'Geisha 10% off');
    expect(percentRow).toBeTruthy();
    await callOk(h, 'mart.promotions.save', {
      name: 'Buy 1 get 1 free',
      promoType: 'BOGO',
      value: 0,
      productId: product.id,
      minQty: 2
    }, admin.token);
    const bogo = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: product.id, qty: 4 }] }, admin.token);
    expect(bogo.subtotal).toBe(400_000);
    expect(bogo.promoDiscount).toBe(200_000);
    expect(bogo.total).toBe(200_000);

    // A multi-buy bundle on its own product: 5 for ₦4,000 when the shelf price
    // is ₦1,000 each → ₦1,000 off.
    const noodles = await createProduct(h, admin, { name: 'Indomie Noodles', price: 100_000, openingStock: 60 });
    await callOk(h, 'mart.promotions.save', {
      name: 'Indomie 5 for ₦4,000',
      promoType: 'MULTIBUY',
      value: 400_000,
      productId: noodles.id,
      minQty: 5
    }, admin.token);
    const multi = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: noodles.id, qty: 5 }] }, admin.token);
    expect(multi.promoDiscount).toBe(100_000);
    expect(multi.total).toBe(400_000);

    // Two units do not trigger the 5-for bundle.
    const two = await callOk<SaleQuote>(h, 'pos.quote', { lines: [{ productId: noodles.id, qty: 2 }] }, admin.token);
    expect(two.promoDiscount).toBe(0);
    expect(two.total).toBe(200_000);
    h.close();
  });

  it('earns and spends loyalty points at the configured rates', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    await settings(h, admin.token, { loyaltyPointsPer100: 2, loyaltyPointValue: 5_000, loyaltyRedeemEnabled: true });
    const product = await createProduct(h, admin, { name: 'Bag of Rice', price: 1_000_000, openingStock: 20 });
    const member = await callOk<{ id: number; points: number }>(
      h,
      'mart.loyalty.save',
      { name: 'Ada Nwosu', phone: '0806 444 1122' },
      admin.token
    );

    // ₦10,000.00 at 2 points per ₦100 → 200 points.
    const sale = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 1_000_000,
        loyaltyMemberId: member.id
      },
      admin.token
    );
    expect(sale.loyaltyPoints).toBe(200);

    const memberRow = async () => {
      const members = await callOk<{ id: number; points: number }[]>(h, 'mart.loyalty.list', {}, admin.token);
      return members.find((row) => row.id === member.id)!.points;
    };
    expect(await memberRow()).toBe(200);

    // Spend 50 points at ₦50.00 each → ₦2,500.00 off, and the rest earns again.
    const quote = await callOk<SaleQuote>(
      h,
      'pos.quote',
      { lines: [{ productId: product.id, qty: 1 }], loyaltyMemberId: member.id, loyaltyRedeemed: 50 },
      admin.token
    );
    expect(quote.loyaltyValue).toBe(250_000);
    expect(quote.total).toBe(750_000);
    expect(quote.loyaltyEarned).toBe(150); // ₦7,500.00 → 150 points

    const redeemed = await callOk<Sale>(
      h,
      'sales.create',
      {
        docType: 'RECEIPT',
        lines: [{ productId: product.id, qty: 1 }],
        paymentMethod: 'CASH',
        amountPaid: 1_000_000,
        loyaltyMemberId: member.id,
        loyaltyRedeemed: 50
      },
      admin.token
    );
    expect(redeemed.total).toBe(750_000);
    expect(await memberRow()).toBe(300); // 200 − 50 + 150
    h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 4. Return limits                                                    */
/* ------------------------------------------------------------------ */

describe('return limits', () => {
  it('holds a cashier return above the limit for approval', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { name: 'Multivitamin Syrup', price: 1_000_000, openingStock: 30 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'returncashier');
    // ₦30,000.00 on the receipt: above the ₦20,000.00 cashier ceiling.
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 3 }]);

    // The cashier cannot refund the whole ₦30,000.00 alone: it is queued.
    const big = await callOk<{ value: SaleReturn; pending: boolean; message: string }>(
      h,
      'returns.create',
      { saleId: sale.id, lines: [{ saleItemId: sale.items![0].id, qty: 3 }], reason: 'Damaged pack' },
      cashier.token
    );
    expect(big.pending).toBe(true);
    expect(big.message.toLowerCase()).toContain('approv');
    expect(big.value.status).toBe('PENDING');
    expect(big.value.total).toBe(3_000_000);

    // A small sale under the limit is refunded on the spot.
    const smallSale = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]);
    const small = await callOk<{ value: SaleReturn; pending: boolean; message: string }>(
      h,
      'returns.create',
      { saleId: smallSale.id, lines: [{ saleItemId: smallSale.items![0].id, qty: 1 }], reason: 'Customer changed mind' },
      cashier.token
    );
    expect(small.pending).toBe(false);
    expect(small.value.status).toBe('COMPLETED');
    expect(small.value.creditNoteNo).toBeTruthy();

    // The cashier cannot approve their own request.
    const denied = await callErr(h, 'returns.approve', { id: big.value.id }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');

    // The administrator can.
    const approved = await callOk<SaleReturn>(h, 'returns.approve', { id: big.value.id }, admin.token);
    expect(approved.status).toBe('COMPLETED');
    h.close();
  });

  it('needs approval for a return outside the window', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    await settings(h, admin.token, { returnWindowDays: 7 });
    const product = await createProduct(h, admin, { name: 'Cough Syrup', price: 500_000, openingStock: 10 });
    const cashier = await makeUser(h, admin, 'CASHIER', 'windowcashier');
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]);

    // Move the sale's business date back by ten days, as if it were older.
    h.db.handle.prepare("UPDATE sales SET created_at = datetime('now', '-10 days') WHERE id = ?").run(sale.id);

    const late = await callErr(
      h,
      'returns.create',
      { saleId: sale.id, lines: [{ saleItemId: sale.items![0].id, qty: 1 }], reason: 'Late return' },
      cashier.token
    );
    expect(late.code).toBe('APPROVAL_REQUIRED');
    expect(late.message.toLowerCase()).toMatch(/window|approv/);
    h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 5. Daily and monthly totals                                         */
/* ------------------------------------------------------------------ */

describe('daily and monthly totals', () => {
  it('adds today’s completed sales, ignores voids and subtracts returns', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy' });
    const product = await createProduct(h, admin, { name: 'Vitamin C', price: 100_000, costPrice: 60_000, openingStock: 100 });

    const first = await sell(h, admin.token, [{ productId: product.id, qty: 2 }]); // ₦2,000
    await sell(h, admin.token, [{ productId: product.id, qty: 3 }]); // ₦3,000
    const voided = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]); // ₦1,000, then voided
    await callOk(h, 'sales.void', { id: voided.id, reason: 'Wrong item' }, admin.token);

    // A full refund of the first sale leaves ₦3,000 of net sales.
    const ret = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      { saleId: first.id, lines: [{ saleItemId: first.items![0].id, qty: 2 }], reason: 'Returned unused' },
      admin.token
    );
    expect(ret.pending).toBe(false);

    const daily = await callOk<ReportResult>(h, 'reports.build', { kind: 'DAILY_SUMMARY', from: today(), to: today() }, admin.token);
    expect(daily.totals.gross).toBe(500_000); // ₦5,000.00 sold, before the refund
    expect(daily.totals.returns).toBe(200_000); // ₦2,000.00 refunded
    expect(daily.meta['Net sales (ex VAT)']).toBe(300_000); // ₦3,000.00 kept
    expect(daily.meta.Transactions).toBe(2); // the voided sale and the refund do not count as sales

    const monthly = await callOk<ReportResult>(h, 'reports.build', { kind: 'MONTHLY_SUMMARY' }, admin.token);
    const month = await callOk<{ days: { date: string; net: number }[]; html: string }>(
      h,
      'reports.monthly',
      { month: today().slice(0, 7) },
      admin.token
    );
    const monthRow = month.days.find((day) => day.date === today());
    expect(monthRow?.net).toBe(300_000);
    expect(month.html).toContain('Grace Pharmacy');
    expect(monthly.html).toBeTruthy();
    h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 6. Licence date range and edition flags                             */
/* ------------------------------------------------------------------ */

describe('licence date range and edition flags', () => {
  it('locks trading when the period ends and unlocks again on renewal', async () => {
    const clock = controllableClock();
    const h = createHarness({ now: clock.now });
    await callOk(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      edition: 'PHARMACY',
      customerName: 'Infoflex Test Customer',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString()
    });
    await callOk(h, 'setup.complete', {
      storeName: 'Grace Pharmacy',
      storeAddress: '12 Allen Avenue, Ikeja, Lagos',
      storePhone: '0803 000 0000',
      adminUsername: 'admin',
      adminFullName: 'Ada Admin',
      adminPassword: 'adminpass123'
    });
    const admin = await callOk<SessionInfo>(h, 'auth.login', { username: 'admin', password: 'adminpass123' });

    // Thirty-one days later the licence has run out.
    clock.advanceDays(31);
    const expired = await callOk<{ state: string; usable: boolean }>(h, 'license.status');
    expect(expired.state).toBe('EXPIRED');
    expect(expired.usable).toBe(false);

    // Every business channel is refused in main, before any handler runs.
    const blocked = await callErr(h, 'products.list', {}, admin.token);
    expect(blocked.code).toBe('LICENSE_EXPIRED');
    const saleBlocked = await callErr(
      h,
      'sales.create',
      { docType: 'RECEIPT', lines: [], paymentMethod: 'CASH', amountPaid: 0 },
      admin.token
    );
    expect(saleBlocked.code).toBe('LICENSE_EXPIRED');

    // Renewal with a period that covers today unlocks the app immediately.
    const renewed = await callOk<{ state: string; usable: boolean; edition: string }>(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      edition: 'PHARMACY',
      startsOn: clock.current().toISOString().slice(0, 10),
      endsOn: new Date(clock.current().getTime() + 365 * 86_400_000).toISOString().slice(0, 10),
      customerName: 'Infoflex Test Customer'
    });
    expect(renewed.state).toBe('VALID');
    expect(renewed.usable).toBe(true);
    expect(renewed.edition).toBe('PHARMACY');
    // A month of idleness ended the earlier sign-in; sign in again.
    const session = await callOk<SessionInfo>(h, 'auth.login', { username: 'admin', password: 'adminpass123' });
    const products = await callOk<unknown[]>(h, 'products.list', {}, session.token);
    expect(Array.isArray(products)).toBe(true);

    // The renewal is recorded in the history, not written over the old period.
    const history = await callOk<{ endsOn: string }[]>(h, 'license.history', {}, session.token);
    expect(history.length).toBeGreaterThanOrEqual(2);
    h.close();
  });

  it('mounts only the modules the edition includes', async () => {
    const mart = await bootstrap('SUPERMARKET');
    const martState = await callOk<{ features: { pharmacy: boolean; supermarket: boolean } }>(mart.h, 'app.state');
    expect(martState.features.supermarket).toBe(true);
    expect(martState.features.pharmacy).toBe(false);
    const pharmacyCall = await callErr(mart.h, 'pharmacy.expiryWatch', {}, mart.admin.token);
    expect(pharmacyCall.code).toBe('EDITION_RESTRICTED');

    const both = await bootstrap('BOTH');
    const bothState = await callOk<{ features: { pharmacy: boolean; supermarket: boolean; wholesale: boolean } }>(both.h, 'app.state');
    expect(bothState.features.pharmacy).toBe(true);
    expect(bothState.features.supermarket).toBe(true);
    expect(bothState.features.wholesale).toBe(true);
    const watch = await callOk<unknown>(both.h, 'pharmacy.expiryWatch', {}, both.admin.token);
    expect(watch).toBeTruthy();
    mart.h.close();
    both.h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 7. The store-name snapshot                                          */
/* ------------------------------------------------------------------ */

describe('store-name snapshot on sales and reprints', () => {
  it('keeps the name the shop had when the sale was made', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy Ikeja' });
    const product = await createProduct(h, admin, { name: 'Paracetamol', price: 50_000, openingStock: 20 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]);

    const first = await callOk<{ html: string }>(h, 'sales.document', { id: sale.id }, admin.token);
    expect(first.html).toContain('Grace Pharmacy Ikeja');

    // The shop moves and renames itself.
    await settings(h, admin.token, { storeName: 'Grace Pharmacy Lekki', storePhone: '0803 999 0000' });

    // The old sale still prints the old name: it is a snapshot, not a join.
    const firstPrint = await callOk<{ html: string; duplicate: boolean }>(h, 'pos.print', { id: sale.id }, admin.token);
    expect(firstPrint.duplicate).toBe(false);
    const reprint = await callOk<{ html: string; duplicate: boolean }>(h, 'pos.print', { id: sale.id }, admin.token);
    expect(reprint.duplicate).toBe(true);
    expect(reprint.html).toContain('Grace Pharmacy Ikeja');
    expect(reprint.html).not.toContain('Grace Pharmacy Lekki');

    // A new sale uses the new name.
    const later = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]);
    const laterDoc = await callOk<{ html: string }>(h, 'sales.document', { id: later.id }, admin.token);
    expect(laterDoc.html).toContain('Grace Pharmacy Lekki');

    // A credit note prints the name of the sale it came from, not the current one.
    const ret = await callOk<{ value: SaleReturn; pending: boolean }>(
      h,
      'returns.create',
      { saleId: sale.id, lines: [{ saleItemId: sale.items![0].id, qty: 1 }], reason: 'Returned' },
      admin.token
    );
    const note = await callOk<{ html: string }>(h, 'returns.document', { id: ret.value.id }, admin.token);
    expect(note.html).toContain('Grace Pharmacy Ikeja');
    h.close();
  });

  it('snapshots the address and phone too, and refuses to print without a name', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Sunrise Chemist' });
    const product = await createProduct(h, admin, { name: 'Ibuprofen', price: 70_000, openingStock: 10 });
    const sale = await sell(h, admin.token, [{ productId: product.id, qty: 1 }]);
    const stored = h.db.handle
      .prepare('SELECT store_name, store_address, store_phone FROM sales WHERE id = ?')
      .get(sale.id) as { store_name: string; store_address: string; store_phone: string };
    expect(stored.store_name).toBe('Sunrise Chemist');
    expect(stored.store_address).toBe('12 Allen Avenue, Ikeja, Lagos');
    expect(stored.store_phone).toBe('0803 000 0000');

    // A blank store name cannot be saved at all, so no sale can ever be printed
    // with a nameless header.
    const blank = await callErr(h, 'settings.update', { storeName: '   ' }, admin.token);
    expect(blank.code).toBe('VALIDATION');
    h.close();
  });
});

/* ------------------------------------------------------------------ */
/* 8. The optional demo data                                           */
/* ------------------------------------------------------------------ */

describe('demo data', () => {
  it('seeds a pharmacy catalogue with batches and takes it out again', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const status = await callOk<{ loaded: boolean; products: number; batches: number; users: number }>(
      h,
      'demo.load',
      {},
      admin.token
    );
    expect(status.products).toBe(30);
    expect(status.batches).toBeGreaterThan(30); // opening batches + second batches
    expect(status.users).toBe(1);

    const products = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(products).toHaveLength(30);
    // Real stock, not a fake row: at least one product has two batches.
    const paracetamol = products.find((p) => p.name.startsWith('Paracetamol'));
    expect(paracetamol).toBeTruthy();
    const batches = await callOk<{ batchNo: string }[]>(h, 'stock.batches', { productId: paracetamol!.id }, admin.token);
    expect(batches.length).toBe(2);

    // Loading twice is refused rather than doubling the shop.
    const twice = await callErr(h, 'demo.load', {}, admin.token);
    expect(twice.code).toBe('CONFLICT');

    const removed = await callOk<{ removed: number; kept: string[] }>(h, 'demo.remove', {}, admin.token);
    expect(removed.kept).toHaveLength(0);
    expect(removed.removed).toBeGreaterThanOrEqual(30);
    expect(await callOk<Product[]>(h, 'products.list', {}, admin.token)).toHaveLength(0);
    const after = await callOk<{ loaded: boolean }>(h, 'demo.status', {}, admin.token);
    expect(after.loaded).toBe(false);
    h.close();
  });

  it('seeds 60 supermarket products with weighed items, promotions and two departments', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const status = await callOk<{
      products: number;
      departments: number;
      promotions: number;
      customers: number;
      loyaltyMembers: number;
    }>(h, 'demo.load', {}, admin.token);
    expect(status.products).toBe(60);
    expect(status.departments).toBe(2);
    expect(status.promotions).toBe(3);
    expect(status.customers).toBe(3);
    expect(status.loyaltyMembers).toBe(3);

    const products = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(products.filter((product) => product.isWeighed)).toHaveLength(8);
    const departments = await callOk<{ name: string }[]>(h, 'mart.departments.list', {}, admin.token);
    expect(departments.map((d) => d.name).sort()).toEqual(['Groceries', 'Household']);

    // A weighed demo item scans from a scale barcode.
    const rice = products.find((product) => product.name.includes('Long Grain Rice'));
    expect(rice?.pluCode).toBe('00101');
    const scan = await callOk<{ product: Product; scannedQty: number | null } | null>(
      h,
      'products.scan',
      { code: '20010101500' },
      admin.token
    );
    expect(scan?.product.id).toBe(rice?.id);
    expect(scan?.scannedQty).toBe(1500);

    // The demo promotion prices a real basket.
    const quote = await callOk<SaleQuote>(
      h,
      'pos.quote',
      { lines: [{ productId: products.find((p) => p.name.includes('Geisha'))!.id, qty: 2 }] },
      admin.token
    );
    expect(quote.promoDiscount).toBeGreaterThan(0);

    const removed = await callOk<{ removed: number; kept: string[] }>(h, 'demo.remove', {}, admin.token);
    expect(removed.kept).toHaveLength(0);
    expect(await callOk<Product[]>(h, 'products.list', {}, admin.token)).toHaveLength(0);
    const leftDepartments = await callOk<unknown[]>(h, 'mart.departments.list', {}, admin.token);
    expect(leftDepartments).toHaveLength(0);
    h.close();
  });

  it('keeps demo records the shop has already used', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    await callOk(h, 'demo.load', {}, admin.token);
    const products = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    const sold = products.find((product) => product.name.startsWith('Paracetamol'))!;
    await sell(h, admin.token, [{ productId: sold.id, qty: 1 }]);

    const removed = await callOk<{ removed: number; kept: string[] }>(h, 'demo.remove', {}, admin.token);
    expect(removed.kept.some((entry) => entry.includes(sold.name))).toBe(true);
    const after = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(after.map((product) => product.id)).toContain(sold.id);
    h.close();
  });

  it('refuses demo data to anyone but an administrator', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'democashier');
    const denied = await callErr(h, 'demo.load', {}, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');
    h.close();
  });
});

