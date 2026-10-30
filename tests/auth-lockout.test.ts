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
import type {
  AppState,
  AuditEntry,
  SessionInfo,
  SettingsPayload,
  SetupStatus,
  UserAccount
} from '../src/shared/types';

const LOGO = `data:image/png;base64,${Buffer.from('tiny-logo').toString('base64')}`;

async function activatedHarness(edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH' = 'PHARMACY') {
  const h = createHarness();
  await callOk(h, 'license.activate', {
    masterPassword: requireMasterPassword(),
    edition,
    customerName: 'Infoflex Test Customer',
    expiresAt: futureIso()
  });
  return h;
}

describe('phase 3 — first-run setup', () => {
  it('saves the administrator and the whole store profile in one transaction', async () => {
    const h = await activatedHarness('PHARMACY');
    try {
      await callOk(h, 'setup.complete', {
        storeName: 'Bright Care Pharmacy',
        storeAddress: '12 Allen Avenue, Ikeja',
        storePhone: '0803 000 0000',
        storeEmail: 'hello@brightcare.example',
        storeLicenceNo: 'PCN/LAG/2026/00123',
        storeVatNo: 'VAT 01234567-0001',
        storeLogo: LOGO,
        receiptFooter: 'Goods sold are not returnable after 7 days.',
        thankYouNote: 'Thank you for trusting Bright Care.',
        idleTimeoutMinutes: 20,
        adminUsername: 'ada',
        adminFullName: 'Ada Obi',
        adminEmail: 'ada@brightcare.example',
        adminPassword: 'Bright2026pass'
      });

      const session = await callOk<SessionInfo>(h, 'auth.login', {
        username: 'ada',
        password: 'Bright2026pass'
      });
      expect(session.fullName).toBe('Ada Obi');
      expect(session.storeName).toBe('Bright Care Pharmacy');

      const settings = await callOk<SettingsPayload>(h, 'settings.read', {}, session.token);
      expect(settings.storeEmail).toBe('hello@brightcare.example');
      expect(settings.storeLicenceNo).toBe('PCN/LAG/2026/00123');
      expect(settings.storeVatNo).toBe('VAT 01234567-0001');
      expect(settings.storeLogo).toBe(LOGO);
      expect(settings.thankYouNote).toBe('Thank you for trusting Bright Care.');
      expect(settings.idleTimeoutMinutes).toBe(20);

      const state = await callOk<AppState>(h, 'app.state');
      expect(state.storeName).toBe('Bright Care Pharmacy');
      expect(state.idleTimeoutMinutes).toBe(20);
      expect(state.setup.setupRequired).toBe(false);
    } finally {
      h.close();
    }
  });

  it('rolls back the store details when the administrator details are invalid', async () => {
    const h = await activatedHarness();
    try {
      const err = await callErr(h, 'setup.complete', {
        storeName: 'Half Saved Pharmacy',
        storePhone: '0803 000 0000',
        adminUsername: 'admin',
        adminFullName: 'Ada',
        adminPassword: 'short'
      });
      expect(err.code).toBe('VALIDATION');

      // Nothing from the failed attempt is left behind.
      const stored = h.db.handle.prepare("SELECT value FROM settings WHERE key = 'store_name'").get() as
        | { value: string }
        | undefined;
      expect(stored?.value ?? '').toBe('');
      const users = h.db.handle.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      expect(users.n).toBe(0);

      const status = await callOk<SetupStatus>(h, 'setup.status');
      expect(status.setupRequired).toBe(true);
      expect(status.adminConfigured).toBe(false);
      expect(status.storeConfigured).toBe(false);
    } finally {
      h.close();
    }
  });

  it('rejects an empty store name and a bad logo', async () => {
    const h = await activatedHarness();
    try {
      const blank = await callErr(h, 'setup.complete', {
        storeName: '   ',
        adminUsername: 'admin',
        adminFullName: 'Ada Obi',
        adminPassword: 'Bright2026pass'
      });
      expect(blank.code).toBe('VALIDATION');
      expect(blank.message.toLowerCase()).toContain('store name');

      const badLogo = await callErr(h, 'setup.complete', {
        storeName: 'Bright Care',
        storeLogo: 'not-an-image',
        adminUsername: 'admin',
        adminFullName: 'Ada Obi',
        adminPassword: 'Bright2026pass'
      });
      expect(badLogo.code).toBe('VALIDATION');
    } finally {
      h.close();
    }
  });

  it('labels the store field for the edition', async () => {
    for (const [edition, label] of [
      ['PHARMACY', 'Pharmacy name'],
      ['SUPERMARKET', 'Supermarket name'],
      ['BOTH', 'Business name']
    ] as const) {
      const h = await activatedHarness(edition);
      try {
        const status = await callOk<SetupStatus>(h, 'setup.status');
        expect(status.storeNameLabel).toBe(label);
      } finally {
        h.close();
      }
    }
  });
});

describe('phase 3 — passwords, lockout and sessions', () => {
  it('stores bcrypt hashes, never plaintext', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      await makeUser(h, admin, 'CASHIER', 'cash9', 'Plaintext123');
      const row = h.db.handle
        .prepare('SELECT password_hash, password_algo FROM users WHERE username = ?')
        .get('cash9') as { password_hash: string; password_algo: string };
      expect(row.password_hash.startsWith('$2')).toBe(true);
      expect(row.password_hash).not.toContain('Plaintext123');
      expect(row.password_algo).toBe('bcrypt');
      // 10 rounds by default.
      expect(Number(row.password_hash.split('$')[2])).toBeGreaterThanOrEqual(8);
    } finally {
      h.close();
    }
  });

  it('locks the account after five failures and only an administrator can unlock it', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      const user = await makeUser(h, admin, 'CASHIER', 'cash2');

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const err = await callErr(h, 'auth.login', { username: 'cash2', password: 'wrong-pass' });
        expect(['UNAUTHENTICATED', 'FORBIDDEN']).toContain(err.code);
      }

      // Even the right password is refused while the lock stands.
      const locked = await callErr(h, 'auth.login', { username: 'cash2', password: 'userpass123' });
      expect(locked.code).toBe('FORBIDDEN');
      expect(locked.message.toLowerCase()).toContain('locked');

      const listed = await callOk<UserAccount[]>(h, 'users.list', {}, admin.token);
      const account = listed.find((row) => row.username === 'cash2')!;
      expect(account.isLocked).toBe(true);
      expect(account.failedAttempts).toBe(5);

      // The administrator's own session is unaffected.
      expect((await callOk<unknown[]>(h, 'products.list', {}, admin.token)).length).toBeGreaterThanOrEqual(0);

      await callOk<UserAccount>(h, 'users.unlock', { id: user.userId }, admin.token);
      const after = await callOk<SessionInfo>(h, 'auth.login', {
        username: 'cash2',
        password: 'userpass123'
      });
      expect(after.role).toBe('CASHIER');

      const audit = await callOk<AuditEntry[]>(h, 'audit.list', { limit: 100 }, admin.token);
      const actions = audit.map((entry) => entry.action);
      expect(actions).toContain('auth.login.failed');
      expect(actions).toContain('auth.account.locked');
      expect(actions).toContain('user.unlock');
      expect(actions).toContain('auth.login');
    } finally {
      h.close();
    }
  });

  it('records failed sign-ins without revealing whether the username exists', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      const unknown = await callErr(h, 'auth.login', { username: 'ghost', password: 'whatever1' });
      expect(unknown.message).toBe('Incorrect username or password.');
      const audit = await callOk<AuditEntry[]>(h, 'audit.list', { limit: 50 }, admin.token);
      const failed = audit.filter((entry) => entry.action === 'auth.login.failed');
      expect(failed.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(failed)).not.toContain('whatever1');
    } finally {
      h.close();
    }
  });

  it('ends the session after the configured idle time', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    try {
      await callOk(h, 'settings.update', { idleTimeoutMinutes: 5 }, admin.token);
      const session = h.ctx.sessions.get(admin.token)!;
      // Pretend the cashier walked away for six minutes.
      session.lastSeen = Date.now() - 6 * 60_000;
      const expired = await callErr(h, 'auth.me', {}, admin.token);
      expect(expired.code).toBe('UNAUTHENTICATED');

      const state = await callOk<AppState>(h, 'app.state');
      expect(state.session).toBeNull();
      expect(state.idleTimeoutMinutes).toBe(5);
    } finally {
      h.close();
    }
  });

  it('keeps store settings administrator-only', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    try {
      const supervisor = await makeUser(h, admin, 'SUPERVISOR', 'sup9');
      const denied = await callErr(h, 'settings.update', { storeName: 'Hijacked Stores' }, supervisor.token);
      expect(denied.code).toBe('FORBIDDEN');
      const cashier = await makeUser(h, admin, 'CASHIER', 'cash8');
      expect((await callErr(h, 'users.unlock', { id: supervisor.userId }, cashier.token)).code).toBe('FORBIDDEN');
    } finally {
      h.close();
    }
  });
});
