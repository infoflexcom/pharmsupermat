// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../src/renderer/src/App';
import { AppProvider } from '../src/renderer/src/state';
import type { AppState, FeatureFlags, LicenseStatus } from '../src/shared/types';
import { availableNav } from '../src/renderer/src/components/Layout';

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
    setup: {
      licensed: true,
      storeConfigured: true,
      adminConfigured: true,
      setupRequired: false,
      storeNameLabel: 'Pharmacy name'
    },
    session: null,
    version: 'test',
    storeName: 'Grace Pharmacy Ikeja',
    idleTimeoutMinutes: 15,
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

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
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
        setup: {
          licensed: false,
          storeConfigured: false,
          adminConfigured: false,
          setupRequired: false,
          storeNameLabel: 'Pharmacy name'
        }
      })
    );
    expect(el.textContent).toContain('Activate Infoflex');
    expect(el.textContent).toContain('Strategy | Consulting | Innovation');
    expect(el.textContent).toContain('Vendor master password');
  });

  it('shows first-run setup after activation', async () => {
    const el = await renderApp(
      appState({
        setup: {
          licensed: true,
          storeConfigured: false,
          adminConfigured: false,
          setupRequired: true,
          storeNameLabel: 'Pharmacy name'
        }
      })
    );
    expect(el.textContent).toContain('Welcome to Infoflex Pharm');
    expect(el.textContent).toContain('Pharmacy name (required)');
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


  it('toggles password visibility and shows the edition, store name and version', async () => {
    const el = await renderApp(appState());

    const toggle = el.querySelector('.password-toggle') as HTMLButtonElement;
    const passwordInput = el.querySelector('input[autocomplete="current-password"]') as HTMLInputElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(passwordInput.getAttribute('type')).toBe('password');

    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect((el.querySelector('.password-toggle') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
    expect((el.querySelector('input[autocomplete="current-password"]') as HTMLInputElement).getAttribute('type')).toBe(
      'text'
    );

    expect(el.textContent).toContain('Pharmacy edition');
    expect(el.querySelector('[data-testid="login-store-name"]')?.textContent).toBe('Grace Pharmacy Ikeja');
    expect(el.textContent).toContain('Infoflex vtest');
    expect(el.textContent).toContain('Works offline');
    expect(el.textContent).not.toContain('Forgot password');
  });

  it('previews the store name on a receipt as it is typed during setup', async () => {
    const el = await renderApp(
      appState({
        setup: {
          licensed: true,
          storeConfigured: false,
          adminConfigured: false,
          setupRequired: true,
          storeNameLabel: 'Supermarket name'
        },
        features: featureFlags({ edition: 'SUPERMARKET', pharmacy: false, supermarket: true })
      })
    );
    expect(el.textContent).toContain('Supermarket name (required)');
    expect(el.textContent).toContain('Administrator account');
    expect(el.textContent).toContain('Your supermarket name');

    const input = el.querySelector('[data-testid="setup-store-name"]') as HTMLInputElement;
    setValue(input, 'Mega Mart Lekki');
    await act(async () => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(el.querySelector('[aria-label="Receipt preview"]')?.textContent).toContain('Mega Mart Lekki');
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

describe('sidebar gating by role and edition', () => {
  const keys = (permissions: string[], features: Record<string, boolean>) =>
    availableNav(permissions, features).map((item) => item.key);

  it('gives pharmacy admins batches but not supermarket modules', () => {
    const nav = keys(
      [
        'pos.sell',
        'wholesale.sell',
        'products.view',
        'products.manage',
        'prices.set',
        'stock.receive',
        'stock.adjust',
        'returns.create',
        'reports.view.own',
        'reports.view.all',
        'users.manage',
        'settings.manage',
        'backup.manage',
        'audit.view',
        'license.manage'
      ],
      { pharmacy: true, supermarket: false, wholesale: true, prescriptions: true }
    );
    expect(nav).toContain('batches');
    expect(nav).not.toContain('departments');
    expect(nav).not.toContain('promotions');
    expect(nav).not.toContain('loyalty');
    expect(nav).not.toContain('shifts');
    expect(nav).toEqual(expect.arrayContaining(['dashboard', 'pos', 'products', 'stock', 'returns', 'reports']));
  });

  it('gives supermarket admins departments, promotions, loyalty and shifts but no batches', () => {
    const nav = keys(
      [
        'pos.sell',
        'products.view',
        'stock.receive',
        'reports.view.own',
        'users.manage',
        'settings.manage',
        'audit.view'
      ],
      { pharmacy: false, supermarket: true, wholesale: true, prescriptions: false }
    );
    expect(nav).toEqual(expect.arrayContaining(['departments', 'promotions', 'loyalty', 'shifts']));
    expect(nav).not.toContain('batches');
    // Administration stays admin-only via permission gates.
    expect(nav).toContain('users');
    expect(nav).toContain('settings');
  });

  it('keeps administration out of a cashier sidebar', () => {
    const nav = keys(['pos.sell', 'sales.view.own', 'returns.create', 'products.view', 'reports.view.own'], {
      pharmacy: true,
      supermarket: false,
      wholesale: false,
      prescriptions: true
    });
    expect(nav).toEqual(expect.arrayContaining(['pos', 'returns', 'products', 'reports']));
    for (const blocked of ['users', 'settings', 'audit', 'backup', 'license', 'wholesale']) {
      expect(nav).not.toContain(blocked);
    }
  });
});
