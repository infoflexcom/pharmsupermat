import { useState } from 'react';
import { call } from '../api';
import { useApp } from '../state';
import type { LicenseStatus } from '../../../shared/types';
import { Alert, Badge, Button, Card, Field, Input, PageHead, Select } from '../components/ui';

function defaultExpiry(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

export default function LicensePage() {
  const { state, refresh, notify } = useApp();
  const license = state?.license;
  const [mode, setMode] = useState<'CODE' | 'VENDOR'>('CODE');
  const [masterPassword, setMasterPassword] = useState('');
  const [code, setCode] = useState('');
  const [edition, setEdition] = useState(license?.edition ?? 'PHARMACY');
  const [customerName, setCustomerName] = useState(license?.customerName ?? '');
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function renew() {
    setError(null);
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { masterPassword };
      if (mode === 'CODE') payload.activationCode = code.trim();
      else {
        payload.edition = edition;
        payload.customerName = customerName;
        payload.expiresAt = new Date(`${expiresAt}T23:59:59`).toISOString();
      }
      const status = await call<LicenseStatus>('license.activate', payload);
      await refresh();
      notify(`Licence updated — valid until ${status.expiresAt?.slice(0, 10)}.`, 'success');
      setMasterPassword('');
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the licence.');
    } finally {
      setBusy(false);
    }
  }

  async function issue() {
    setError(null);
    setBusy(true);
    try {
      const result = await call<{ code: string }>('license.issueCode', {
        masterPassword,
        edition,
        customerName,
        expiresAt: new Date(`${expiresAt}T23:59:59`).toISOString()
      });
      setIssued(result.code);
      notify('Licence code generated.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate a code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Licence"
        subtitle="Edition and module access come from a signed licence. Renewal needs the vendor master password."
      />

      <div className="kpi-grid">
        <Card title="Current licence">
          <div className="stack" style={{ gap: 8 }}>
            <div className="row between">
              <span className="muted small">Status</span>
              {license?.state === 'VALID' || license?.state === 'EXPIRING' ? (
                <Badge tone={license.state === 'EXPIRING' ? 'warn' : 'ok'}>
                  {license.state === 'EXPIRING' ? `Expires in ${license.daysRemaining}d` : 'Active'}
                </Badge>
              ) : (
                <Badge tone="danger">{license?.state ?? 'NONE'}</Badge>
              )}
            </div>
            <div className="row between">
              <span className="muted small">Product</span>
              <strong>{state?.productName}</strong>
            </div>
            <div className="row between">
              <span className="muted small">Edition</span>
              <strong>{license?.edition ?? '—'}</strong>
            </div>
            <div className="row between">
              <span className="muted small">Licensed to</span>
              <strong>{license?.customerName ?? '—'}</strong>
            </div>
            <div className="row between">
              <span className="muted small">Issued</span>
              <span>{license?.issuedAt ? new Date(license.issuedAt).toLocaleDateString() : '—'}</span>
            </div>
            <div className="row between">
              <span className="muted small">Expires</span>
              <span>{license?.expiresAt ? new Date(license.expiresAt).toLocaleDateString() : '—'}</span>
            </div>
          </div>
        </Card>

        <Card title="Enabled modules">
          <div className="stack" style={{ gap: 8 }}>
            {[
              ['Pharmacy (batches, expiry, prescriptions)', state?.features.pharmacy],
              ['Supermarket (supervisor approvals)', state?.features.supermarket],
              ['Wholesale invoicing', state?.features.wholesale],
              ['Prescription references', state?.features.prescriptions]
            ].map(([label, enabled]) => (
              <div className="row between" key={String(label)}>
                <span className="small">{label}</span>
                <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? 'On' : 'Off'}</Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Renew or change licence">
        <div className="row tight" style={{ marginBottom: 14 }}>
          <div className="pill-toggle">
            <button className={mode === 'CODE' ? 'active' : ''} onClick={() => setMode('CODE')}>
              Activation code
            </button>
            <button className={mode === 'VENDOR' ? 'active' : ''} onClick={() => setMode('VENDOR')}>
              Vendor issue
            </button>
          </div>
        </div>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="form-grid" style={{ marginTop: 12 }}>
          <Field label="Vendor master password">
            <Input
              type="password"
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="••••••••••••"
            />
          </Field>
          {mode === 'CODE' ? (
            <Field label="Activation code" hint="Signed code provided by Infoflex.">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="IFX1…" />
            </Field>
          ) : (
            <>
              <Field label="Edition">
                <Select value={edition} onChange={(e) => setEdition(e.target.value as typeof edition)}>
                  <option value="PHARMACY">Pharmacy — Infoflex Pharm</option>
                  <option value="SUPERMARKET">Supermarket — Infoflex Mart</option>
                  <option value="BOTH">Both editions</option>
                </Select>
              </Field>
              <Field label="Customer name on licence">
                <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              </Field>
              <Field label="New expiry">
                <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        <div className="row tight" style={{ marginTop: 14 }}>
          <Button onClick={renew} disabled={busy || !masterPassword}>
            {busy ? 'Working…' : 'Apply licence'}
          </Button>
          {mode === 'VENDOR' ? (
            <Button variant="ghost" onClick={issue} disabled={busy || !masterPassword}>
              Generate code for a customer
            </Button>
          ) : null}
        </div>

        {issued ? (
          <div style={{ marginTop: 14 }}>
            <Alert tone="success">
              <div style={{ minWidth: 0 }}>
                <strong>Licence code</strong> — send this to the customer.
                <textarea
                  readOnly
                  value={issued}
                  rows={3}
                  onFocus={(e) => e.currentTarget.select()}
                  style={{ marginTop: 8, fontFamily: 'monospace', fontSize: 11 }}
                />
              </div>
            </Alert>
          </div>
        ) : null}
      </Card>

      <Card title="How licensing works">
        <div className="small muted stack" style={{ gap: 6 }}>
          <div>
            The master password is never stored — only a salted scrypt hash. The vendor signing key is sealed
            with AES-256-GCM under a key derived from that password.
          </div>
          <div>
            Licences are Ed25519-signed payloads. The app verifies the signature on every start and on every
            licence change, so editing the database cannot enable a module you were not sold.
          </div>
          <div>No licence check ever touches the internet.</div>
        </div>
      </Card>
    </div>
  );
}
