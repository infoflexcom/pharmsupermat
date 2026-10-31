import React, { useEffect, useMemo, useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { ApiClientError, call } from '../api';
import { Alert, Button, Field, Input } from '../components/ui';
import { LicenseSetupForm, LicensePeriodSummary, type LicenseSetupValue } from '../components/LicenseSetupForm';
import { addYears, localDate } from '../../../shared/license-dates';
import type { LicenseState, LicenseStatus } from '../../../shared/types';

function retrySeconds(error: unknown): number {
  if (error instanceof ApiClientError) {
    const details = error.details as { retryAfterSeconds?: number } | undefined;
    if (typeof details?.retryAfterSeconds === 'number') return details.retryAfterSeconds;
  }
  return 0;
}

const TITLES: Record<string, string> = {
  EXPIRED: 'License Expired — Software Update Required',
  NOT_STARTED: 'Licence period not started',
  TAMPERED: 'Licence file needs to be re-signed',
  CLOCK_ROLLBACK: 'System clock change detected',
  INVALID: 'Licence could not be verified'
};

const EXPLAIN: Record<string, string> = {
  EXPIRED: 'The licence period for this installation has ended.',
  NOT_STARTED: 'The start date on this licence is in the future.',
  TAMPERED:
    'The stored licence no longer matches its signature. This usually means the file was edited outside the app.',
  CLOCK_ROLLBACK:
    'The computer clock is earlier than the last time the app ran. Correct the date and enter the update password.',
  INVALID: 'The licence could not be read.'
};

/**
 * The hard lock. It replaces the whole app — no sidebar, no data — and only the
 * vendor can get past it. Nothing here deletes, moves or changes business data;
 * the message says so explicitly because that is the customer's first worry.
 */
export default function LicenseLockPage() {
  const { state, refresh } = useApp();
  const license = state?.license;
  const reason = (license?.state ?? 'EXPIRED') as LicenseState;
  const today = useMemo(() => localDate(), []);

  const [step, setStep] = useState<'PASSWORD' | 'SETUP'>('PASSWORD');
  const [masterPassword, setMasterPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [setup, setSetup] = useState<LicenseSetupValue>({
    edition: license?.edition ?? 'PHARMACY',
    startsOn: today,
    endsOn: addYears(today, 1)
  });

  // Keep the editable period in step with the stored edition.
  useEffect(() => {
    if (license?.edition) setSetup((value) => ({ ...value, edition: license.edition as LicenseSetupValue['edition'] }));
  }, [license?.edition]);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setInterval(() => setWait((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [wait]);

  const clockOnly = reason === 'CLOCK_ROLLBACK';
  const lockedOut = !license;

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await call('license.verifyMaster', { masterPassword });
      setStep('SETUP');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That password was not accepted.');
      setWait(retrySeconds(err));
    } finally {
      setBusy(false);
    }
  }

  async function unlockClock(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await call<LicenseStatus>('license.unlock', { masterPassword });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That password was not accepted.');
      setWait(retrySeconds(err));
    } finally {
      setBusy(false);
    }
  }

  async function savePeriod(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await call<LicenseStatus>('license.activate', {
        masterPassword,
        edition: setup.edition,
        startsOn: setup.startsOn,
        endsOn: setup.endsOn
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The licence could not be updated.');
      setWait(retrySeconds(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen lock-screen" data-testid="license-lock">
      <div className="login-bg" aria-hidden="true" />
      <div className="auth-card wide-card" style={{ maxWidth: 720 }}>
        <img className="auth-logo" src={logoUrl} alt="Infoflex" />
        <div className="auth-title" data-testid="lock-title">
          {TITLES[reason] ?? TITLES.EXPIRED}
        </div>
        <div className="auth-tag">Strategy | Consulting | Innovation</div>

        <Alert tone="warn">
          <div style={{ minWidth: 0 }}>
            <strong>Your data is safe.</strong> Enter the update password to continue.
            <div className="tiny" style={{ marginTop: 4 }}>
              {EXPLAIN[reason] ?? EXPLAIN.EXPIRED} Expiring or locking never deletes, moves or encrypts
              your records.
            </div>
          </div>
        </Alert>

        {license ? (
          <div className="stack" style={{ gap: 4, marginBottom: 12 }}>
            <div className="tiny muted">
              {license.productName}
              {license.edition ? ` · ${license.edition} edition` : ''}
            </div>
            <LicensePeriodSummary license={license} />
          </div>
        ) : null}

        {step === 'PASSWORD' ? (
          <>
            <div className="wizard-steps" style={{ marginTop: 4 }}>
              <div className="wizard-step active" />
              <div className={`wizard-step ${clockOnly ? '' : 'active'}`} />
            </div>
            <form className="stack" onSubmit={clockOnly ? unlockClock : verify}>
              <Field
                label="Update password"
                hint="The vendor master password. Five wrong attempts start a 30 second delay, then 1 minute, 5 minutes…"
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
                    data-testid="lock-password"
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
              <Button type="submit" block disabled={busy || wait > 0 || lockedOut} data-testid="lock-continue">
                {busy ? 'Checking…' : wait > 0 ? `Wait ${wait}s` : clockOnly ? 'Unlock' : 'Continue'}
              </Button>
            </form>
          </>
        ) : (
          <form className="stack" onSubmit={savePeriod}>
            <Alert tone="info">
              Enter a new licence period. The end date must be in the future and the period may not reuse
              one that has already ended. Your store details are untouched.
            </Alert>
            <LicenseSetupForm value={setup} onChange={setSetup} disabled={busy} today={today} />
            {error ? <Alert tone="error">{error}</Alert> : null}
            <div className="row tight">
              <Button type="button" variant="ghost" onClick={() => setStep('PASSWORD')} disabled={busy}>
                Back
              </Button>
              <Button type="submit" className="grow" disabled={busy} data-testid="lock-save">
                {busy ? 'Saving…' : 'Save licence and unlock'}
              </Button>
            </div>
          </form>
        )}

        <div className="auth-foot">
          Infoflex · works offline · all data stays on this computer
          <br />
          Version {state?.version ?? '—'}
        </div>
      </div>
    </div>
  );
}
