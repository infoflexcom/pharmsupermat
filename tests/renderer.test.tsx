// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../src/renderer/src/App';
import { AppProvider } from '../src/renderer/src/state';
import type { AppState, FeatureFlags, LicenseStatus } from '../src/shared/types';

const featureFlags = (over: Partial<FeatureFlags> = {}): FeatureFlags => ({
  edition: 'PHARMACY',
  pharmacy: true,
  supermarket: false,
  wholesale: true,
  prescriptions: true,
  itemLabel: 'Drug',
  productName: 'Infoflex Pharm',
  ...over
});

const license = (over: Partial<LicenseStatus> = {}): LicenseStatus => ({
  state: 'VALID',
  edition: 'PHARMACY',
  customerName: 'Grace Pharmacy Ikeja',
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000 * 300).toISOString(),
  daysRemaining: 300,
  features: featureFlags(),
  productName: 'Infoflex Pharm',
  ...over
});

function appState(over: Partial<AppState> = {}): AppState {
  return {
    productName: 'Infoflex Pharm',
    features: featureFlags(),
    license: license(),
    setup: { licensed: true, storeConfigured: true, adminConfigured: true, setupRequired: false },
    session: null,
    version: 'test',
    ...over
  };
}

function mockApi(state: AppState) {
  const handler = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { channel: string; payload: unknown };
    const data =
      body.channel === 'app.state'
        ? state
        : body.channel === 'reports.build'
          ? { kind: 'SALES_SUMMARY', title: 'Sales', subtitle: '', columns: [], rows: [], totals: {}, meta: {}, html: '' }
          : ['products.list', 'sales.list', 'returns.list', 'users.list', 'audit.list', 'inventory.list', 'stock.batches', 'backup.list'].includes(body.channel)
            ? []
            : {};
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', handler);
  return handler;
}

let container: HTMLDivElement;
let root: Root;

async function renderApp(state: AppState) {
  mockApi(state);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <AppProvider>
        <App />
      </AppProvider>
    );
  });
  // Let the bootstrap promise settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return container;
}

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('renderer boot flow', () => {
  it('shows the activation screen before a licence exists', async () => {
    const el = await renderApp(
      appState({
        productName: 'Infoflex',
        license: license({ state: 'NONE', edition: null, features: null, productName: 'Infoflex' }),
        setup: { licensed: false, storeConfigured: false, adminConfigured: false, setupRequired: false }
      })
    );
    expect(el.textContent).toContain('Activate Infoflex');
    expect(el.textContent).toContain('Strategy | Consulting | Innovation');
    expect(el.textContent).toContain('Vendor master password');
  });

  it('shows first-run setup after activation', async () => {
    const el = await renderApp(
      appState({
        setup: { licensed: true, storeConfigured: false, adminConfigured: false, setupRequired: true }
      })
    );
    expect(el.textContent).toContain('Welcome to Infoflex Pharm');
    expect(el.textContent).toContain('Store name (required)');
  });

  it('shows the branded login page when the store is configured', async () => {
    const el = await renderApp(appState());
    expect(el.textContent).toContain('Infoflex Pharm');
    expect(el.textContent).toContain('Grace Pharmacy Ikeja');
    expect(el.textContent).toContain('Sign in');
    const logo = el.querySelector('img');
    expect(logo?.getAttribute('src')).toBeTruthy();
  });

  it('warns when the licence is close to expiry', async () => {
    const el = await renderApp(
      appState({ license: license({ state: 'EXPIRING', daysRemaining: 9 }) })
    );
    expect(el.textContent).toMatch(/expires in 9 day/i);
  });

  it('routes a signed-in admin to the dashboard with a permission-aware sidebar', async () => {
    const permissions = [
      'pos.sell',
      'sales.view.own',
      'sales.view.all',
      'sales.void.approve',
      'returns.create',
      'returns.approve',
      'products.view',
      'products.manage',
      'prices.set',
      'stock.receive',
      'reports.view.own',
      'reports.view.all',
      'users.manage',
      'settings.manage',
      'backup.manage',
      'audit.view',
      'license.manage'
    ];
    const el = await renderApp(
      appState({
        session: {
          token: 't',
          userId: 1,
          username: 'admin',
          fullName: 'Ada Obi',
          role: 'ADMIN',
          permissions,
          mustChangePassword: false,
          storeName: 'Grace Pharmacy'
        }
      })
    );
    expect(el.textContent).toContain('Point of Sale');
    expect(el.textContent).toContain('Inventory');
    expect(el.textContent).toContain('Users');
    expect(el.textContent).toContain('Ada Obi');
    expect(el.textContent).toContain('Administrator');
    expect(el.textContent).toContain('Grace Pharmacy');
  });

  it('hides admin modules from a cashier sidebar', async () => {
    const el = await renderApp(
      appState({
        features: featureFlags({ supermarket: true, pharmacy: false }),
        session: {
          token: 't2',
          userId: 2,
          username: 'cashier',
          fullName: 'Chidi Cashier',
          role: 'CASHIER',
          permissions: ['pos.sell', 'sales.view.own', 'returns.create', 'products.view', 'reports.view.own'],
          mustChangePassword: false,
          storeName: 'Mega Mart'
        }
      })
    );
    expect(el.textContent).toContain('Point of Sale');
    expect(el.textContent).not.toContain('Audit Trail');
    expect(el.textContent).not.toContain('Backup & Restore');
    expect(el.textContent).not.toContain('Users');
    expect(el.textContent).toContain('Cashier');
  });

  it('forces a password change and hides the app chrome', async () => {
    const el = await renderApp(
      appState({
        session: {
          token: 't3',
          userId: 3,
          username: 'newbie',
          fullName: 'New User',
          role: 'CASHIER',
          permissions: ['pos.sell'],
          mustChangePassword: true,
          storeName: 'Grace Pharmacy'
        }
      })
    );
    expect(el.textContent).toContain('Set a new password');
    expect(el.textContent).not.toContain('Point of Sale');
  });
});
