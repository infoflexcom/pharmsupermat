import React, { useEffect, useMemo, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { ApiClientError, call } from '../api';
import { Alert, Button, Field, Input } from '../components/ui';
import { LicenseSetupForm, type LicenseSetupValue } from '../components/LicenseSetupForm';
import { addYears, localDate } from '../../../shared/license-dates';
import type { LicenseStatus, MasterPasswordResult } from '../../../shared/types';

type Step = 'PASSWORD' | 'SETUP';

function retrySeconds(error: unknown): number {
  if (error instanceof ApiClientError) {
    const details = error.details as { retryAfterSeconds?: number } | undefined;
    if (typeof details?.retryAfterSeconds === 'number') return details.retryAfterSeconds;
  }
  return 0;
}

/**
 * First launch after installation. Two steps, both gated by the vendor master
 * password: verify it (rate limited, audited) and then choose the edition and
 * licence period. Nothing else in the app is reachable until this completes.
 */
export default function ActivationPage() {
  const { state, refresh, notify } = useApp();
  const [step, setStep] = useState<Step>('PASSWORD');
  const [masterPassword, setMasterPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);

  const today = useMemo(() => localDate(), []);
  const [setup, setSetup] = useState<LicenseSetupValue>({
    edition: 'PHARMACY',
    startsOn: today,
    endsOn: addYears(today, 1)
  });

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await call<MasterPasswordResult>('license.verifyMaster', { masterPassword });
      setStep('SETUP');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That password was not accepted.');
      setWait(retrySeconds(err));
    } finally {
      setBusy(false);
    }
  }

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const status = await call<LicenseStatus>('license.activate', {
        masterPassword,
        edition: setup.edition,
        startsOn: setup.startsOn,
        endsOn: setup.endsOn
      });
      notify(`${status.productName} activated — licensed until ${status.endsOn}.`, 'success');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed.');
      setWait(retrySeconds(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="login-bg" aria-hidden="true" />
      <div className="auth-card wide-card" style={{ maxWidth: 720 }}>
        <img className="auth-logo" src={logoUrl} alt="Infoflex" />
        <div className="auth-title">Activation Required</div>
        <div className="auth-tag">Strategy | Consulting | Innovation</div>

        <div className="wizard-steps" style={{ marginTop: 16 }}>
          <div className={`wizard-step ${step === 'PASSWORD' ? 'active' : ''}`} />
          <div className={`wizard-step ${step === 'SETUP' ? 'active' : ''}`} />
          <div className="wizard-step" />
        </div>

        {step === 'PASSWORD' ? (
          <>
            <Alert tone="info">
              Enter the vendor master password to activate this installation. It is checked against a
              salted hash and never stored on this computer.
            </Alert>
            <form className="stack" onSubmit={verify}>
              <Field
                label="Vendor master password"
                hint="Required for activation and renewal. Five wrong attempts start a 30 second delay, then 1 minute, 5 minutes…"
              >
                <div className="password-wrap">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={masterPassword}
                    autoFocus
                    autoComplete="off"
                    onChange={(event) => setMasterPassword(event.target.value)}
                    placeholder="••••••••••••"
                    required
                    data-testid="activation-password"
                  />
                  <button
                    type="button"
                    className="password-toggle"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </Field>
              {error ? <Alert tone="error">{error}</Alert> : null}
              {wait > 0 ? (
                <div className="tiny muted" role="status">
                  Too many wrong passwords. Next attempt in {wait}s.
                </div>
              ) : null}
              <Button type="submit" block disabled={busy || wait > 0} data-testid="activation-continue">
                {busy ? 'Checking…' : wait > 0 ? `Wait ${wait}s` : 'Activate'}
              </Button>
            </form>
          </>
        ) : (
          <form className="stack" onSubmit={activate}>
            <Alert tone="success">Password accepted. Choose the edition and licence period.</Alert>
            <LicenseSetupForm value={setup} onChange={setSetup} disabled={busy} today={today} />
            {error ? <Alert tone="error">{error}</Alert> : null}
            <div className="row tight">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep('PASSWORD')}
                disabled={busy}
              >
                Back
              </Button>
              <Button type="submit" className="grow" disabled={busy} data-testid="activation-save">
                {busy ? 'Saving…' : 'Save licence and continue'}
              </Button>
            </div>
          </form>
        )}

        <div className="auth-foot">
          Works offline · all data stays on this computer
          <br />
          Version {state?.version ?? '—'} · Infoflex
        </div>
      </div>
    </div>
  );
}
