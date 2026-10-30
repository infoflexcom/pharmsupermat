import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MASTER_PASSWORD,
  bootstrap,
  callErr,
  callOk,
  createHarness,
  futureIso,
  requireMasterPassword
} from './helpers';
import type { LicenseStatus } from '../src/shared/types';

describe('licensing', () => {
  it('starts locked: no licence blocks setup and sales', async () => {
    const h = createHarness();
    const status = await callOk<LicenseStatus>(h, 'license.status');
    expect(status.state).toBe('NONE');

    const err = await callErr(h, 'setup.complete', {
      storeName: 'Blocked Store',
      adminUsername: 'admin',
      adminFullName: 'A',
      adminPassword: 'secret123'
    });
    expect(err.code).toBe('LICENSE_REQUIRED');

    const saleErr = await callErr(h, 'sales.create', { lines: [{ productId: 1, qty: 1 }] });
    expect(saleErr.code).toBe('LICENSE_REQUIRED');
    h.close();
  });

  it('rejects a wrong vendor master password', async () => {
    const h = createHarness();
    const err = await callErr(h, 'license.activate', {
      masterPassword: 'definitely-not-the-password',
      edition: 'PHARMACY',
      customerName: 'Wrong',
      expiresAt: futureIso()
    });
    expect(err.code).toBe('FORBIDDEN');
    expect(await callOk<LicenseStatus>(h, 'license.status')).toMatchObject({ state: 'NONE' });
    h.close();
  });

  it('stores only a salted hash of the master password', () => {
    requireMasterPassword();
    const secrets = readFileSync(join(__dirname, '../src/license/vendor-secrets.json'), 'utf8');
    expect(secrets).toContain('scrypt$');
    expect(secrets).not.toContain(MASTER_PASSWORD);
    // No plaintext password anywhere in the shipped source.
    for (const file of [
      '../src/license/license.ts',
      '../src/services/auth.ts',
      '../src/main/api/registry.ts'
    ]) {
      expect(readFileSync(join(__dirname, file), 'utf8')).not.toContain(MASTER_PASSWORD);
    }
  });

  it('activates in vendor mode and derives edition feature flags', async () => {
    const h = createHarness();
    const status = await callOk<LicenseStatus>(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      edition: 'SUPERMARKET',
      customerName: 'Mega Mart Ikeja',
      expiresAt: futureIso()
    });
    expect(status.state).toBe('VALID');
    expect(status.edition).toBe('SUPERMARKET');
    expect(status.productName).toBe('Infoflex Mart');
    expect(status.features?.supermarket).toBe(true);
    expect(status.features?.pharmacy).toBe(false);

    const state = await callOk<{ productName: string; features: { supermarket: boolean } }>(h, 'app.state');
    expect(state.productName).toBe('Infoflex Mart');
    expect(state.features.supermarket).toBe(true);
    h.close();
  });

  it('activates from a signed activation code and rejects a tampered code', async () => {
    const h = createHarness();
    const issued = await callOk<{ code: string }>(h, 'license.issueCode', {
      masterPassword: requireMasterPassword(),
      edition: 'BOTH',
      customerName: 'Uche Stores',
      expiresAt: futureIso(2)
    });
    expect(issued.code.startsWith('IFX1.')).toBe(true);

    const tampered = `${issued.code.slice(0, -3)}abc`;
    const err = await callErr(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      activationCode: tampered
    });
    expect(err.code).toBe('VALIDATION');

    const status = await callOk<LicenseStatus>(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      activationCode: issued.code
    });
    expect(status.edition).toBe('BOTH');
    expect(status.features?.pharmacy).toBe(true);
    expect(status.features?.supermarket).toBe(true);
    expect(status.productName).toBe('Infoflex Pharm & Mart');
    h.close();
  });

  it('detects a licence row edited outside the app', async () => {
    const { h } = await bootstrap('PHARMACY');
    h.db.handle
      .prepare("UPDATE license_state SET activation_code = 'IFX1.forged.signature' WHERE id = 1")
      .run();
    const status = await callOk<LicenseStatus>(h, 'license.status');
    expect(status.state).toBe('INVALID');
    const err = await callErr(h, 'products.list', {});
    expect(err.code).toBe('LICENSE_REQUIRED');
    h.close();
  });

  it('blocks an expired licence and allows renewal', async () => {
    const h = createHarness();
    // Issue a licence that expired an hour ago by signing it directly.
    const { signLicensePayload, buildLicensePayload, saveLicense } = await import(
      '../src/license/license'
    );
    const payload = buildLicensePayload({
      edition: 'PHARMACY',
      customerName: 'Expired Ltd',
      expiresAt: futureIso(1)
    });
    payload.expiresAt = new Date(Date.now() - 3_600_000).toISOString();
    const code = signLicensePayload(payload, requireMasterPassword());
    saveLicense(h.db, payload, code, 'test');

    const status = await callOk<LicenseStatus>(h, 'license.status');
    expect(status.state).toBe('EXPIRED');

    const err = await callErr(h, 'setup.complete', {
      storeName: 'X',
      adminUsername: 'admin',
      adminFullName: 'A',
      adminPassword: 'secret123'
    });
    expect(err.code).toBe('LICENSE_EXPIRED');

    const renewed = await callOk<LicenseStatus>(h, 'license.activate', {
      masterPassword: requireMasterPassword(),
      edition: 'PHARMACY',
      customerName: 'Expired Ltd',
      expiresAt: futureIso(1)
    });
    expect(renewed.state).toBe('VALID');
    h.close();
  });

  it('only offers supervisor accounts on supermarket licences', async () => {
    const pharmacy = await bootstrap('PHARMACY');
    const err = await callErr(
      pharmacy.h,
      'users.create',
      { username: 'sup1', fullName: 'Sup One', role: 'SUPERVISOR', password: 'secret123' },
      pharmacy.admin.token
    );
    expect(err.code).toBe('EDITION_RESTRICTED');
    pharmacy.h.close();

    const mart = await bootstrap('SUPERMARKET');
    const supervisor = await callOk<{ role: string }>(
      mart.h,
      'users.create',
      { username: 'sup1', fullName: 'Sup One', role: 'SUPERVISOR', password: 'secret123' },
      mart.admin.token
    );
    expect(supervisor.role).toBe('SUPERVISOR');
    mart.h.close();
  });

  it('requires the master password for renewal', async () => {
    const { h } = await bootstrap('PHARMACY');
    const err = await callErr(h, 'license.activate', {
      masterPassword: '',
      edition: 'BOTH',
      customerName: 'Hacker',
      expiresAt: futureIso(3)
    });
    expect(err.code).toBe('FORBIDDEN');
    h.close();
  });
});
