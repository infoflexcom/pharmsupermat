import { useCallback, useEffect, useState } from 'react';
import { call, isDesktop } from '../api';
import { useApp } from '../state';
import type { BackupInfo, BackupStatus } from '../../../shared/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDateTime,
  Input,
  Kpi,
  PageHead
} from '../components/ui';

/** What a restore gives back, so the page can reassure about the licence. */
interface RestoreResult {
  restoredFrom: string;
  safetyCopy: string;
  license: { state: string; edition: string | null; expiresAt: string | null };
  backupLicense: { state: string; edition: string | null } | null;
}

export default function BackupPage() {
  const { notify, refresh, signOut } = useApp();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState('');
  const [restorePath, setRestorePath] = useState('');
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [lastRestore, setLastRestore] = useState<RestoreResult | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [list, state] = await Promise.all([
        call<BackupInfo[]>('backup.list'),
        call<BackupStatus>('backup.status')
      ]);
      setBackups(list ?? []);
      setStatus(state ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not list backups.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run<T>(work: () => Promise<T>, success?: string): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (success) notify(success, 'success');
      await load();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'That did not work.';
      setError(message);
      notify(message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function backupNow() {
    await run(() => call<BackupInfo>('backup.create', { label: 'manual' }), 'Backup created.');
  }

  async function chooseFolder(): Promise<string | null> {
    if (isDesktop()) {
      try {
        const picked = await call<{ folder: string | null }>('backup.chooseFolder');
        if (picked?.folder) {
          setFolder(picked.folder);
          return picked.folder;
        }
        return null;
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Could not open the folder picker.', 'info');
        return null;
      }
    }
    return folder.trim() || null;
  }

  async function backupToFolder() {
    const target = await chooseFolder();
    if (!target) {
      notify('Choose a folder first (a flash drive, for example).', 'info');
      return;
    }
    await run(
      () => call<BackupInfo>('backup.create', { label: 'manual', folder: target }),
      'Backup copied to the chosen folder.'
    );
  }

  async function copyBackup(info: BackupInfo) {
    const target = await chooseFolder();
    if (!target) {
      notify('Choose a folder first.', 'info');
      return;
    }
    await run(() => call<BackupInfo>('backup.copy', { path: info.path, folder: target }), 'Backup copied.');
  }

  async function chooseFile() {
    if (isDesktop()) {
      try {
        const picked = await call<{ path: string | null }>('backup.chooseFile');
        if (picked?.path) setRestorePath(picked.path);
      } catch (err) {
        notify(err instanceof Error ? err.message : 'Could not open the file picker.', 'info');
      }
    }
  }

  async function restore(path: string) {
    const name = path.split(/[\\/]/).pop() ?? '';
    const result = await run(
      () =>
        call<RestoreResult>('backup.restore', {
          path,
          confirm: name
        }),
      'Backup restored. Please sign in again.'
    );
    setConfirmRestore(null);
    setConfirmText('');
    if (!result) return;
    setLastRestore(result);
    await refresh();
    await signOut();
  }

  const staleTone = !status ? 'neutral' : status.stale ? 'warn' : 'success';

  return (
    <div className="stack">
      <PageHead
        title="Backup & restore"
        subtitle="Plain SQLite snapshots on this computer, a flash drive or another disk. Nothing is uploaded anywhere."
        actions={
          <div className="row tight wrap">
            <Button variant="ghost" onClick={() => void backupToFolder()} disabled={busy}>
              Back up to a folder…
            </Button>
            <Button onClick={() => void backupNow()} disabled={busy}>
              {busy ? 'Working…' : 'Back up now'}
            </Button>
          </div>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {status?.stale ? (
        <Alert tone="warn">
          {status.lastAt
            ? `The newest backup is ${status.daysSince} day(s) old. Plug in your backup drive and take one now.`
            : 'There is no backup on this computer yet. Take one now and copy it to a flash drive.'}
        </Alert>
      ) : null}

      {lastRestore ? (
        <Alert tone="success">
          Restored <strong>{lastRestore.restoredFrom.split(/[\\/]/).pop()}</strong>. Your licence was kept:{' '}
          {lastRestore.license.edition ?? 'unknown edition'} ({lastRestore.license.state.toLowerCase()})
          {lastRestore.license.expiresAt
            ? `, expires ${new Date(lastRestore.license.expiresAt).toLocaleDateString()}`
            : ''}
          . The previous data was saved as <strong>{lastRestore.safetyCopy.split(/[\\/]/).pop()}</strong>.
        </Alert>
      ) : null}

      <div className="kpi-grid">
        <Kpi
          label="Last backup"
          value={status?.lastAt ? formatDateTime(status.lastAt) : 'Never'}
          hint={status?.daysSince === null || status === null ? 'Take one now' : `${status.daysSince} day(s) ago`}
        />
        <Kpi label="Backups kept" value={String(status?.count ?? backups.length)} hint="In the app's backups folder" />
        <Kpi
          label="Automatic daily backup"
          value={status?.automatic ? 'On' : 'Off'}
          hint={status?.automatic ? 'When the app opens, at most once a day' : 'Only in the desktop app'}
        />
        <Kpi
          label="Warning threshold"
          value={`${status?.warnAfterDays ?? 7} days`}
          hint="A banner appears when no backup is newer than this"
        />
      </div>

      <Card
        title={`${backups.length} backup file(s)`}
        actions={<Badge tone={staleTone}>{status?.stale ? 'Needs attention' : 'Up to date'}</Badge>}
      >
        <DataTable
          rows={backups}
          columns={[
            { key: 'name', label: 'File' },
            { key: 'label', label: 'Kind', render: (row) => <Badge tone="neutral">{String(row.label)}</Badge> },
            { key: 'createdAt', label: 'Created', render: (row) => formatDateTime(String(row.createdAt)) },
            { key: 'size', label: 'Size', align: 'right', render: (row) => `${(Number(row.size) / 1024).toFixed(0)} KB` },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (row) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void copyBackup(row)}>
                    Copy…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setConfirmText('');
                      setConfirmRestore(row);
                    }}
                  >
                    Restore
                  </Button>
                </div>
              )
            }
          ]}
          getKey={(row) => String(row.path)}
          empty="No backups found yet. Take one now."
        />
      </Card>

      <Card title="Restore from a file">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr auto auto' }}>
          <Field label="Full path to a .db backup" hint="For example a backup you copied to a flash drive.">
            <Input
              value={restorePath}
              placeholder="D:\\infoflex-backup_2026-03-05_14-22-01_manual.db"
              onChange={(e) => setRestorePath(e.target.value)}
            />
          </Field>
          {isDesktop() ? (
            <Field label="&nbsp;">
              <Button variant="ghost" onClick={() => void chooseFile()} disabled={busy}>
                Browse…
              </Button>
            </Field>
          ) : null}
          <Field label="&nbsp;">
            <Button
              variant="ghost"
              disabled={busy || !restorePath.trim()}
              onClick={() => {
                const path = restorePath.trim();
                setConfirmText('');
                setConfirmRestore({
                  name: path.split(/[\\/]/).pop() ?? path,
                  path,
                  size: 0,
                  createdAt: '',
                  label: 'external',
                  external: true
                });
              }}
            >
              Restore this file
            </Button>
          </Field>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          Restoring replaces the shop's data. The licence on this computer is kept as it is, and the current database is
          saved beside the backups first, so a restore can be undone.
        </div>
      </Card>

      {confirmRestore ? (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && setConfirmRestore(null)}>
          <div className="modal narrow" role="dialog" aria-modal="true">
            <div className="modal-head">
              <h2>Restore this backup?</h2>
            </div>
            <div className="modal-body">
              <Alert tone="warn">
                Everything currently in the app is replaced with <strong>{confirmRestore.name}</strong>. You will be
                signed out. Your licence stays exactly as it is.
              </Alert>
              <Field
                label={`Type “${confirmRestore.name}” to confirm`}
                hint="This is what stops a stray click from wiping the shop."
              >
                <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
              </Field>
            </div>
            <div className="modal-foot">
              <Button variant="ghost" onClick={() => setConfirmRestore(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => void restore(confirmRestore.path)}
                disabled={busy || confirmText.trim() !== confirmRestore.name}
              >
                Restore backup
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <Card title="Where is my data?">
        <div className="stack small">
          <div>
            <Badge tone="neutral">Database</Badge> infoflex.db inside the app data folder
          </div>
          <div>
            <Badge tone="neutral">Backups</Badge> <code>{status?.backupsDir ?? 'app data folder / backups'}</code>
          </div>
          <div>
            <Badge tone="neutral">Printed documents</Badge> app data folder / exports (when you use Save)
          </div>
          <div>
            <Badge tone="gold">Tip</Badge> keep one copy in the shop and one on a flash drive you take home.
          </div>
        </div>
      </Card>
    </div>
  );
}
