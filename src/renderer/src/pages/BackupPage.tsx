import { useCallback, useEffect, useState } from 'react';
import { call, isDesktop } from '../api';
import { useApp } from '../state';
import { Alert, Badge, Button, Card, DataTable, Field, formatDateTime, Input, PageHead } from '../components/ui';

interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

export default function BackupPage() {
  const { notify, refresh, signOut } = useApp();
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [restorePath, setRestorePath] = useState('');
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await call<BackupInfo[]>('backup.list');
      setBackups(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not list backups.', 'error');
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const info = await call<BackupInfo>('backup.create', { label: 'manual' });
      notify(`Backup created: ${info.name}`, 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Backup failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function restore(path: string) {
    setBusy(true);
    try {
      await call('backup.restore', { path });
      notify('Backup restored. Please sign in again.', 'success');
      await load();
      await refresh();
      await signOut();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Restore failed.', 'error');
    } finally {
      setBusy(false);
      setConfirmRestore(null);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Backup & restore"
        subtitle="Backups are plain SQLite snapshots stored on this computer. Copy them to a flash drive or another disk regularly."
        actions={
          <Button onClick={create} disabled={busy}>
            {busy ? 'Working…' : 'Back up now'}
          </Button>
        }
      />

      <Alert tone="info">
        An automatic backup is taken once a day when you open the app, and again when you close it.
        {isDesktop() ? ' Backups live in the app data folder (Help → Open data folder).' : ''}
      </Alert>

      <Card title={`${backups.length} backup file(s)`}>
        <DataTable
          rows={backups}
          columns={[
            { key: 'name', label: 'File' },
            { key: 'createdAt', label: 'Created', render: (r) => formatDateTime(r.createdAt) },
            { key: 'size', label: 'Size', align: 'right', render: (r) => `${(r.size / 1024).toFixed(0)} KB` },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (r) => (
                <Button size="sm" variant="ghost" onClick={() => setConfirmRestore(r)}>
                  Restore
                </Button>
              )
            }
          ]}
          empty="No backups found yet."
        />
      </Card>

      <Card title="Restore from a file">
        <div className="form-grid" style={{ gridTemplateColumns: '1fr auto' }}>
          <Field label="Full path to a .db backup" hint="e.g. C:\\Users\\You\\Documents\\infoflex-backup.db">
            <Input value={restorePath} onChange={(e) => setRestorePath(e.target.value)} />
          </Field>
          <Field label="&nbsp;">
            <Button
              variant="ghost"
              onClick={() => setConfirmRestore({ name: restorePath, path: restorePath, size: 0, createdAt: '' })}
              disabled={!restorePath.trim()}
            >
              Restore this file
            </Button>
          </Field>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          Restoring replaces all current data. A safety copy of the current database is saved first.
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
                Everything currently in the app will be replaced with{' '}
                <strong>{confirmRestore.name}</strong>. You will be signed out.
              </Alert>
            </div>
            <div className="modal-foot">
              <Button variant="ghost" onClick={() => setConfirmRestore(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void restore(confirmRestore.path)} disabled={busy}>
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
            <Badge tone="neutral">Backups</Badge> app data folder / backups
          </div>
          <div>
            <Badge tone="neutral">Printed documents</Badge> app data folder / exports (when you use Save)
          </div>
        </div>
      </Card>
    </div>
  );
}
