import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { call } from '../api';
import { Alert, Button, Field, Input } from '../components/ui';

export default function SetupPage() {
  const { state, refresh, notify } = useApp();
  const [storeName, setStoreName] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('Thank you for your patronage.');
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminFullName, setAdminFullName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!storeName.trim()) return setError('Your store name is required — it prints on every document.');
    if (adminPassword !== confirm) return setError('The two administrator passwords do not match.');
    setBusy(true);
    try {
      await call('setup.complete', {
        storeName: storeName.trim(),
        storeAddress: storeAddress.trim(),
        storePhone: storePhone.trim(),
        receiptFooter: receiptFooter.trim(),
        adminUsername: adminUsername.trim(),
        adminFullName: adminFullName.trim(),
        adminPassword
      });
      await refresh();
      notify('Setup complete. Sign in with your administrator account.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup could not be completed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card wide-card">
        <div className="row" style={{ justifyContent: 'center', marginBottom: 8 }}>
          <img src={logoUrl} alt="" style={{ width: 54, height: 54, borderRadius: 12 }} />
        </div>
        <div className="auth-title">Welcome to {state?.productName ?? 'Infoflex'}</div>
        <div className="auth-tag">
          {state?.license.edition ? `${state.license.edition} edition · first-run setup` : 'first-run setup'}
        </div>

        <div className="wizard-steps">
          <div className="wizard-step active" />
          <div className="wizard-step active" />
          <div className="wizard-step" />
        </div>

        <Alert tone="info">
          The store name below is <strong>your</strong> business name. It is printed at the top of every
          receipt, invoice, credit note and report, and is saved onto each sale.
        </Alert>

        <form className="stack" style={{ marginTop: 16 }} onSubmit={submit}>
          <div className="form-grid">
            <Field label="Store name (required)">
              <Input
                value={storeName}
                onChange={(e) => setStoreName(e.target.value)}
                placeholder="e.g. Grace Pharmacy"
                autoFocus
                required
              />
            </Field>
            <Field label="Phone">
              <Input
                value={storePhone}
                onChange={(e) => setStorePhone(e.target.value)}
                placeholder="e.g. 0803 000 0000"
              />
            </Field>
          </div>
          <Field label="Address">
            <Input
              value={storeAddress}
              onChange={(e) => setStoreAddress(e.target.value)}
              placeholder="e.g. 12 Allen Avenue, Ikeja, Lagos"
            />
          </Field>
          <Field label="Receipt footer" hint="Printed at the bottom of every customer document.">
            <Input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} />
          </Field>

          <div className="divider" />
          <h3 style={{ fontSize: 14 }}>Administrator account</h3>
          <div className="form-grid">
            <Field label="Username">
              <Input value={adminUsername} onChange={(e) => setAdminUsername(e.target.value)} required />
            </Field>
            <Field label="Full name">
              <Input
                value={adminFullName}
                onChange={(e) => setAdminFullName(e.target.value)}
                placeholder="e.g. Ada Obi"
                required
              />
            </Field>
            <Field label="Password" hint="At least 6 characters.">
              <Input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                required
                minLength={6}
              />
            </Field>
            <Field label="Confirm password">
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={6}
              />
            </Field>
          </div>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Finish setup and continue'}
          </Button>
        </form>
      </div>
    </div>
  );
}
