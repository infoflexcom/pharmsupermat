import { useEffect, useState } from 'react';
import { useApp } from './state';
import { Layout, type ViewKey } from './components/Layout';
import ActivationPage from './pages/ActivationPage';
import SetupPage from './pages/SetupPage';
import LoginPage from './pages/LoginPage';
import ChangePasswordPage from './pages/ChangePasswordPage';
import DashboardPage from './pages/DashboardPage';
import PosPage from './pages/PosPage';
import SalesPage from './pages/SalesPage';
import ReturnsPage from './pages/ReturnsPage';
import ProductsPage from './pages/ProductsPage';
import InventoryPage from './pages/InventoryPage';
import ReportsPage from './pages/ReportsPage';
import UsersPage from './pages/UsersPage';
import SettingsPage from './pages/SettingsPage';
import BackupPage from './pages/BackupPage';
import AuditPage from './pages/AuditPage';
import LicensePage from './pages/LicensePage';
import { Alert, Button } from './components/ui';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  const { state, loading, error, refresh } = useApp();
  const [view, setView] = useState<ViewKey>('dashboard');

  // Land on the POS for cashiers — it is their whole job.
  useEffect(() => {
    if (state?.session?.role === 'CASHIER') setView('pos');
  }, [state?.session?.role]);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <div>Starting Infoflex…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="loading-screen">
        <div style={{ maxWidth: 460 }} className="stack">
          <Alert tone="error">{error}</Alert>
          <Button onClick={() => void refresh()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  const licensed = state.license.state === 'VALID' || state.license.state === 'EXPIRING';
  if (!licensed) return <ActivationPage />;
  if (state.setup.setupRequired) return <SetupPage />;
  if (!state.session) return <LoginPage />;
  if (state.session.mustChangePassword) return <ChangePasswordPage />;

  return (
    <Layout view={view} onNavigate={setView}>
      <ErrorBoundary key={view}>
      {view === 'dashboard' ? <DashboardPage onNavigate={setView} /> : null}
      {view === 'pos' ? <PosPage mode="RETAIL" /> : null}
      {view === 'wholesale' ? <PosPage mode="INVOICE" /> : null}
      {view === 'sales' ? <SalesPage /> : null}
      {view === 'returns' ? <ReturnsPage /> : null}
      {view === 'products' ? <ProductsPage /> : null}
      {view === 'inventory' ? <InventoryPage /> : null}
      {view === 'reports' ? <ReportsPage /> : null}
      {view === 'users' ? <UsersPage /> : null}
      {view === 'settings' ? <SettingsPage /> : null}
      {view === 'backup' ? <BackupPage /> : null}
      {view === 'audit' ? <AuditPage /> : null}
      {view === 'license' ? <LicensePage /> : null}
      </ErrorBoundary>
    </Layout>
  );
}
