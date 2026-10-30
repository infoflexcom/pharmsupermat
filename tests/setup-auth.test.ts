import { describe, expect, it } from 'vitest';
import {
  bootstrap,
  callErr,
  callOk,
  createHarness,
  futureIso,
  makeUser,
  requireMasterPassword
} from './helpers';
import type { SettingsPayload, SessionInfo, SetupStatus } from '../src/shared/types';

describe('first-run setup and authentication', () => {
  it('requires a store name before setup completes', async () => {
    const h = createHarness();
    await callOk(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      edition: 'PHARMACY',
      customerName: 'Test',
      expiresAt: futureIso()
    });
    const err = await callErr(h, 'setup.complete', {
      storeName: '   ',
      adminUsername: 'admin',
      adminFullName: 'Ada',
      adminPassword: 'secret123'
    });
    expect(err.code).toBe('VALIDATION');
    h.close();
  });

  it('completes setup, stores the customer store name and signs in the admin', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Bright Care Pharmacy' });
    const settings = await callOk<SettingsPayload>(h, 'settings.read', {}, admin.token);
    expect(settings.storeName).toBe('Bright Care Pharmacy');
    expect(admin.role).toBe('ADMIN');
    expect(admin.permissions).toContain('users.manage');
    expect(admin.permissions).toContain('prices.set');

    const setup = await callOk<SetupStatus>(h, 'setup.status');
    expect(setup.setupRequired).toBe(false);
    expect(setup.adminConfigured).toBe(true);

    const second = await callErr(h, 'setup.complete', {
      storeName: 'Overwrite',
      adminUsername: 'admin2',
      adminFullName: 'B',
      adminPassword: 'secret123'
    });
    expect(second.code).toBe('CONFLICT');
    h.close();
  });

  it('rejects bad credentials and throttles repeated failures', async () => {
    const { h } = await bootstrap('PHARMACY');
    const err = await callErr(h, 'auth.login', { username: 'admin', password: 'wrong' });
    expect(err.code).toBe('UNAUTHENTICATED');

    for (let i = 0; i < 4; i += 1) {
      await callErr(h, 'auth.login', { username: 'admin', password: 'nope' });
    }
    const throttled = await callErr(h, 'auth.login', { username: 'admin', password: 'nope' });
    expect(throttled.code).toBe('FORBIDDEN');
    expect(throttled.message.toLowerCase()).toContain('too many');
    h.close();
  });

  it('forces a password change for new users and blocks other calls until done', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    await callOk(
      h,
      'users.create',
      { username: 'cash1', fullName: 'Cash One', role: 'CASHIER', password: 'temporary1' },
      admin.token
    );
    const session = await callOk<SessionInfo>(h, 'auth.login', {
      username: 'cash1',
      password: 'temporary1'
    });
    expect(session.mustChangePassword).toBe(true);

    const blocked = await callErr(h, 'products.list', {}, session.token);
    expect(blocked.code).toBe('FORBIDDEN');

    await callOk(h, 'auth.changePassword', { newPassword: 'personal123' }, session.token);
    const afterLogin = await callOk<SessionInfo>(h, 'auth.login', {
      username: 'cash1',
      password: 'personal123'
    });
    expect(afterLogin.mustChangePassword).toBe(false);
    const products = await callOk<unknown[]>(h, 'products.list', {}, afterLogin.token);
    expect(Array.isArray(products)).toBe(true);
    h.close();
  });

  it('enforces roles: only admins manage users, goods and prices', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const cashier = await makeUser(h, admin, 'CASHIER', 'cashier1');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'super1');

    expect((await callErr(h, 'users.list', {}, cashier.token)).code).toBe('FORBIDDEN');
    expect((await callErr(h, 'users.list', {}, supervisor.token)).code).toBe('FORBIDDEN');
    expect(
      (
        await callErr(
          h,
          'users.create',
          { username: 'x1', fullName: 'X', role: 'CASHIER', password: 'secret123' },
          supervisor.token
        )
      ).code
    ).toBe('FORBIDDEN');
    expect(
      (
        await callErr(
          h,
          'products.create',
          { name: 'Nope', costPrice: 100, price: 200 },
          supervisor.token
        )
      ).code
    ).toBe('FORBIDDEN');
    expect((await callErr(h, 'products.create', { name: 'Nope', costPrice: 100, price: 200 }, cashier.token)).code).toBe(
      'FORBIDDEN'
    );
    expect((await callErr(h, 'audit.list', {}, cashier.token)).code).toBe('FORBIDDEN');

    h.close();
  });

  it('keeps at least one active administrator', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const err = await callErr(
      h,
      'users.update',
      { id: admin.userId, active: false },
      admin.token
    );
    expect(err.code).toBe('CONFLICT');
    const err2 = await callErr(h, 'users.update', { id: admin.userId, role: 'CASHIER' }, admin.token);
    expect(err2.code).toBe('CONFLICT');
    h.close();
  });

  it('revokes permissions immediately when a role is downgraded or the user is disabled', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'supx');
    expect(supervisor.permissions).toContain('sales.void.approve');

    await callOk(h, 'users.update', { id: supervisor.userId, role: 'CASHIER' }, admin.token);
    // Same token: the main process re-reads the account on every invocation.
    const err = await callErr(h, 'sales.approveVoid', { id: 1 }, supervisor.token);
    expect(err.code).toBe('FORBIDDEN');

    await callOk(h, 'users.update', { id: supervisor.userId, active: false }, admin.token);
    const disabled = await callErr(h, 'products.list', {}, supervisor.token);
    expect(disabled.code).toBe('UNAUTHENTICATED');
    h.close();
  });
});
