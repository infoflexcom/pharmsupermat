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
import StocktakePage from '../src/renderer/src/pages/StocktakePage';
import PurchaseOrdersPage from '../src/renderer/src/pages/PurchaseOrdersPage';
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
  idleTimeoutMinutes: 15,
  vatEnabled: true,
  vatRate: 7.5,
  maxDiscountPercent: 10,
  paymentCash: true,
  paymentTransfer: true,
  paymentPos: false,
  paymentCredit: false,
  poweredByFooter: true,
  receiptLayout: 'THERMAL_80',
  customerDisplay: false,
  requireShift: false,
  loyaltyPointsPer100: 1,
  loyaltyPointValue: 100,
  loyaltyRedeemEnabled: false,
  printerName: '',
  silentPrint: false,
  labelPrinterName: '',
  expiryAlertDays: 90,
  approvalTtlMinutes: 5,
  supervisorSelfApproval: true,
  scalePrefix: '2',
  scalePluDigits: 5,
  scaleWeightDigits: 5
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
  'stock.alerts': { lowStock: [], expiring: [], expired: [], outOfStock: [], expiryWindowDays: 90 },
  'stocktake.list': [],
  'purchases.list': [],
  'directory.suppliers.list': [],
  'mart.departments.list': [],
  'sales.list': [],
  'returns.list': [],
  'users.list': [],
  'audit.list': [],
  'backup.list': [],
  'backup.status': {
    count: 0,
    lastAt: null,
    daysSince: null,
    stale: true,
    warnAfterDays: 7,
    automatic: true,
    backupsDir: 'C:\\ProgramData\\Infoflex\\backups'
  },
  'print.printers': [{ name: 'EPSON TM-T20III', displayName: 'EPSON TM-T20III Receipt', isDefault: true }],
  'demo.status': {
    loaded: false,
    loadedAt: null,
    products: 0,
    batches: 0,
    users: 0,
    departments: 0,
    promotions: 0,
    customers: 0,
    loyaltyMembers: 0
  },
  'settings.preview': {
    html: '<html><body><h1>Grace Pharmacy</h1></body></html>',
    layout: 'THERMAL_80',
    settings,
    dirty: true
  },
  'settings.read': settings,
  'license.history': [],
  'products.categories': [],
  'reports.catalogue': [],
  'reports.daily': {
    date: today(),
    salesCount: 0,
    retailCount: 0,
    retailSales: 0,
    wholesaleCount: 0,
    wholesaleSales: 0,
    grossSales: 0,
    discounts: 0,
    tax: 0,
    returnsCount: 0,
    returnsTotal: 0,
    netSales: 0,
    netSalesInclVat: 0,
    cogs: 0,
    grossProfit: 0,
    payments: [],
    users: [],
    scopeUserId: null,
    html: ''
  },
  'reports.monthly': {
    month: today().slice(0, 7),
    from: `${today().slice(0, 7)}-01`,
    to: today(),
    salesCount: 0,
    retailCount: 0,
    retailSales: 0,
    wholesaleCount: 0,
    wholesaleSales: 0,
    grossSales: 0,
    discounts: 0,
    tax: 0,
    returnsCount: 0,
    returnsTotal: 0,
    netSales: 0,
    netSalesInclVat: 0,
    cogs: 0,
    grossProfit: 0,
    payments: [],
    days: [],
    chart: { labels: [], values: [] },
    html: ''
  },
  'operations.day.reconcile': {
    businessDate: today(),
    openingFloat: 0,
    salesCount: 0,
    grossSales: 0,
    discounts: 0,
    cashSales: 0,
    transferSales: 0,
    posSales: 0,
    otherSales: 0,
    returnsTotal: 0,
    cashRefunds: 0,
    expectedCash: 0,
    countedCash: null,
    variance: null,
    closedAt: null,
    closedBy: null,
    note: null,
    canClose: true,
    shiftReconciliation: false,
    shifts: [],
    cashiers: []
  }
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  { name: 'stocktake', node: <StocktakePage />, expect: 'Start new count' },
  { name: 'purchase orders', node: <PurchaseOrdersPage />, expect: 'Orders and goods received' },
  { name: 'reports', node: <ReportsPage />, expect: 'Daily summary' },
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

describe('phase 10 polish', () => {
  it('offers the optional demo data to the administrator', async () => {
    const el = await mount(<SettingsPage />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const text = el.textContent ?? '';
    expect(text).toContain('Demo data');
    expect(text).toContain('Load demo data');
    expect(text).toContain('Not loaded');
  });

  it('asks before loading demo data into a live shop', async () => {
    const el = await mount(<SettingsPage />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    const load = Array.from(el.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Load demo data')
    );
    expect(load).toBeTruthy();
    await act(async () => {
      load?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.textContent ?? '').toContain('Load demo data?');
    expect(dialog?.textContent ?? '').toContain('real data');
  });
});

describe('phase 9 screens', () => {
  it('shows the printing, pharmacy, supermarket and licence sections', async () => {
    const el = await mount(<SettingsPage />);
    // The preview is debounced, so let it settle before looking at the frame.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    const text = el.textContent ?? '';
    expect(text).toContain('Live receipt preview');
    expect(text).toContain('Printing & hardware');
    expect(text).toContain('Weighing scale barcodes');
    expect(text).toContain('Expiry alert (days)');
    expect(text).toContain('Supervisor approvals');
    expect(text).toContain('Approval valid for (minutes)');
    expect(text).toContain('Edition & licence');
    // The live preview renders the HTML main returned, in a sandboxed frame.
    const frame = el.querySelector('iframe.doc-preview') as HTMLIFrameElement | null;
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute('srcdoc') ?? '').toContain('Grace Pharmacy');
  });

  it('warns when there has been no backup and offers a folder', async () => {
    const el = await mount(<BackupPage />);
    const text = el.textContent ?? '';
    expect(text).toContain('no backup on this computer yet');
    expect(text).toContain('Back up to a folder');
    expect(text).toContain('Where is my data?');
  });

  it('asks the operator to type the file name before restoring', async () => {
    const el = await mount(<BackupPage />);
    const input = el.querySelector('input[placeholder^="D:"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'D:\\infoflex-backup_2026-03-05_manual.db');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const restoreButton = Array.from(el.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Restore this file')
    );
    expect(restoreButton).toBeTruthy();
    expect(restoreButton?.disabled).toBe(false);
    await act(async () => {
      restoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const dialog = el.querySelector('[role="dialog"]');
    expect(dialog?.textContent ?? '').toContain('infoflex-backup_2026-03-05_manual.db');
    const confirmButton = Array.from(el.querySelectorAll('button')).find(
      (button) => (button.textContent ?? '').trim() === 'Restore backup'
    );
    // Nothing can be restored until the file name is typed.
    expect(confirmButton?.disabled).toBe(true);
  });
});
