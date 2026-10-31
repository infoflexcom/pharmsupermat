import { describe, expect, it } from 'vitest';
import type { AuditEntry, Product, ReportResult, Sale } from '../src/shared/types';
import { bootstrap, callErr, callOk, createProduct, makeUser, today } from './helpers';

function sell(
  h: Awaited<ReturnType<typeof bootstrap>>['h'],
  token: string,
  productId: number,
  qty: number
): Promise<Sale> {
  return callOk<Sale>(
    h,
    'sales.create',
    {
      docType: 'RECEIPT',
      lines: [{ productId, qty }],
      paymentMethod: 'CASH',
      amountPaid: qty * 500_000
    },
    token
  );
}

describe('reports', () => {
  it('summarises completed sales only and prints the store name', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Bright Care Pharmacy' });
    const product = await createProduct(h, admin);
    const first = await sell(h, admin.token, product.id, 2);
    await sell(h, admin.token, product.id, 3);
    await callOk(h, 'sales.void', { id: first.id, reason: 'Entry error' }, admin.token);

    const report = await callOk<ReportResult>(
      h,
      'reports.build',
      { kind: 'SALES_SUMMARY', from: today(), to: today() },
      admin.token
    );
    expect(report.rows).toHaveLength(1);
    expect(report.totals.net).toBe(240_000);
    expect(report.meta.Transactions).toBe(1);
    expect(report.html).toContain('Bright Care Pharmacy');
    expect(report.html).toContain('Sales Summary');

    const products = await callOk<ReportResult>(
      h,
      'reports.build',
      { kind: 'PRODUCT_SALES', from: today(), to: today() },
      admin.token
    );
    expect(products.rows[0]).toMatchObject({ qty: 3, revenue: 240_000, profit: 90_000 });

    const stock = await callOk<ReportResult>(h, 'reports.build', { kind: 'STOCK_VALUATION' }, admin.token);
    expect(stock.totals.cost).toBe(37 * 50_000);
    h.close();
  });

  it('locks cashiers to their own sales for today', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashrep');
    const product = await createProduct(h, admin);
    await sell(h, admin.token, product.id, 4);

    const report = await callOk<ReportResult>(
      h,
      'reports.build',
      { kind: 'SALES_SUMMARY', from: '2000-01-01', to: '2000-01-02' },
      cashier.token
    );
    expect(report.rows).toHaveLength(0);
    expect(report.meta.Scope).toBe('My sales only');
    h.close();
  });

  it('protects the audit report and lists every important action', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashaud');
    const denied = await callErr(h, 'reports.build', { kind: 'AUDIT' }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');

    const auditReport = await callOk<ReportResult>(h, 'reports.build', { kind: 'AUDIT', limit: 200 }, admin.token);
    const actions = (await callOk<AuditEntry[]>(h, 'audit.list', { limit: 200 }, admin.token)).map((e) => e.action);
    expect(actions).toContain('license.activate');
    expect(actions).toContain('setup.complete');
    expect(actions).toContain('user.create');
    expect(auditReport.rows.length).toBeGreaterThan(0);
    h.close();
  });

  it('measures the dashboard and stock alerts', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { openingStock: 3, reorderLevel: 5 });
    await sell(h, admin.token, product.id, 1);
    const dashboard = await callOk<{ todaySales: number; todayTransactions: number; lowStockCount: number }>(
      h,
      'dashboard.get',
      {},
      admin.token
    );
    expect(dashboard.todaySales).toBe(80_000);
    expect(dashboard.todayTransactions).toBe(1);
    expect(dashboard.lowStockCount).toBe(1);
    h.close();
  });
});

describe('backup and restore', () => {
  it('backs up and restores the database', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const product = await createProduct(h, admin, { name: 'Vitamin C' });
    await sell(h, admin.token, product.id, 1);

    const backup = await callOk<{ path: string; size: number }>(h, 'backup.create', { label: 'test' }, admin.token);
    expect(backup.size).toBeGreaterThan(0);

    // Add data that must disappear after the restore.
    await createProduct(h, admin, { name: 'Late Addition', price: 12_345, costPrice: 10_000 });
    const before = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(before.some((p) => p.name === 'Late Addition')).toBe(true);

    const backupName = backup.path.split(/[\\/]/).pop() ?? '';
    // The operator types the file name; a wrong name is refused (tested below).
    const wrong = await callErr(h, 'backup.restore', { path: backup.path, confirm: 'nope.db' }, admin.token);
    expect(wrong.code).toBe('VALIDATION');
    await callOk(h, 'backup.restore', { path: backup.path, confirm: backupName }, admin.token);
    // Sessions are cleared by the restore.
    const after = await callOk<{ session: unknown }>(h, 'app.state');
    expect(after.session).toBeNull();

    const relogin = await callOk<{ token: string }>(h, 'auth.login', {
      username: 'admin',
      password: 'adminpass123'
    });
    const products = await callOk<Product[]>(h, 'products.list', {}, relogin.token);
    expect(products.some((p) => p.name === 'Late Addition')).toBe(false);
    expect(products.some((p) => p.name === 'Vitamin C')).toBe(true);
    h.close();
  });

  it('refuses invalid backup files', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const err = await callErr(h, 'backup.restore', { path: '/tmp/does-not-exist.db' }, admin.token);
    expect(err.code).toBe('VALIDATION');
    h.close();
  });
});
