import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { useApp } from '../state';
import type { LicenseHistoryEntry, LicenseStatus } from '../../../shared/types';
import { addYears, localDate } from '../../../shared/license-dates';
import { Alert, Badge, Button, Card, Field, Input, PageHead } from '../components/ui';
import { LicenseSetupForm, EDITION_CHOICES, type LicenseSetupValue } from '../components/LicenseSetupForm';

function statusBadge(license: LicenseStatus | undefined) {
  if (!license) return <Badge tone="neutral">Unknown</Badge>;
  switch (license.state) {
    case 'VALID':
      return <Badge tone="ok">Active</Badge>;
    case 'EXPIRING':
      return <Badge tone="warn">Expires in {license.daysRemaining}d</Badge>;
    case 'EXPIRED':
      return <Badge tone="danger">Expired</Badge>;
    default:
      return <Badge tone="danger">{license.state.replace('_', ' ')}</Badge>;
  }
}

export default function LicensePage() {
  const { state, refresh, notify } = useApp();
  const license = state?.license;
  const today = useMemo(() => localDate(), []);
  const [history, setHistory] = useState<LicenseHistoryEntry[]>([]);
  const [masterPassword, setMasterPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [setup, setSetup] = useState<LicenseSetupValue>({
    edition: license?.edition ?? 'PHARMACY',
    startsOn: today,
    endsOn: addYears(today, 1)
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renewOpen, setRenewOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      setHistory(await call<LicenseHistoryEntry[]>('license.history'));
    } catch {
      setHistory([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function renew(event: React.FormEvent) {
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
      await refresh();
      await loadHistory();
      setMasterPassword('');
      setRenewOpen(false);
      notify(`Licence updated — locks at 00:00 on ${status.endsOn}.`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the licence.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Licence"
        subtitle="The signed licence that unlocks this installation. It is checked on every launch, every minute while running and at midnight."
        actions={statusBadge(license)}
      />

      {license?.warning ? (
        <Alert tone={license.warning.level <= 7 ? 'warn' : 'info'}>
          This licence ends in {license.daysRemaining} day(s). Renew before 00:00 on {license.endsOn} to
          avoid a lockout.
        </Alert>
      ) : null}

      <div className="grid two">
        <Card title="Current licence">
          <div className="stack" style={{ gap: 10 }}>
            <div className="row tight">
              <span className="muted small">Product</span>
              <span className="spacer" />
              <strong>{license?.productName ?? 'Infoflex'}</strong>
            </div>
            <div className="row tight">
              <span className="muted small">Edition</span>
              <span className="spacer" />
              <strong>
                {EDITION_CHOICES.find((choice) => choice.value === license?.edition)?.title ?? 'Not activated'}
              </strong>
            </div>
            <div className="row tight">
              <span className="muted small">Period</span>
              <span className="spacer" />
              <strong>{license?.startsOn ?? '—'}</strong>
              <span className="muted small">→</span>
              <strong>{license?.endsOn ?? '—'}</strong>
            </div>
            <div className="row tight">
              <span className="muted small">Days remaining</span>
              <span className="spacer" />
              <strong>{license?.daysRemaining ?? '—'}</strong>
            </div>
            <div className="tiny muted">
              The end date is exclusive: the app locks at 00:00 on {license?.endsOn ?? 'the end date'}.
              Expiring never deletes or encrypts your data.
            </div>
          </div>
        </Card>

        <Card title="Renew or change edition">
          {!renewOpen ? (
            <div className="stack">
              <div className="small muted">
                Renewal needs the vendor master password. It never asks for the store details again and
                never changes them.
              </div>
              <Button onClick={() => setRenewOpen(true)}>Open renewal</Button>
            </div>
          ) : (
            <form className="stack" onSubmit={renew}>
              <Field label="Vendor master password" hint="Checked against a salted hash; never stored.">
                <div className="password-wrap">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={masterPassword}
                    autoComplete="off"
                    onChange={(event) => setMasterPassword(event.target.value)}
                    placeholder="••••••••••••"
                    required
                    data-testid="license-page-password"
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
              <LicenseSetupForm value={setup} onChange={setSetup} disabled={busy} today={today} />
              {error ? <Alert tone="error">{error}</Alert> : null}
              <div className="row tight">
                <Button type="button" variant="ghost" onClick={() => setRenewOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" className="grow" disabled={busy}>
                  {busy ? 'Saving…' : 'Save new period'}
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      <Card title="Licence history">
        {history.length === 0 ? (
          <div className="muted small">No licence changes recorded yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Edition</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => (
                  <tr key={entry.id}>
                    <td>{new Date(entry.createdAt).toLocaleString()}</td>
                    <td>
                      <Badge tone={entry.action === 'ACTIVATE' ? 'ok' : entry.action === 'UNLOCK' ? 'gold' : 'info'}>
                        {entry.action.toLowerCase()}
                      </Badge>
                    </td>
                    <td>{entry.edition}</td>
                    <td>{entry.startsOn}</td>
                    <td>{entry.endsOn}</td>
                    <td>{entry.createdBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
