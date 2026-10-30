import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { Alert, Button, Field, Input } from '../components/ui';

export default function LoginPage() {
  const { state, signIn, notify } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const license = state?.license;
  const expiring = license?.state === 'EXPIRING';

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
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo" src={logoUrl} alt={`${state?.productName ?? 'Infoflex'} logo`} />
        <div className="auth-title">{state?.productName ?? 'Infoflex'}</div>
        <div className="auth-tag">Strategy | Consulting | Innovation</div>

        {license?.edition ? (
          <div className="center small muted" style={{ marginBottom: 16 }}>
            {license.edition === 'BOTH' ? 'Pharmacy & Supermarket' : license.edition.toLowerCase()} edition ·
            licensed to {license.customerName}
          </div>
        ) : null}

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
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="••••••••"
              required
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <div className="auth-foot">
          Works offline · all data stays on this computer
          <br />
          Forgot your password? An administrator can reset it from Users.
        </div>
      </div>
    </div>
  );
}
