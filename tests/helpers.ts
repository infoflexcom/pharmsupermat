import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/main/core/db';
import { createContext, type ApiContext } from '../src/main/api/context';
import { invoke } from '../src/main/api/invoke';
import type { ApiError, Edition, Product, SessionInfo, UserAccount } from '../src/shared/types';

/**
 * The vendor master password is a secret: it is supplied to the test run as an
 * environment variable and never committed. Activation tests fail loudly with
 * instructions when it is missing.
 */
export const MASTER_PASSWORD = process.env.VENDOR_MASTER_PASSWORD ?? '';

export function requireMasterPassword(): string {
  if (!MASTER_PASSWORD) {
    throw new Error(
      'Set VENDOR_MASTER_PASSWORD in the environment to run licence tests, e.g.\n' +
        '  VENDOR_MASTER_PASSWORD="..." npm test'
    );
  }
  return MASTER_PASSWORD;
}

export interface Harness {
  ctx: ApiContext;
  db: Database;
  dir: string;
  close(): void;
}

export function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'infoflex-test-'));
  const db = new Database(join(dir, 'test.db'));
  db.open();
  const ctx = createContext({
    db,
    dataDir: dir,
    backupsDir: join(dir, 'backups'),
    version: 'test'
  });
  return {
    ctx,
    db,
    dir,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export async function callOk<T>(
  h: Harness,
  channel: string,
  payload: Record<string, unknown> = {},
  token?: string | null
): Promise<T> {
  const result = await invoke(channel, { ...payload, token: token ?? undefined }, h.ctx);
  if (!result.ok) {
    throw new Error(`${channel} failed: [${result.error.code}] ${result.error.message}`);
  }
  return result.data as T;
}

export async function callErr(
  h: Harness,
  channel: string,
  payload: Record<string, unknown> = {},
  token?: string | null
): Promise<ApiError> {
  const result = await invoke(channel, { ...payload, token: token ?? undefined }, h.ctx);
  if (result.ok) throw new Error(`${channel} unexpectedly succeeded.`);
  return result.error;
}

export function futureIso(years = 1): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date.toISOString();
}

export interface Bootstrapped {
  admin: SessionInfo;
  h: Harness;
}

export async function bootstrap(
  edition: Edition = 'PHARMACY',
  options: { storeName?: string; expiry?: string; adminPassword?: string } = {}
): Promise<Bootstrapped> {
  const h = createHarness();
  await callOk(h, 'license.activate', {
    masterPassword: requireMasterPassword(),
    edition,
    customerName: 'Infoflex Test Customer',
    expiresAt: options.expiry ?? futureIso()
  });
  await callOk(h, 'setup.complete', {
    storeName: options.storeName ?? 'Grace Pharmacy',
    storeAddress: '12 Allen Avenue, Ikeja, Lagos',
    storePhone: '0803 000 0000',
    adminUsername: 'admin',
    adminFullName: 'Ada Admin',
    adminPassword: options.adminPassword ?? 'adminpass123'
  });
  const admin = await callOk<SessionInfo>(h, 'auth.login', {
    username: 'admin',
    password: options.adminPassword ?? 'adminpass123'
  });
  return { admin, h };
}

export async function createProduct(
  h: Harness,
  admin: SessionInfo,
  overrides: Partial<Record<string, unknown>> = {}
): Promise<Product> {
  return callOk<Product>(
    h,
    'products.create',
    {
      name: 'Paracetamol 500mg',
      category: 'Analgesics',
      unit: 'pack',
      costPrice: 50_000,
      price: 80_000,
      wholesalePrice: 70_000,
      reorderLevel: 5,
      openingStock: 40,
      openingBatchNo: 'PCM-001',
      openingExpiry: new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10),
      ...overrides
    },
    admin.token
  );
}

export async function makeUser(
  h: Harness,
  admin: SessionInfo,
  role: 'SUPERVISOR' | 'CASHIER',
  username: string,
  password = 'userpass123'
): Promise<SessionInfo> {
  await callOk<UserAccount>(
    h,
    'users.create',
    { username, fullName: `${username} person`, role, password },
    admin.token
  );
  // First sign-in forces a password change, so settle that before returning.
  const session = await callOk<SessionInfo>(h, 'auth.login', { username, password });
  if (session.mustChangePassword) {
    await callOk(h, 'auth.changePassword', { newPassword: password }, session.token);
  }
  return callOk<SessionInfo>(h, 'auth.login', { username, password });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
