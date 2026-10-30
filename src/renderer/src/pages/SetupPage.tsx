import React, { useMemo, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { call } from '../api';
import { Alert, Button, Field, Input, Select } from '../components/ui';
import { formatMoney } from '../../../shared/money';
import type { Edition } from '../../../shared/types';

/**
 * First-run setup: shown once, only after the licence is activated and only
 * while no user account exists. The administrator account and the store details
 * are sent together and saved in a single database transaction in the main
 * process — either both are stored or neither is.
 */

const MAX_LOGO_BYTES = 200 * 1024;

function storeNameLabel(edition: Edition | null | undefined): string {
  if (edition === 'PHARMACY') return 'Pharmacy name';
  if (edition === 'SUPERMARKET') return 'Supermarket name';
  if (edition === 'BOTH') return 'Business name';
  return 'Store name';
}

function storeNamePlaceholder(edition: Edition | null | undefined): string {
  if (edition === 'PHARMACY') return 'e.g. Grace Pharmacy, Ikeja';
  if (edition === 'SUPERMARKET') return 'e.g. Grace Supermarket, Lekki';
  if (edition === 'BOTH') return 'e.g. Grace Pharmacy & Mart';
  return 'Your store name';
}

function licenceLabel(edition: Edition | null | undefined): string {
  if (edition === 'PHARMACY') return 'PCN / NAFDAC licence number (optional)';
  if (edition === 'SUPERMARKET') return 'Business registration number (optional)';
  return 'Regulatory / business licence number (optional)';
}

const SAMPLE_LINES = [
  { name: 'Paracetamol 500mg', qty: 2, price: 150_000 },
  { name: 'Vitamin C 1000mg', qty: 1, price: 320_000 }
];

export default function SetupPage() {
  const { state, refresh, notify } = useApp();
  const edition = state?.license.edition ?? null;

  /* Section 1 — administrator account */
  const [adminFullName, setAdminFullName] = useState('');
  const [adminUsername, setAdminUsername] = useState('admin');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  /* Section 2 — the customer's store */
  const [storeName, setStoreName] = useState('');
  const [storeAddress, setStoreAddress] = useState('');
  const [storePhone, setStorePhone] = useState('');
  const [storeEmail, setStoreEmail] = useState('');
  const [storeLicenceNo, setStoreLicenceNo] = useState('');
  const [storeVatNo, setStoreVatNo] = useState('');
  const [storeLogo, setStoreLogo] = useState('');
  const [receiptFooter, setReceiptFooter] = useState('Thank you for your patronage.');
  const [thankYouNote, setThankYouNote] = useState('Thank you for your patronage.');
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(15);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameLabel = state?.setup.storeNameLabel ?? storeNameLabel(edition);

  const strength = useMemo(() => {
    let score = 0;
    if (adminPassword.length >= 8) score += 1;
    if (adminPassword.length >= 12) score += 1;
    if (/[A-Z]/.test(adminPassword) && /[a-z]/.test(adminPassword)) score += 1;
    if (/[0-9]/.test(adminPassword) && /[^A-Za-z0-9]/.test(adminPassword)) score += 1;
    const labels = ['Too weak', 'Weak', 'Fair', 'Strong', 'Very strong'];
    return { score, label: labels[score] };
  }, [adminPassword]);

  const passwordProblem =
    adminPassword && adminPassword.length < 8
      ? 'Use at least 8 characters.'
      : adminPassword && (!/[A-Za-z]/.test(adminPassword) || !/[0-9]/.test(adminPassword))
        ? 'Include at least one letter and one number.'
        : null;

  const canSubmit =
    !busy &&
    Boolean(storeName.trim()) &&
    Boolean(adminFullName.trim()) &&
    Boolean(adminUsername.trim()) &&
    adminPassword.length >= 8 &&
    adminPassword === confirm &&
    !passwordProblem;

  function pickLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_LOGO_BYTES) {
      setError('The store logo must be smaller than 200 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setStoreLogo(typeof reader.result === 'string' ? reader.result : '');
      setError(null);
    };
    reader.onerror = () => setError('That image could not be read. Try another file.');
    reader.readAsDataURL(file);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!storeName.trim()) return setError(`Your ${nameLabel.toLowerCase()} is required — it prints on every document.`);
    if (!adminFullName.trim()) return setError('The administrator full name is required.');
    if (adminPassword !== confirm) return setError('The two administrator passwords do not match.');
    setBusy(true);
    try {
      await call('setup.complete', {
        storeName: storeName.trim(),
        storeAddress: storeAddress.trim(),
        storePhone: storePhone.trim(),
        storeEmail: storeEmail.trim(),
        storeLicenceNo: storeLicenceNo.trim(),
        storeVatNo: storeVatNo.trim(),
        storeLogo: storeLogo || null,
        receiptFooter: receiptFooter.trim(),
        thankYouNote: thankYouNote.trim(),
        idleTimeoutMinutes,
        adminFullName: adminFullName.trim(),
        adminUsername: adminUsername.trim(),
        adminEmail: adminEmail.trim(),
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

  const previewTotal = SAMPLE_LINES.reduce((sum, line) => sum + line.qty * line.price, 0);

  return (
    <div className="auth-screen setup-screen">
      <div className="login-bg" aria-hidden="true" />
      <div className="setup-shell">
        <header className="setup-head">
          <img src={logoUrl} alt="" className="setup-logo" />
          <div>
            <h1>Welcome to {state?.productName ?? 'Infoflex'}</h1>
            <p>
              {edition ? `${edition === 'BOTH' ? 'Pharmacy & Supermarket' : edition[0] + edition.slice(1).toLowerCase()} edition` : 'First-run setup'} ·
              this screen appears once, after activation
            </p>
          </div>
        </header>

        <form className="setup-grid" onSubmit={submit}>
          {/* -------------------- Section 1 -------------------- */}
          <section className="card setup-section" aria-labelledby="setup-admin">
            <div className="setup-section-head">
              <span className="step-chip">1</span>
              <div>
                <h2 id="setup-admin">Administrator account</h2>
                <p>The only account that can add users, set passwords, add goods and set prices.</p>
              </div>
            </div>

            <div className="form-grid">
              <Field label="Full name">
                <Input
                  value={adminFullName}
                  onChange={(e) => setAdminFullName(e.target.value)}
                  placeholder="e.g. Ada Obi"
                  autoFocus
                  required
                />
              </Field>
              <Field label="Username">
                <Input
                  value={adminUsername}
                  onChange={(e) => setAdminUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </Field>
              <Field label="Email (optional)" hint="Used only for your own records; the app never sends mail.">
                <Input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </Field>
              <Field label="Password" hint="At least 8 characters, with a letter and a number.">
                <div className="password-wrap">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    onClick={() => setShowPassword((value) => !value)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {adminPassword ? (
                  <div className="strength" data-score={strength.score}>
                    <div className="strength-bars">
                      {[0, 1, 2, 3].map((index) => (
                        <span key={index} className={index < strength.score ? 'on' : ''} />
                      ))}
                    </div>
                    <span className="tiny muted">
                      {strength.label}
                      {passwordProblem ? ` · ${passwordProblem}` : ''}
                    </span>
                  </div>
                ) : null}
              </Field>
              <Field label="Confirm password">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  minLength={8}
                />
                {confirm && confirm !== adminPassword ? (
                  <span className="tiny field-error">Passwords do not match.</span>
                ) : null}
              </Field>
            </div>
          </section>

          {/* -------------------- Section 2 -------------------- */}
          <section className="card setup-section" aria-labelledby="setup-store">
            <div className="setup-section-head">
              <span className="step-chip">2</span>
              <div>
                <h2 id="setup-store">Your {nameLabel.toLowerCase()}</h2>
                <p>Printed at the top of every receipt, invoice, credit note and report.</p>
              </div>
            </div>

            <div className="form-grid">
              <Field label={`${nameLabel} (required)`}>
                <Input
                  value={storeName}
                  onChange={(e) => setStoreName(e.target.value)}
                  placeholder={storeNamePlaceholder(edition)}
                  required
                  aria-required="true"
                  data-testid="setup-store-name"
                />
              </Field>
              <Field label="Phone number(s)">
                <Input
                  value={storePhone}
                  onChange={(e) => setStorePhone(e.target.value)}
                  placeholder="e.g. 0803 000 0000, 0812 000 0000"
                />
              </Field>
              <Field label="Address">
                <Input
                  value={storeAddress}
                  onChange={(e) => setStoreAddress(e.target.value)}
                  placeholder="e.g. 12 Allen Avenue, Ikeja, Lagos"
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  type="email"
                  value={storeEmail}
                  onChange={(e) => setStoreEmail(e.target.value)}
                  placeholder="shop@example.com"
                />
              </Field>
              <Field label={licenceLabel(edition)}>
                <Input
                  value={storeLicenceNo}
                  onChange={(e) => setStoreLicenceNo(e.target.value)}
                  placeholder={edition === 'PHARMACY' ? 'e.g. PCN/LAG/2026/00123' : 'e.g. RC 1234567'}
                />
              </Field>
              <Field label="Tax / VAT number (optional)">
                <Input
                  value={storeVatNo}
                  onChange={(e) => setStoreVatNo(e.target.value)}
                  placeholder="e.g. VAT 01234567-0001"
                />
              </Field>
              <Field label="Your store logo (optional)" hint="PNG, JPEG, WebP or SVG up to 200 KB. It prints above your store name.">
                <div className="row tight">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={pickLogo} />
                  {storeLogo ? (
                    <Button type="button" size="sm" variant="ghost" onClick={() => setStoreLogo('')}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </Field>
              <Field label="Receipt footer">
                <Input value={receiptFooter} onChange={(e) => setReceiptFooter(e.target.value)} />
              </Field>
              <Field label="Thank-you note">
                <Input value={thankYouNote} onChange={(e) => setThankYouNote(e.target.value)} />
              </Field>
              <Field label="Auto sign-out after inactivity" hint="Minutes without activity before the session ends.">
                <Select
                  value={idleTimeoutMinutes}
                  onChange={(e) => setIdleTimeoutMinutes(Number(e.target.value))}
                >
                  {[5, 10, 15, 20, 30, 45, 60, 120].map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes} minutes
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </section>

          {/* -------------------- live receipt preview -------------------- */}
          <aside className="card receipt-preview" aria-label="Receipt preview">
            <div className="receipt-paper">
              {storeLogo ? <img src={storeLogo} alt="" className="receipt-logo" /> : null}
              <div className="receipt-store">{storeName.trim() || 'Your store name'}</div>
              {storeAddress.trim() ? <div className="receipt-line">{storeAddress}</div> : null}
              {storePhone.trim() ? <div className="receipt-line">{storePhone}</div> : null}
              {storeLicenceNo.trim() ? <div className="receipt-line">Licence: {storeLicenceNo}</div> : null}
              {storeVatNo.trim() ? <div className="receipt-line">VAT: {storeVatNo}</div> : null}
              <div className="receipt-rule" />
              <div className="receipt-line muted">RECEIPT · RCP-000001 · {new Date().toLocaleDateString()}</div>
              {SAMPLE_LINES.map((line) => (
                <div className="receipt-row" key={line.name}>
                  <span>
                    {line.qty} × {line.name}
                  </span>
                  <span>{formatMoney(line.qty * line.price)}</span>
                </div>
              ))}
              <div className="receipt-rule" />
              <div className="receipt-row total">
                <span>TOTAL</span>
                <span>{formatMoney(previewTotal)}</span>
              </div>
              <div className="receipt-thanks">{thankYouNote.trim()}</div>
              <div className="receipt-footer">{receiptFooter.trim()}</div>
            </div>
            <p className="tiny muted">Live preview — the store name you type here is what prints.</p>
          </aside>

          {error ? <Alert tone="error">{error}</Alert> : null}

          <div className="setup-actions">
            <div className="tiny muted">
              Both sections are saved together. Setup cannot finish without the administrator details
              and your {nameLabel.toLowerCase()}.
            </div>
            <Button type="submit" disabled={!canSubmit}>
              {busy ? 'Saving…' : 'Finish setup and go to login'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
