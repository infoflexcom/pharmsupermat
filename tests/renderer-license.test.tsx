// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../src/renderer/src/App';
import { AppProvider } from '../src/renderer/src/state';
import { Layout } from '../src/renderer/src/components/Layout';
import type { AppState, FeatureFlags, LicenseStatus, SessionInfo } from '../src/shared/types';

const features: FeatureFlags = {
  edition: 'PHARMACY',
  pharmacy: true,
  supermarket: false,
  wholesale: true,
  prescriptions: true,
  itemLabel: 'Drug',
  productName: 'Infoflex Pharm'
};

const baseLicense = (over: Partial<LicenseStatus> = {}): LicenseStatus => ({
  state: 'VALID',
  edition: 'PHARMACY',
  customerName: null,
  issuedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000 * 200).toISOString(),
  startsOn: '2026-01-01',
  endsOn: new Date(Date.now() + 86_400_000 * 200).toISOString().slice(0, 10),
  daysRemaining: 200,
  features,
  productName: 'Infoflex Pharm',
  usable: true,
  lockReason: null,
  endingSoon: false,
  warning: null,
  serverTime: new Date().toISOString(),
  ...over
});

const session: SessionInfo = {
  token: 'tok',
  userId: 1,
  username: 'admin',
  fullName: 'Ada Obi',
  role: 'ADMIN',
  permissions: [
    'pos.sell',
    'sales.view.own',
    'sales.view.all',
    'products.view',
    'products.manage',
    'prices.set',
    'users.manage',
    'settings.manage',
    'reports.view.own',
    'reports.view.all',
    'audit.view',
    'license.manage'
  ],
  mustChangePassword: false,
  storeName: 'Grace Pharmacy'
};

function state(over: Partial<AppState> = {}): AppState {
  return {
    productName: 'Infoflex Pharm',
    features,
    license: baseLicense(),
    setup: {
      licensed: true,
      storeConfigured: true,
      adminConfigured: true,
      setupRequired: false,
      storeNameLabel: 'Pharmacy name'
    },
    session,
    version: 'test',
    storeName: 'Grace Pharmacy',
    idleTimeoutMinutes: 15,
    ...over
  };
}

let container: HTMLDivElement;
let root: Root;
let handler: ReturnType<typeof vi.fn>;

function mockApi(appState: AppState) {
  handler = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { channel: string; payload: Record<string, unknown> };
    let data: unknown = {};
    if (body.channel === 'app.state') data = appState;
    else if (body.channel === 'license.verifyMaster') data = { ok: true, failures: 0, retryAfterSeconds: 0 };
    else if (body.channel === 'license.activate') data = baseLicense({ endsOn: String(body.payload.endsOn) });
    else if (body.channel === 'license.unlock') data = baseLicense();
    else if (body.channel === 'license.history') data = [];
    else if (
      ['products.list', 'sales.list', 'returns.list', 'users.list', 'audit.list', 'inventory.list', 'backup.list', 'dashboard.recent'].includes(
        body.channel
      )
    )
      data = [];
    else if (body.channel === 'dashboard.get')
      data = {
        todaySales: 0,
        todayTransactions: 0,
        todayReturns: 0,
        weekSales: 0,
        lowStockCount: 0,
        expiringCount: 0,
        pendingVoids: 0,
        pendingReturns: 0,
        recentSales: [],
        topProducts: []
      };
    else if (body.channel === 'settings.read')
      data = {
        storeName: 'Grace Pharmacy',
        storeAddress: '',
        storePhone: '',
        storeEmail: '',
        storeLicenceNo: '',
        storeVatNo: '',
        storeLogo: '',
        receiptFooter: '',
        thankYouNote: '',
        returnLimit: 0,
        returnWindowDays: 7,
        lowStockAlerts: true,
        licenseExpiryWarningDays: 30,
        idleTimeoutMinutes: 15
      };
    return new Response(JSON.stringify({ ok: true, data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  vi.stubGlobal('fetch', handler);
}

async function mount(node: React.ReactNode, appState: AppState) {
  mockApi(appState);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AppProvider>{node}</AppProvider>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  return container;
}

function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
}

async function type(input: HTMLInputElement, value: string) {
  setValue(input, value);
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

describe('activation wizard', () => {
  it('asks for the master password first and hides the product branding', async () => {
    const el = await mount(
      <App />,
      state({
        license: baseLicense({
          state: 'NONE',
          edition: null,
          features: null,
          usable: false,
          lockReason: 'NONE',
          startsOn: null,
          endsOn: null,
          daysRemaining: null,
          productName: 'Infoflex'
        }),
        setup: {
          licensed: false,
          storeConfigured: false,
          adminConfigured: false,
          setupRequired: false,
          storeNameLabel: 'Store name'
        },
        session: null,
        storeName: null
      })
    );

    expect(el.textContent).toContain('Activation Required');
    expect(el.textContent).toContain('Vendor master password');
    expect(el.textContent).toContain('Strategy | Consulting | Innovation');
    // No edition-specific branding before activation.
    expect(el.textContent).not.toContain('Infoflex Pharm');

    const toggle = el.querySelector('.password-toggle') as HTMLButtonElement;
    const password = el.querySelector('[data-testid="activation-password"]') as HTMLInputElement;
    expect(password.getAttribute('type')).toBe('password');
    await act(async () => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect((el.querySelector('[data-testid="activation-password"]') as HTMLInputElement).getAttribute('type')).toBe(
      'text'
    );
  });

  it('shows the edition and period step after the password is accepted and saves the range', async () => {
    const el = await mount(
      <App />,
      state({
        license: baseLicense({
          state: 'NONE',
          edition: null,
          features: null,
          usable: false,
          lockReason: 'NONE',
          startsOn: null,
          endsOn: null,
          daysRemaining: null,
          productName: 'Infoflex'
        }),
        setup: {
          licensed: false,
          storeConfigured: false,
          adminConfigured: false,
          setupRequired: false,
          storeNameLabel: 'Store name'
        },
        session: null,
        storeName: null
      })
    );

    await type(el.querySelector('[data-testid="activation-password"]') as HTMLInputElement, 'secret');
    await act(async () => {
      (el.querySelector('[data-testid="activation-continue"]') as HTMLButtonElement).click();
    });

    expect(el.textContent).toContain('Choose the edition and licence period');
    expect(el.querySelector('[data-testid="edition-pharmacy"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="quick-2y"]')).toBeTruthy();

    const start = el.querySelector('[data-testid="license-start"]') as HTMLInputElement;
    const end = el.querySelector('[data-testid="license-end"]') as HTMLInputElement;
    expect(start.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(end.value > start.value).toBe(true);

    await act(async () => {
      (el.querySelector('[data-testid="quick-3y"]') as HTMLButtonElement).click();
    });
    const extended = (el.querySelector('[data-testid="license-end"]') as HTMLInputElement).value;
    expect(extended).toBe(`${Number(start.value.slice(0, 4)) + 3}${start.value.slice(4)}`);

    await act(async () => {
      (el.querySelector('[data-testid="activation-save"]') as HTMLButtonElement).click();
    });
    const calls = (handler.mock.calls as unknown[][]).map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)).channel as string
    );
    expect(calls).toContain('license.activate');
  });
});

describe('licence lock screen', () => {
  it('locks an expired install and offers the update password', async () => {
    const el = await mount(
      <App />,
      state({
        license: baseLicense({
          state: 'EXPIRED',
          usable: false,
          lockReason: 'EXPIRED',
          daysRemaining: 0,
          message: 'License Expired — Software Update Required.'
        }),
        session: null
      })
    );

    expect(el.querySelector('[data-testid="license-lock"]')).toBeTruthy();
    expect(el.textContent).toContain('License Expired — Software Update Required');
    expect(el.textContent).toContain('Your data is safe.');
    expect(el.textContent).toContain('Update password');
    // The app shell is gone.
    expect(el.textContent).not.toContain('Point of Sale');
  });

  it('asks for a new period after the password on a tampered licence', async () => {
    const el = await mount(
      <App />,
      state({
        license: baseLicense({ state: 'TAMPERED', usable: false, lockReason: 'TAMPERED' }),
        session: null
      })
    );
    expect(el.textContent).toContain('Licence file needs to be re-signed');

    await type(el.querySelector('[data-testid="lock-password"]') as HTMLInputElement, 'secret');
    await act(async () => {
      (el.querySelector('[data-testid="lock-continue"]') as HTMLButtonElement).click();
    });
    expect(el.textContent).toContain('Enter a new licence period');
    expect(el.querySelector('[data-testid="lock-save"]')).toBeTruthy();
  });

  it('unlocks a clock-rollback lock with the password alone', async () => {
    const el = await mount(
      <App />,
      state({
        license: baseLicense({ state: 'CLOCK_ROLLBACK', usable: false, lockReason: 'CLOCK_ROLLBACK' }),
        session: null
      })
    );
    expect(el.textContent).toContain('System clock change detected');
    expect(el.querySelector('[data-testid="lock-unlock"]') ?? el.querySelector('[data-testid="lock-continue"]')).toBeTruthy();

    await type(el.querySelector('[data-testid="lock-password"]') as HTMLInputElement, 'secret');
    await act(async () => {
      (el.querySelector('[data-testid="lock-continue"]') as HTMLButtonElement).click();
    });
    const calls = (handler.mock.calls as unknown[][]).map((call) =>
      JSON.parse(String((call[1] as RequestInit).body)).channel as string
    );
    expect(calls).toContain('license.unlock');
    expect(calls).not.toContain('license.activate');
  });
});

describe('licence banners', () => {
  it('shows the renewal reminder to an admin inside the warning window', async () => {
    const el = await mount(<Layout view="dashboard" onNavigate={() => {}}>
      <div>content</div>
    </Layout>, state({
      license: baseLicense({
        state: 'EXPIRING',
        daysRemaining: 7,
        warning: { level: 7, daysRemaining: 7 },
        endsOn: '2026-11-06'
      })
    }));
    const banner = el.querySelector('[data-testid="license-warning"]');
    expect(banner?.textContent).toContain('7 days');
    expect(banner?.textContent).toMatch(/Renew it from Licence/i);
  });

  it('warns every user in the last ten minutes', async () => {
    const el = await mount(
      <Layout view="dashboard" onNavigate={() => {}}>
        <div>content</div>
      </Layout>,
      state({
        license: baseLicense({
          state: 'EXPIRING',
          daysRemaining: 0,
          expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(),
          endingSoon: true,
          warning: { level: 1, daysRemaining: 0 }
        })
      })
    );
    const banner = el.querySelector('[data-testid="license-ending-soon"]');
    expect(banner?.textContent).toMatch(/Finish or save/i);
  });
});
