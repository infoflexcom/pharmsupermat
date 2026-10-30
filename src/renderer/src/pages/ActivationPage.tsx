import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { call } from '../api';
import { Alert, Button, Field, Input, Select } from '../components/ui';
import type { LicenseStatus } from '../../../shared/types';

type Mode = 'CODE' | 'VENDOR';

const EDITIONS = [
  { value: 'PHARMACY', label: 'Pharmacy — Infoflex Pharm' },
  { value: 'SUPERMARKET', label: 'Supermarket — Infoflex Mart' },
  { value: 'BOTH', label: 'Both editions — Infoflex Pharm & Mart' }
];

function defaultExpiry(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export default function ActivationPage() {
  const { state, refresh, notify } = useApp();
  const [mode, setMode] = useState<Mode>('CODE');
  const [masterPassword, setMasterPassword] = useState('');
  const [activationCode, setActivationCode] = useState('');
  const [edition, setEdition] = useState('PHARMACY');
  const [customerName, setCustomerName] = useState(state?.license.customerName ?? '');
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  const expired = state?.license.state === 'EXPIRED';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { masterPassword };
      if (mode === 'CODE') {
        if (!activationCode.trim()) throw new Error('Paste the activation code from your supplier.');
        payload.activationCode = activationCode.trim();
      } else {
        payload.edition = edition;
        payload.customerName = customerName;
        payload.expiresAt = new Date(`${expiresAt}T23:59:59`).toISOString();
        payload.note = note;
      }
      const status = await call<LicenseStatus>('license.activate', payload);
      await refresh();
      notify(`Licence activated: ${status.productName} (${status.edition}).`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed.');
    } finally {
      setBusy(false);
    }
  }

  async function issueCode() {
    setError(null);
    setBusy(true);
    try {
      const result = await call<{ code: string }>('license.issueCode', {
        masterPassword,
        edition,
        customerName,
        expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString(),
        note
      });
      setIssuedCode(result.code);
      notify('Licence code generated. Copy it and send it to the customer.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate the licence code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card wide-card" style={{ maxWidth: 640 }}>
        <img className="auth-logo" src={logoUrl} alt="Infoflex" />
        <div className="auth-title">{expired ? 'Licence expired' : 'Activate Infoflex'}</div>
        <div className="auth-tag">Strategy | Consulting | Innovation</div>

        {expired ? (
          <Alert tone="warn">
            {state?.license.message ?? 'Your licence has expired.'} Renew with the vendor master password
            below to keep using the app.
          </Alert>
        ) : (
          <Alert tone="info">
            Enter the vendor master password to activate this installation. Licence data is stored
            locally and signed — the app works completely offline.
          </Alert>
        )}

        <div className="wizard-steps" style={{ marginTop: 16 }}>
          <div className="wizard-step active" />
          <div className="wizard-step" />
          <div className="wizard-step" />
        </div>

        <div className="row tight" style={{ marginBottom: 14 }}>
          <div className="pill-toggle">
            <button className={mode === 'CODE' ? 'active' : ''} onClick={() => setMode('CODE')} type="button">
              Activation code
            </button>
            <button className={mode === 'VENDOR' ? 'active' : ''} onClick={() => setMode('VENDOR')} type="button">
              Vendor issue
            </button>
          </div>
        </div>

        <form className="stack" onSubmit={submit}>
          <Field label="Vendor master password" hint="Required for activation and renewal. Never stored.">
            <Input
              type="password"
              value={masterPassword}
              autoFocus
              autoComplete="off"
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="••••••••••••"
              required
            />
          </Field>

          {mode === 'CODE' ? (
            <Field label="Activation code" hint="Starts with IFX1. Provided by Infoflex.">
              <textarea
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                placeholder="IFX1.eyJ2IjoxLCJ..."
                rows={3}
                spellCheck={false}
              />
            </Field>
          ) : (
            <>
              <div className="form-grid two">
                <Field label="Edition">
                  <Select value={edition} onChange={(e) => setEdition(e.target.value)}>
                    {EDITIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Licence expiry">
                  <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
                </Field>
              </div>
              <Field label="Customer / store name on the licence">
                <Input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="e.g. Grace Pharmacy, Ikeja"
                  required
                />
              </Field>
              <Field label="Reference (optional)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Invoice or PO number" />
              </Field>
            </>
          )}

          {error ? <Alert tone="error">{error}</Alert> : null}
          {issuedCode ? (
            <Alert tone="success">
              <div style={{ minWidth: 0 }}>
                <strong>Licence code generated.</strong>
                <div className="small" style={{ marginTop: 6 }}>
                  Send this to the customer; they paste it in the “Activation code” tab.
                </div>
                <textarea
                  readOnly
                  value={issuedCode}
                  rows={3}
                  style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11 }}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
            </Alert>
          ) : null}

          <div className="row tight">
            <Button type="submit" className="grow" disabled={busy}>
              {busy ? 'Working…' : expired ? 'Renew licence' : 'Activate'}
            </Button>
            {mode === 'VENDOR' ? (
              <Button type="button" variant="ghost" onClick={issueCode} disabled={busy}>
                Generate code
              </Button>
            ) : null}
          </div>
        </form>

        <div className="auth-foot">
          Infoflex · Strategy | Consulting | Innovation
          <br />
          Version {state?.version ?? '—'} · works offline, no internet required
        </div>
      </div>
    </div>
  );
}
