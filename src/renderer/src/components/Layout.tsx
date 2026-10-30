import React from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { ROLE_LABELS } from '../../../shared/permissions';
import type { AppState } from '../../../shared/types';
import { Icon, type IconName } from './icons';
import { Button } from './ui';

export type ViewKey =
  | 'dashboard'
  | 'pos'
  | 'wholesale'
  | 'sales'
  | 'returns'
  | 'customers'
  | 'products'
  | 'inventory'
  | 'stock'
  | 'batches'
  | 'departments'
  | 'promotions'
  | 'loyalty'
  | 'shifts'
  | 'reports'
  | 'users'
  | 'settings'
  | 'backup'
  | 'audit'
  | 'license';

interface NavItem {
  key: ViewKey;
  label: string;
  icon: IconName;
  group: 'Sales' | 'Catalogue' | 'Stock' | 'Administration';
  permission?: string;
  feature?: 'pharmacy' | 'supermarket' | 'wholesale' | 'prescriptions';
}

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', group: 'Sales' },

  /* ---------------- selling ---------------- */
  { key: 'pos', label: 'Point of Sale', icon: 'pos', group: 'Sales', permission: 'pos.sell' },
  {
    key: 'wholesale',
    label: 'Wholesale',
    icon: 'wholesale',
    group: 'Sales',
    permission: 'wholesale.sell',
    feature: 'wholesale'
  },
  { key: 'sales', label: 'Sales & Receipts', icon: 'sales', group: 'Sales', permission: 'sales.view.own' },
  { key: 'returns', label: 'Returns', icon: 'returns', group: 'Sales', permission: 'returns.create' },
  { key: 'customers', label: 'Customers', icon: 'customers', group: 'Sales', permission: 'pos.sell' },

  /* ---------------- catalogue ---------------- */
  { key: 'products', label: 'Products', icon: 'products', group: 'Catalogue', permission: 'products.view' },
  {
    key: 'departments',
    label: 'Departments',
    icon: 'departments',
    group: 'Catalogue',
    permission: 'products.view',
    feature: 'supermarket'
  },
  {
    key: 'promotions',
    label: 'Promotions',
    icon: 'promotions',
    group: 'Catalogue',
    permission: 'products.view',
    feature: 'supermarket'
  },

  /* ---------------- stock ---------------- */
  { key: 'stock', label: 'Stock & Purchases', icon: 'stock', group: 'Stock', permission: 'products.view' },
  { key: 'inventory', label: 'Inventory', icon: 'inventory', group: 'Stock', permission: 'products.view' },
  {
    key: 'batches',
    label: 'Batches & Expiry',
    icon: 'batches',
    group: 'Stock',
    permission: 'products.view',
    feature: 'pharmacy'
  },

  /* ---------------- administration ---------------- */
  {
    key: 'loyalty',
    label: 'Loyalty',
    icon: 'loyalty',
    group: 'Administration',
    permission: 'pos.sell',
    feature: 'supermarket'
  },
  {
    key: 'shifts',
    label: 'Shifts & Drawer',
    icon: 'shifts',
    group: 'Administration',
    permission: 'pos.sell',
    feature: 'supermarket'
  },
  { key: 'reports', label: 'Reports', icon: 'reports', group: 'Administration', permission: 'reports.view.own' },
  { key: 'users', label: 'Users', icon: 'users', group: 'Administration', permission: 'users.manage' },
  { key: 'settings', label: 'Settings', icon: 'settings', group: 'Administration', permission: 'settings.manage' },
  { key: 'backup', label: 'Backup & Restore', icon: 'backup', group: 'Administration', permission: 'backup.manage' },
  { key: 'audit', label: 'Audit Trail', icon: 'audit', group: 'Administration', permission: 'audit.view' },
  { key: 'license', label: 'Licence', icon: 'license', group: 'Administration', permission: 'license.manage' }
];

export function availableNav(permissions: string[], features: Record<string, boolean>): NavItem[] {
  return NAV.filter((item) => {
    if (item.permission && !permissions.includes(item.permission)) return false;
    if (item.feature && !features[item.feature]) return false;
    return true;
  });
}

export function Layout({
  view,
  onNavigate,
  children
}: {
  view: ViewKey;
  onNavigate: (view: ViewKey) => void;
  children: React.ReactNode;
}) {
  const { state, session, signOut } = useApp();
  if (!state || !session) return null;
  const items = availableNav(session.permissions, state.features as unknown as Record<string, boolean>);
  const groups: NavItem['group'][] = ['Sales', 'Catalogue', 'Stock', 'Administration'];
  const productName = state.productName;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={logoUrl} alt="" />
          <div>
            <div className="brand-name">{productName}</div>
            <div className="brand-tag">Strategy | Consulting | Innovation</div>
          </div>
        </div>
        <nav className="nav">
          {groups.map((group) => {
            const groupItems = items.filter((item) => item.group === group);
            if (groupItems.length === 0) return null;
            return (
              <React.Fragment key={group}>
                <div className="nav-group-label">{group}</div>
                {groupItems.map((item) => (
                  <button
                    key={item.key}
                    className={`nav-item ${view === item.key ? 'active' : ''}`}
                    onClick={() => onNavigate(item.key)}
                  >
                    <Icon name={item.icon} />
                    <span>{item.label}</span>
                  </button>
                ))}
              </React.Fragment>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          {state.license.edition ? `${state.license.edition} edition` : 'Not activated'}
          <br />
          v{state.version}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="store" data-testid="header-store-name">
              {session.storeName || 'Store not configured'}
            </div>
            <div className="edition">
              {productName}
              {state.license.edition ? ` · ${state.license.edition === 'BOTH' ? 'Pharmacy & Supermarket' : state.license.edition[0] + state.license.edition.slice(1).toLowerCase()}` : ''}
            </div>
          </div>
          <div className="spacer" />
          <div className="user-chip">
            <div style={{ lineHeight: 1.25 }}>
              <div style={{ fontSize: 13, fontWeight: 650 }}>{session.fullName}</div>
              <div className="tiny muted">{ROLE_LABELS[session.role]}</div>
            </div>
            <div className="avatar" aria-hidden="true">
              {session.fullName.slice(0, 2).toUpperCase()}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void signOut()}>
            <Icon name="logout" size={15} /> Sign out
          </Button>
        </header>
        <LicenseBanners />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function minutesLeft(license: NonNullable<AppState['license']>, now: number): number {
  if (!license.expiresAt) return 0;
  return Math.max(0, Math.ceil((Date.parse(license.expiresAt) - now) / 60_000));
}

/**
 * Licence banners. Admins get the 30 / 14 / 7 / 1 day renewal reminder; every
 * user gets the ten-minute "finish or save your sale" warning. The hard lock is
 * enforced in the main process, so this is a courtesy, not the safety net.
 */
function LicenseBanners() {
  const { state, session } = useApp();
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const license = state?.license;
  if (!license || !license.usable) return null;

  const minutes = license.expiresAt ? minutesLeft(license, now) : 0;
  const endingSoon = Boolean(license.expiresAt) && minutes <= 10;
  const warning = license.warning;

  if (!endingSoon && !warning) return null;

  return (
    <div className="license-banners">
      {endingSoon ? (
        <div className="license-banner danger" role="alert" data-testid="license-ending-soon">
          <strong>Licence ends in {minutes} minute{minutes === 1 ? '' : 's'}.</strong> Finish or save the
          sale you are on — the app locks at 00:00 and needs the vendor password to reopen.
        </div>
      ) : null}
      {warning ? (
        <div className={`license-banner ${warning.level <= 7 ? 'warn' : 'info'}`} role="status" data-testid="license-warning">
          <strong>Licence ends in {license.daysRemaining} day{license.daysRemaining === 1 ? '' : 's'}.</strong>{' '}
          {session?.role === 'ADMIN'
            ? 'Renew it from Licence before the lock appears.'
            : 'Tell the administrator so they can renew it.'}
        </div>
      ) : null}
    </div>
  );
}

export { logoUrl };
