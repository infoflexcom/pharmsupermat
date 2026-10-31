import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  MASTER_PASSWORD,
  callErr,
  callOk,
  controllableClock,
  createHarness,
  requireMasterPassword,
  type Harness
} from './helpers';
import type {
  AppState,
  AuditEntry,
  LicenseHistoryEntry,
  LicenseStatus,
  SessionInfo,
  SetupStatus
} from '../src/shared/types';
import {
  addDays,
  addYears,
  daysBetween,
  isBusinessDate,
  localDate
} from '../src/shared/license-dates';

const PASSWORD = () => requireMasterPassword();

async function activate(
  h: Harness,
  options: { edition?: 'PHARMACY' | 'SUPERMARKET' | 'BOTH'; startsOn: string; endsOn: string } = {
    startsOn: localDate(),
    endsOn: addYears(localDate(), 1)
  }
): Promise<LicenseStatus> {
  return callOk<LicenseStatus>(h, 'license.activate', {
    masterPassword: PASSWORD(),
    edition: options.edition ?? 'PHARMACY',
    startsOn: options.startsOn,
    endsOn: options.endsOn
  });
}

async function completeSetup(h: Harness, storeName = 'Bright Care Pharmacy') {
  return callOk<SetupStatus>(h, 'setup.complete', {
    storeName,
    storeAddress: '12 Allen Avenue, Ikeja',
    storePhone: '0803 000 0000',
    adminUsername: 'admin',
    adminFullName: 'Ada Obi',
    adminPassword: 'adminpass123'
  });
}

async function signIn(h: Harness, password = 'adminpass123'): Promise<SessionInfo> {
  return callOk<SessionInfo>(h, 'auth.login', { username: 'admin', password });
}

/** A harness whose licence period starts today and runs for `days` days. */
async function activeInstall(days: number, edition: 'PHARMACY' | 'SUPERMARKET' | 'BOTH' = 'PHARMACY') {
  const clock = controllableClock();
  const h = createHarness({ now: clock.now });
  const now = localDate(clock.current());
  await activate(h, { edition, startsOn: now, endsOn: addDays(now, days) });
  await completeSetup(h);
  const admin = await signIn(h);
  return { h, clock, admin };
}

describe('licence period maths', () => {
  it('treats the end date as exclusive and counts whole days', () => {
    expect(daysBetween('2026-01-01', '2027-01-01')).toBe(365);
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(isBusinessDate('2026-02-29')).toBe(false);
    expect(isBusinessDate('2026-02-28')).toBe(true);
    expect(localDate(new Date(2026, 9, 30, 23, 59))).toBe('2026-10-30');
  });

  it('rejects impossible or backwards ranges before anything is saved', async () => {
    const h = createHarness();
    const today = localDate();

    for (const [startsOn, endsOn] of [
      [today, today],
      [addDays(today, 5), addDays(today, 2)],
      [addDays(today, 1), addYears(today, 1)],
      [addDays(today, -30), today]
    ]) {
      const err = await callErr(h, 'license.activate', {
        masterPassword: PASSWORD(),
        edition: 'PHARMACY',
        startsOn,
        endsOn
      });
      expect(err.code).toBe('VALIDATION');
    }
    expect((await callOk<LicenseStatus>(h, 'license.status')).state).toBe('NONE');
    h.close();
  });
});

describe('activation is gated by the master password', () => {
  it('blocks every business channel until a licence exists', async () => {
    const h = createHarness();
    expect((await callOk<LicenseStatus>(h, 'license.status')).state).toBe('NONE');
    expect((await callErr(h, 'setup.status')).code).toBe('LICENSE_REQUIRED');
    expect((await callErr(h, 'setup.complete', { storeName: 'X', adminUsername: 'a', adminFullName: 'A', adminPassword: 'secret123' })).code).toBe('LICENSE_REQUIRED');
    expect((await callErr(h, 'auth.login', { username: 'admin', password: 'adminpass123' })).code).toBe('LICENSE_REQUIRED');
    h.close();
  });

  it('never accepts a wrong password, and delays attempts after five failures', async () => {
    const clock = controllableClock();
    const h = createHarness({ now: clock.now });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const err = await callErr(h, 'license.verifyMaster', { masterPassword: `wrong-${attempt}` });
      expect(err.code).toBe('FORBIDDEN');
    }

    const throttled = await callErr(h, 'license.verifyMaster', { masterPassword: PASSWORD() });
    expect(throttled.code).toBe('FORBIDDEN');
    expect(throttled.message).toContain('30 second');
    expect((throttled.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(30);

    // Still locked one second before the delay elapses…
    clock.advanceSeconds(29);
    expect((await callErr(h, 'license.verifyMaster', { masterPassword: PASSWORD() })).code).toBe('FORBIDDEN');
    // …and the correct password is accepted once it has.
    clock.advanceSeconds(2);
    const ok = await callOk<{ ok: boolean }>(h, 'license.verifyMaster', { masterPassword: PASSWORD() });
    expect(ok.ok).toBe(true);

    // A success resets the counter; the ladder starts again at five failures
    // and the sixth attempt is delayed by 30s, then a minute.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await callErr(h, 'license.verifyMaster', { masterPassword: `bad-${attempt}` })).code).toBe('FORBIDDEN');
    }
    clock.advanceSeconds(31);
    expect((await callErr(h, 'license.verifyMaster', { masterPassword: 'still-bad' })).code).toBe('FORBIDDEN');
    const minute = await callErr(h, 'license.verifyMaster', { masterPassword: PASSWORD() });
    expect((minute.details as { retryAfterSeconds: number }).retryAfterSeconds).toBe(60);

    // The unlicensed app still writes its security log; read it directly.
    const auditRows = h.db.handle
      .prepare("SELECT action, details FROM audit_log WHERE action LIKE 'license.%'")
      .all() as Array<{ action: string; details: string | null }>;
    const attempted = auditRows.filter((row) => row.action.includes('failed'));
    expect(attempted.length).toBeGreaterThanOrEqual(6);
    for (const row of attempted) {
      expect(row.details ?? '').not.toContain('wrong-1');
      expect(row.details ?? '').not.toContain('bad-1');
      expect(row.details ?? '').not.toContain(PASSWORD());
    }
    h.close();
  });

  it('activates with the chosen edition and period, then exposes the modules', async () => {
    const clock = controllableClock();
    const h = createHarness({ now: clock.now });
    const today = localDate(clock.current());

    const status = await activate(h, { edition: 'PHARMACY', startsOn: today, endsOn: addYears(today, 2) });
    expect(status.state).toBe('VALID');
    expect(status.usable).toBe(true);
    expect(status.startsOn).toBe(today);
    expect(status.endsOn).toBe(addYears(today, 2));
    expect(status.daysRemaining).toBeGreaterThan(700);
    expect(status.features?.pharmacy).toBe(true);
    expect(status.features?.supermarket).toBe(false);
    expect(status.productName).toBe('Infoflex Pharm');

    const state = await callOk<AppState>(h, 'app.state');
    expect(state.license.usable).toBe(true);
    expect(state.setup.setupRequired).toBe(true);

    await completeSetup(h);
    const admin = await signIn(h);
    expect((await callErr(h, 'mart.promotions.list', {}, admin.token)).code).toBe('EDITION_RESTRICTED');
    expect((await callOk<unknown[]>(h, 'products.list', {}, admin.token)).length).toBe(0);
    h.close();
  });

  it('derives the flagship names for each edition', async () => {
    for (const [edition, productName] of [
      ['PHARMACY', 'Infoflex Pharm'],
      ['SUPERMARKET', 'Infoflex Mart'],
      ['BOTH', 'Infoflex Pharm & Mart']
    ] as const) {
      const h = createHarness();
      const status = await activate(h, {
        edition,
        startsOn: localDate(),
        endsOn: addYears(localDate(), 1)
      });
      expect(status.productName).toBe(productName);
      expect(status.features?.edition).toBe(edition);
      expect(status.features?.pharmacy).toBe(edition !== 'SUPERMARKET');
      expect(status.features?.supermarket).toBe(edition !== 'PHARMACY');
      h.close();
    }
  });
});

describe('expiry enforcement', () => {
  it('locks the app on the end date and leaves every record intact', async () => {
    const { h, clock, admin } = await activeInstall(2, SUPERMARKET_EDITION());
    const before = await callOk<AppState>(h, 'app.state');
    expect(before.license.state).toBe('EXPIRING');
    expect(before.license.warning?.daysRemaining).toBe(2);
    expect(before.license.warning?.level).toBe(7);

    clock.advanceDays(2);
    const expired = await callOk<LicenseStatus>(h, 'license.status');
    expect(expired.state).toBe('EXPIRED');
    expect(expired.usable).toBe(false);

    const blocked = await callErr(h, 'products.list', {}, admin.token);
    expect(blocked.code).toBe('LICENSE_EXPIRED');
    // Even a valid session cannot get through the lock.
    expect((await callErr(h, 'sales.create', { lines: [{ productId: 1, qty: 1 }] }, admin.token)).code).toBe('LICENSE_EXPIRED');

    // Renewing with a new range restores the app with the store details intact.
    const renewed = await activate(h, {
      edition: 'SUPERMARKET',
      startsOn: localDate(clock.current()),
      endsOn: addYears(localDate(clock.current()), 1)
    });
    expect(renewed.state).toBe('VALID');
    // Two days without a request also ended the sign-in — re-enter and carry on.
    const again = await signIn(h);
    const settings = await callOk<{ storeName: string }>(h, 'settings.read', {}, again.token);
    expect(settings.storeName).toBe('Bright Care Pharmacy');
    h.close();
  });

  it('refuses to reuse an expired period', async () => {
    const { h, clock } = await activeInstall(1);
    const start = localDate(clock.current());
    const end = addDays(start, 1);
    clock.advanceDays(2);

    const err = await callErr(h, 'license.activate', {
      masterPassword: PASSWORD(),
      edition: 'PHARMACY',
      startsOn: start,
      endsOn: end
    });
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/already been used|future/i);

    // A fresh forward range works.
    const renewed = await activate(h, {
      edition: 'PHARMACY',
      startsOn: localDate(clock.current()),
      endsOn: addYears(localDate(clock.current()), 1)
    });
    expect(renewed.state).toBe('VALID');
    h.close();
  });

  it('rejects an end date of today or earlier when saving', async () => {
    const h = createHarness();
    const today = localDate();
    const err = await callErr(h, 'license.activate', {
      masterPassword: PASSWORD(),
      edition: 'PHARMACY',
      startsOn: addDays(today, -10),
      endsOn: today
    });
    expect(err.code).toBe('VALIDATION');
    expect(err.message).toMatch(/future/i);
    h.close();
  });
});

describe('anti-tampering', () => {
  it('locks when the clock moves backwards and unlocks with the password', async () => {
    const { h, clock, admin } = await activeInstall(365);
    clock.advanceDays(10);
    expect((await callOk<LicenseStatus>(h, 'license.status')).state).toBe('VALID');

    clock.advanceDays(-6);
    const rolled = await callOk<LicenseStatus>(h, 'license.status');
    expect(rolled.state).toBe('CLOCK_ROLLBACK');
    // Ten idle days ended the old sign-in; a new one is refused by the lock.
    expect((await callErr(h, 'products.list', {}, admin.token)).code).toBe('LICENSE_LOCKED');

    // A wrong password does not clear the lock…
    expect((await callErr(h, 'license.unlock', { masterPassword: 'nope' })).code).toBe('FORBIDDEN');
    expect((await callOk<LicenseStatus>(h, 'license.status')).state).toBe('CLOCK_ROLLBACK');

    // …the right one does.
    const unlocked = await callOk<LicenseStatus>(h, 'license.unlock', { masterPassword: PASSWORD() });
    expect(unlocked.state).toBe('VALID');
    const session = await signIn(h);
    expect((await callOk<unknown[]>(h, 'products.list', {}, session.token)).length).toBeGreaterThanOrEqual(0);
    h.close();
  });

  it('detects an edited licence record and requires a new signed period', async () => {
    const { h, admin } = await activeInstall(365);
    h.db.handle.prepare("UPDATE license_state SET ends_on = '2099-01-01' WHERE id = 1").run();

    const status = await callOk<LicenseStatus>(h, 'license.status');
    expect(status.state).toBe('TAMPERED');
    expect(status.usable).toBe(false);
    expect((await callErr(h, 'products.list', {}, admin.token)).code).toBe('LICENSE_LOCKED');

    // Unlocking without new dates is refused: the record cannot be trusted.
    expect((await callErr(h, 'license.unlock', { masterPassword: PASSWORD() })).code).toBe('LICENSE_LOCKED');

    const today = localDate();
    const renewed = await activate(h, {
      edition: 'PHARMACY',
      startsOn: today,
      endsOn: addYears(today, 1)
    });
    expect(renewed.state).toBe('VALID');
    expect(renewed.endsOn).toBe(addYears(today, 1));
    const settings = await callOk<{ storeName: string }>(h, 'settings.read', {}, admin.token);
    expect(settings.storeName).toBe('Bright Care Pharmacy');
    h.close();
  });

  it('keeps a history of every period and edition change in the database and audit log', async () => {
    const { h, clock, admin } = await activeInstall(30, SUPERMARKET_EDITION());
    const today = localDate(clock.current());

    await activate(h, {
      edition: 'BOTH',
      startsOn: today,
      endsOn: addYears(today, 2)
    });

    const history = await callOk<LicenseHistoryEntry[]>(h, 'license.history', {}, admin.token);
    expect(history.map((entry) => entry.action)).toEqual(expect.arrayContaining(['ACTIVATE', 'EDITION_CHANGE']));
    expect(history[0].edition).toBe('BOTH');
    expect(history.length).toBeGreaterThanOrEqual(2);

    const audit = await callOk<AuditEntry[]>(h, 'audit.list', { limit: 100 }, admin.token);
    const actions = audit.map((entry) => entry.action);
    expect(actions).toContain('license.activate');
    expect(actions).toContain('license.edition.change');
    h.close();
  });
});

describe('the master password never appears in plain text', () => {
  it('is absent from every shipped file and the build output', () => {
    requireMasterPassword();
    const root = join(__dirname, '..');
    const skip = new Set(['node_modules', '.git', 'release', 'data', '.arena']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (skip.has(name)) continue;
        const path = join(dir, name);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.size < 2_000_000) files.push(path);
      }
    };
    walk(root);

    const offenders = files.filter((file) => {
      try {
        return readFileSync(file, 'utf8').includes(MASTER_PASSWORD);
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
    expect(files.some((file) => file.endsWith('vendor-secrets.json'))).toBe(true);
  });
});

/** Helper kept at the bottom so the intent reads clearly above. */
function SUPERMARKET_EDITION(): 'SUPERMARKET' {
  return 'SUPERMARKET';
}
