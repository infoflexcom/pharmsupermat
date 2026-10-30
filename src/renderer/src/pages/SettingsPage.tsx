import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { SettingsPayload } from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import { Alert, Button, Card, Field, Input, PageHead, Select } from '../components/ui';

const MAX_LOGO_BYTES = 200 * 1024;

export default function SettingsPage() {
  const api = useApi();
  const { state, notify, refresh } = useApp();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [returnLimit, setReturnLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !settings) return;
    if (file.size > MAX_LOGO_BYTES) {
      setError('The store logo must be smaller than 200 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setSettings({ ...settings, storeLogo: reader.result });
      setError(null);
    };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    void (async () => {
      const data = await api<SettingsPayload>('settings.read');
      if (data) {
        setSettings(data);
        setReturnLimit(moneyToInput(data.returnLimit));
      }
    })();
  }, [api]);

  async function save() {
    if (!settings) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await call<SettingsPayload>('settings.update', {
        ...settings,
        returnLimit: parseMoneyInput(returnLimit)
      });
      setSettings(updated);
      await refresh();
      notify('Settings saved. New documents will use these details.', 'success');
      setReturnLimit(moneyToInput(updated.returnLimit));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save settings.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="stack">
        <PageHead title="Settings" />
        <Card>
          <div className="empty">Loading settings…</div>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Settings"
        subtitle="Your store identity, receipt wording and the rules for approvals. Existing documents keep the details captured when they were created."
      />

      <Alert tone="info">
        Store name is printed on every receipt, invoice, credit note and report. Changing it here does not
        alter documents already issued. Only the administrator can edit these details.
      </Alert>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card title="Store identity">
        <div className="form-grid">
          <Field label="Store name (required)">
            <Input
              value={settings.storeName}
              onChange={(e) => setSettings({ ...settings, storeName: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={settings.storePhone}
              onChange={(e) => setSettings({ ...settings, storePhone: e.target.value })}
            />
          </Field>
          <Field label="Address">
            <Input
              value={settings.storeAddress}
              onChange={(e) => setSettings({ ...settings, storeAddress: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={settings.storeEmail}
              onChange={(e) => setSettings({ ...settings, storeEmail: e.target.value })}
            />
          </Field>
          <Field
            label={
              state?.license.edition === 'PHARMACY'
                ? 'PCN / NAFDAC licence number'
                : state?.license.edition === 'SUPERMARKET'
                  ? 'Business registration number'
                  : 'Regulatory / business licence number'
            }
          >
            <Input
              value={settings.storeLicenceNo}
              onChange={(e) => setSettings({ ...settings, storeLicenceNo: e.target.value })}
            />
          </Field>
          <Field label="Tax / VAT number">
            <Input
              value={settings.storeVatNo}
              onChange={(e) => setSettings({ ...settings, storeVatNo: e.target.value })}
            />
          </Field>
          <Field label="Store logo" hint="PNG, JPEG, WebP or SVG up to 200 KB. Printed above the store name.">
            <div className="row tight">
              {settings.storeLogo ? <img src={settings.storeLogo} alt="" style={{ height: 32 }} /> : null}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={pickLogo} />
              {settings.storeLogo ? (
                <Button size="sm" variant="ghost" type="button" onClick={() => setSettings({ ...settings, storeLogo: '' })}>
                  Remove
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Receipt footer">
            <Input
              value={settings.receiptFooter}
              onChange={(e) => setSettings({ ...settings, receiptFooter: e.target.value })}
            />
          </Field>
          <Field label="Thank-you note">
            <Input
              value={settings.thankYouNote}
              onChange={(e) => setSettings({ ...settings, thankYouNote: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      <Card title="Operational rules">
        <div className="form-grid">
          <Field
            label="Cashier return limit (₦)"
            hint="Returns above this amount need supervisor approval."
          >
            <Input value={returnLimit} onChange={(e) => setReturnLimit(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Return window (days)" hint="Returns after this many days need approval.">
            <Input
              type="number"
              min={0}
              value={settings.returnWindowDays}
              onChange={(e) => setSettings({ ...settings, returnWindowDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Low stock alerts" hint="Warn when stock reaches the reorder level.">
            <Select
              value={settings.lowStockAlerts ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, lowStockAlerts: e.target.value === 'yes' })}
            >
              <option value="yes">On</option>
              <option value="no">Off</option>
            </Select>
          </Field>
          <Field label="Auto sign-out after inactivity" hint="Cashiers are signed out after this many idle minutes.">
            <Select
              value={settings.idleTimeoutMinutes}
              onChange={(e) => setSettings({ ...settings, idleTimeoutMinutes: Number(e.target.value) })}
            >
              {[5, 10, 15, 20, 30, 45, 60, 120].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Licence expiry warning (days)">
            <Input
              type="number"
              min={1}
              value={settings.licenseExpiryWarningDays}
              onChange={(e) => setSettings({ ...settings, licenseExpiryWarningDays: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="row tight" style={{ marginTop: 16 }}>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
          <span className="small muted">
            Cashier return limit is currently {formatMoney(parseMoneyInput(returnLimit))}
          </span>
        </div>
      </Card>

      <Card title="Edition & licence">
        <div className="form-grid">
          <div>
            <div className="tiny muted">Product</div>
            <div style={{ fontWeight: 650 }}>{state?.productName}</div>
          </div>
          <div>
            <div className="tiny muted">Edition</div>
            <div style={{ fontWeight: 650 }}>{state?.license.edition ?? '—'}</div>
          </div>
          <div>
            <div className="tiny muted">Licensed to</div>
            <div style={{ fontWeight: 650 }}>{state?.license.customerName ?? '—'}</div>
          </div>
          <div>
            <div className="tiny muted">Expires</div>
            <div style={{ fontWeight: 650 }}>
              {state?.license.expiresAt ? new Date(state.license.expiresAt).toLocaleDateString() : '—'}
            </div>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>
          Modules enabled: {state?.features.pharmacy ? 'pharmacy ' : ''}
          {state?.features.supermarket ? 'supermarket ' : ''}
          {state?.features.wholesale ? 'wholesale ' : ''}
          {state?.features.prescriptions ? 'prescriptions' : ''}
        </div>
      </Card>
    </div>
  );
}
