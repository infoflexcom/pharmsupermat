import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Role, UserAccount } from '../../../shared/types';
import { ROLE_LABELS } from '../../../shared/permissions';
import { availableRoles } from '../../../shared/editions';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDateTime,
  Input,
  Modal,
  PageHead,
  Select
} from '../components/ui';

export default function UsersPage() {
  const api = useApi();
  const { state, notify, session } = useApp();
  const [rows, setRows] = useState<UserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserAccount | null>(null);
  const [resetting, setResetting] = useState<UserAccount | null>(null);
  const [form, setForm] = useState({ username: '', fullName: '', role: 'CASHIER' as Role, password: '' });
  const [newPassword, setNewPassword] = useState('');
  const edition = state?.license.edition ?? null;
  const roles = availableRoles(edition);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api<UserAccount[]>('users.list');
    if (data) setRows(data);
    setLoading(false);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function createUser() {
    try {
      await call('users.create', form);
      notify(`${form.fullName} added. They must set a new password at first sign-in.`, 'success');
      setCreating(false);
      setForm({ username: '', fullName: '', role: 'CASHIER', password: '' });
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not add the user.', 'error');
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      await call('users.update', {
        id: editing.id,
        fullName: editing.fullName,
        role: editing.role,
        active: editing.active
      });
      notify('User updated.', 'success');
      setEditing(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update the user.', 'error');
    }
  }

  async function resetPassword() {
    if (!resetting) return;
    try {
      await call('users.resetPassword', { id: resetting.id, newPassword });
      notify(`Password reset for ${resetting.username}.`, 'success');
      setResetting(null);
      setNewPassword('');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not reset the password.', 'error');
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Users"
        subtitle="Only an administrator can add users or set passwords. Supervisors can approve voids, refunds and price overrides."
        actions={
          <Button onClick={() => setCreating(true)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M12 5v14M5 12h14" strokeLinecap="round" />
            </svg>
            Add user
          </Button>
        }
      />

      {edition === 'PHARMACY' ? (
        <Alert tone="info">
          The pharmacy edition has Administrators and Cashiers. Supervisor accounts are part of the supermarket
          edition.
        </Alert>
      ) : null}

      <Card title={`${rows.length} account(s)`}>
        <DataTable
          rows={rows}
          columns={[
            { key: 'fullName', label: 'Name' },
            { key: 'username', label: 'Username' },
            { key: 'role', label: 'Role', render: (r) => ROLE_LABELS[r.role] },
            {
              key: 'active',
              label: 'Status',
              render: (r) => (r.active ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">Disabled</Badge>)
            },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (r) => formatDateTime(r.lastLoginAt) },
            {
              key: 'mustChangePassword',
              label: '',
              render: (r) => (r.mustChangePassword ? <Badge tone="warn">Temp password</Badge> : null)
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (r) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ ...r })}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setResetting(r)}>
                    Reset password
                  </Button>
                </div>
              )
            }
          ]}
          empty={loading ? 'Loading…' : 'No users yet.'}
        />
      </Card>

      {creating ? (
        <Modal
          title="Add user"
          size="sm"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button onClick={createUser} disabled={!form.username || !form.fullName || form.password.length < 6}>
                Create user
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Full name">
              <Input value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} autoFocus />
            </Field>
            <Field label="Username" hint="3-32 characters; letters, numbers, dot, dash, underscore.">
              <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temporary password" hint="They will be asked to change it at first sign-in.">
              <Input
                type="text"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {editing ? (
        <Modal
          title={`Edit ${editing.username}`}
          size="sm"
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button onClick={saveEdit}>Save changes</Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Full name">
              <Input value={editing.fullName} onChange={(e) => setEditing({ ...editing, fullName: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })}>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_LABELS[role]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={editing.active ? 'active' : 'disabled'}
                onChange={(e) => setEditing({ ...editing, active: e.target.value === 'active' })}
              >
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </Select>
            </Field>
            {editing.id === session?.userId ? (
              <Alert tone="warn">This is your own account — you cannot disable the last administrator.</Alert>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {resetting ? (
        <Modal
          title={`Reset password — ${resetting.username}`}
          size="sm"
          onClose={() => setResetting(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setResetting(null)}>
                Cancel
              </Button>
              <Button onClick={resetPassword} disabled={newPassword.length < 6}>
                Set password
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="info">The user will be required to change this temporary password.</Alert>
            <Field label="New temporary password">
              <Input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
