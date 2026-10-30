import React, { useState } from 'react';
import logoUrl from '../assets/logo.png';
import { useApp } from '../state';
import { call } from '../api';
import { Alert, Button, Field, Input } from '../components/ui';

export default function ChangePasswordPage() {
  const { state, session, refresh, notify, signOut } = useApp();
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forced = Boolean(session?.mustChangePassword);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirm) return setError('The two passwords do not match.');
    if (newPassword.length < 6) return setError('Use at least 6 characters.');
    setBusy(true);
    try {
      await call('auth.changePassword', { newPassword });
      await refresh();
      notify('Password updated.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img className="auth-logo" src={logoUrl} alt="" />
        <div className="auth-title">Set a new password</div>
        <div className="auth-tag">{state?.productName}</div>
        {forced ? (
          <Alert tone="warn">Your account was created with a temporary password. Choose your own to continue.</Alert>
        ) : null}
        <form className="stack" style={{ marginTop: 14 }} onSubmit={submit}>
          <Field label="New password">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoFocus
              required
              minLength={6}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={6}
            />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </Button>
          {forced ? (
            <Button type="button" variant="ghost" onClick={() => void signOut()}>
              Sign out instead
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
