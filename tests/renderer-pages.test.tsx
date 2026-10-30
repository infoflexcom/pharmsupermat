// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppProvider } from '../src/renderer/src/state';
import type { AppState, FeatureFlags } from '../src/shared/types';
import DashboardPage from '../src/renderer/src/pages/DashboardPage';
import PosPage from '../src/renderer/src/pages/PosPage';
import SalesPage from '../src/renderer/src/pages/SalesPage';
import ReturnsPage from '../src/renderer/src/pages/ReturnsPage';
import ProductsPage from '../src/renderer/src/pages/ProductsPage';
import InventoryPage from '../src/renderer/src/pages/InventoryPage';
import ReportsPage from '../src/renderer/src/pages/ReportsPage';
import UsersPage from '../src/renderer/src/pages/UsersPage';
import SettingsPage from '../src/renderer/src/pages/SettingsPage';
import BackupPage from '../src/renderer/src/pages/BackupPage';
import AuditPage from '../src/renderer/src/pages/AuditPage';
import LicensePage from '../src/renderer/src/pages/LicensePage';

/**
 * Every screen is mounted with a mocked bridge to prove it renders without
 * throwing and shows its heading. Catches the kind of runtime error a
 * headless review would otherwise miss.
 */

const features: FeatureFlags = {
  edition: 'BOTH',
  pharmacy: true,
  supermarket: true,
  wholesale: true,
  prescriptions: true,
  itemLabel: 'Item',
  productName: 'Infoflex Pharm & Mart'
};

const state: AppState = {
  productName: 'Infoflex Pharm & Mart',
  features,
  license: {
    state: 'VALID',
    edition: 'BOTH',
    customerName: 'Grace Pharmacy',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000 * 200).toISOString(),
    startsOn: '2026-01-01',
    endsOn: new Date(Date.now() + 86_400_000 * 200).toISOString().slice(0, 10),
    daysRemaining: 200,
    usable: true,
    lockReason: null,
    endingSoon: false,
    warning: null,
    serverTime: new Date().toISOString(),
    features,
    productName: 'Infoflex Pharm & Mart'
  },
  setup: {
    licensed: true,
    storeConfigured: true,
    adminConfigured: true,
    setupRequired: false,
    storeNameLabel: 'Pharmacy name'
  },
  session: {
    token: 'token',
    userId: 1,
    username: 'admin',
    fullName: 'Ada Obi',
    role: 'ADMIN',
    permissions: [
      'pos.sell',
      'wholesale.sell',
      'sales.view.own',
      'sales.view.all',
      'sales.void.request',
      'sales.void.approve',
      'returns.create',
      'returns.approve',
      'products.view',
      'products.manage',
      'prices.set',
      'prices.override',
      'stock.receive',
      'stock.adjust',
      'reports.view.own',
      'reports.view.all',
      'users.manage',
      'settings.manage',
      'backup.manage',
      'audit.view',
      'license.manage',
      'prescriptions.manage'
    ],
    mustChangePassword: false,
    storeName: 'Grace Pharmacy'
  },
  version: 'test',
  storeName: 'Grace Pharmacy',
  idleTimeoutMinutes: 15
};

const settings = {
  storeName: 'Grace Pharmacy',
  storeAddress: '12 Allen Avenue',
  storePhone: '0803 000 0000',
  storeEmail: 'shop@grace.example',
  storeLicenceNo: 'PCN/LAG/2026/00123',
  storeVatNo: '',
  storeLogo: '',
  receiptFooter: 'Thank you',
  thankYouNote: 'Thank you for your patronage.',
  returnLimit: 2_000_000,
  returnWindowDays: 7,
  lowStockAlerts: true,
  licenseExpiryWarningDays: 30,
  idleTimeoutMinutes: 15
};

const dashboard = {
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

const RESPONSES: Record<string, unknown> = {
  'app.state': state,
  'dashboard.get': dashboard,
  'products.list': [],
  'inventory.list': [],
  'stock.alerts': { lowStock: [], expiring: [], outOfStock: [] },
  'sales.list': [],
  'returns.list': [],
  'users.list': [],
  'audit.list': [],
  'backup.list': [],
  'settings.read': settings,
  'license.history': [],
  'products.categories': []
};

let container: HTMLDivElement;
let root: Root;

async function mount(node: React.ReactNode): Promise<HTMLDivElement> {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { channel: string };
      const data = RESPONSES[body.channel] ?? {};
      return new Response(JSON.stringify({ ok: true, data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    })
  );
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

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  vi.unstubAllGlobals();
});

const cases: { name: string; node: React.ReactNode; expect: string }[] = [
  { name: 'dashboard', node: <DashboardPage onNavigate={() => {}} />, expect: "Today's sales" },
  { name: 'POS', node: <PosPage mode="RETAIL" />, expect: 'Point of sale' },
  { name: 'wholesale', node: <PosPage mode="INVOICE" />, expect: 'Wholesale invoice' },
  { name: 'sales', node: <SalesPage />, expect: 'Sales & receipts' },
  { name: 'returns', node: <ReturnsPage />, expect: 'Find the original receipt' },
  { name: 'products', node: <ProductsPage />, expect: 'Add product' },
  { name: 'inventory', node: <InventoryPage />, expect: 'Stock on hand' },
  { name: 'reports', node: <ReportsPage />, expect: 'Run report' },
  { name: 'users', node: <UsersPage />, expect: 'Add user' },
  { name: 'settings', node: <SettingsPage />, expect: 'Store identity' },
  { name: 'backup', node: <BackupPage />, expect: 'Back up now' },
  { name: 'audit', node: <AuditPage />, expect: 'Audit trail' },
  { name: 'licence', node: <LicensePage />, expect: 'Current licence' }
];

describe('every screen renders', () => {
  for (const testCase of cases) {
    it(`renders the ${testCase.name} screen`, async () => {
      const el = await mount(testCase.node);
      expect(el.textContent).toContain(testCase.expect);
      expect(el.querySelector('.alert.error')).toBeNull();
    });
  }
});
