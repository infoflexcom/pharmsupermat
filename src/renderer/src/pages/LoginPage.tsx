import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { Alert, Button, Field, Input } from '../components/ui';

/**
 * The front door: full-screen brand backdrop (blurred navy mark), the Infoflex
 * logo, the product name for the active edition, the tagline, the sign-in card
 * and — once the shop has been set up — the customer's own store name.
 */
export default function LoginPage() {
  const { state, signIn, notify } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const license = state?.license;
  const expiring = license?.state === 'EXPIRING';
  const editionLabel = license?.edition
    ? license.edition === 'BOTH'
      ? 'Pharmacy & Supermarket edition'
      : `${license.edition === 'PHARMACY' ? 'Pharmacy' : 'Supermarket'} edition`
    : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const session = await signIn(username.trim(), password);
      notify(`Welcome back, ${session.fullName.split(' ')[0]}.`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen login-screen">
      <div className="login-bg" aria-hidden="true" />

      <div className="login-stage">
        <div className="login-brand">
          <img className="login-logo" src={logoUrl} alt={`${state?.productName ?? 'Infoflex'} logo`} />
          <div className="login-product">{state?.productName ?? 'Infoflex'}</div>
          <div className="login-tagline">Strategy | Consulting | Innovation</div>
          {editionLabel ? <div className="login-edition">{editionLabel}</div> : null}
        </div>

        <div className="auth-card login-card">
          <div className="auth-title">Sign in</div>
          <div className="auth-tag">Enter the account your administrator created for you.</div>

          {expiring ? (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="warn">
                Your licence expires in {license?.daysRemaining} day(s). Ask Infoflex to renew before it lapses.
              </Alert>
            </div>
          ) : null}

          <form className="stack" onSubmit={submit}>
            <Field label="Username">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
                autoComplete="username"
                placeholder="Your username"
                required
              />
            </Field>
            <Field label="Password">
              <div className="password-wrap">
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  required
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
            <Button type="submit" disabled={busy} block>
              {busy ? 'Signing in…' : 'Login'}
            </Button>
          </form>

          <div className="auth-foot">
            Works offline · all data stays on this computer
            <br />
            No self sign-up. A forgotten password is reset by an administrator.
          </div>
        </div>

        {state?.storeName ? (
          <div className="login-store" data-testid="login-store-name">
            {state.storeName}
          </div>
        ) : null}

        <div className="login-version">Infoflex v{state?.version ?? '—'}</div>
      </div>
    </div>
  );
}
