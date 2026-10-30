import { describe, expect, it } from 'vitest';
import { bootstrap, callErr, callOk } from './helpers';

describe('edition and permission guards in the main process', () => {
  it('blocks pharmacy-only IPC channels on a supermarket licence', async () => {
    const mart = await bootstrap('SUPERMARKET');
    const err = await callErr(mart.h, 'inventory.expiryWatch', {}, mart.admin.token);
    expect(err.code).toBe('EDITION_RESTRICTED');
    const rx = await callErr(mart.h, 'prescriptions.log', {}, mart.admin.token);
    expect(rx.code).toBe('EDITION_RESTRICTED');
    mart.h.close();

    const pharmacy = await bootstrap('PHARMACY');
    const ok = await callOk<{ expiring: unknown[] }>(pharmacy.h, 'inventory.expiryWatch', {}, pharmacy.admin.token);
    expect(Array.isArray(ok.expiring)).toBe(true);
    pharmacy.h.close();
  });

  it('rejects unknown channels', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const err = await callErr(h, 'db.everything', {}, admin.token);
    expect(err.code).toBe('NOT_FOUND');
    h.close();
  });

  it('rejects calls without a valid session token', async () => {
    const { h } = await bootstrap('PHARMACY');
    const err = await callErr(h, 'products.list', {}, 'not-a-real-token');
    expect(err.code).toBe('UNAUTHENTICATED');
    h.close();
  });

  it('logs denied attempts as security events', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashierRecord = await callOk<{ token: string }>(h, 'users.create', {
      username: 'guard1',
      fullName: 'Guard One',
      role: 'CASHIER',
      password: 'guardpass1'
    }, admin.token);
    expect(cashierRecord).toBeTruthy();
    const session = await callOk<{ token: string; mustChangePassword: boolean }>(h, 'auth.login', {
      username: 'guard1',
      password: 'guardpass1'
    });
    await callOk(h, 'auth.changePassword', { newPassword: 'guardpass2' }, session.token);
    const fresh = await callOk<{ token: string }>(h, 'auth.login', {
      username: 'guard1',
      password: 'guardpass2'
    });

    await callErr(h, 'users.list', {}, fresh.token);
    const rows = h.db.handle
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'security.permission.denied'")
      .get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);
    h.close();
  });

  it('validates product input and keeps audit of price changes', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const bad = await callErr(h, 'products.create', { name: '', costPrice: 1, price: 2 }, admin.token);
    expect(bad.code).toBe('VALIDATION');

    const product = await callOk<{ id: number; price: number }>(
      h,
      'products.create',
      { name: 'Test Tonic', costPrice: 50_000, price: 90_000, openingStock: 2 },
      admin.token
    );
    await callOk(
      h,
      'products.update',
      { id: product.id, name: 'Test Tonic', costPrice: 50_000, price: 120_000 },
      admin.token
    );
    const row = h.db.handle
      .prepare("SELECT details FROM audit_log WHERE action = 'product.update.price' ORDER BY id DESC LIMIT 1")
      .get() as { details: string };
    expect(JSON.parse(row.details).price).toEqual({ from: 90_000, to: 120_000 });
    h.close();
  });
});
