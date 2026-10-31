import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../state';
import { Alert, Badge, Button, Card, DataTable, Field, Input, PageHead } from '../components/ui';

interface DepartmentRow {
  id: number;
  name: string;
  description: string | null;
  active: number;
}

const empty = { id: undefined as number | undefined, name: '', description: '' };

export default function DepartmentsPage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [rows, setRows] = useState<DepartmentRow[]>([]);
  const [draft, setDraft] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const admin = can('products.manage');

  const load = useCallback(async () => {
    const data = await api<DepartmentRow[]>('mart.departments.list', {});
    if (data) setRows(data);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.departments.save', { ...draft, id: draft.id ?? undefined });
      notify(`${draft.name} saved.`, 'success');
      setDraft(empty);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the department.');
    } finally {
      setBusy(false);
    }
  }

  async function toggle(row: DepartmentRow) {
    await api('mart.departments.save', { id: row.id, name: row.name, description: row.description, active: !row.active });
    await load();
  }

  return (
    <div className="stack">
      <PageHead
        title="Departments"
        subtitle="Supermarket module: group products into departments for the shelf layout and price rules."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card title={`${rows.length} department${rows.length === 1 ? '' : 's'}`}>
        <DataTable<DepartmentRow>
          rows={rows}
          empty="No departments yet."
          columns={[
            { key: 'name', label: 'Department' },
            { key: 'description', label: 'Description', render: (row) => row.description ?? '—' },
            {
              key: 'active',
              label: 'Status',
              render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Active' : 'Inactive'}</Badge>
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (row) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft({ id: row.id, name: row.name, description: row.description ?? '' })}
                  >
                    Edit
                  </Button>
                  {admin ? (
                    <Button size="sm" variant="ghost" onClick={() => void toggle(row)}>
                      {row.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  ) : null}
                </div>
              )
            }
          ]}
        />
      </Card>

      {admin ? (
        <Card title={draft.id ? 'Edit department' : 'Add a department'}>
          <form className="stack" onSubmit={save}>
            <div className="form-grid">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
              </Field>
              <Field label="Description">
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </Field>
            </div>
            <div className="row tight">
              <Button type="submit" size="sm" disabled={busy}>
                {draft.id ? 'Save changes' : 'Add department'}
              </Button>
              {draft.id ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(empty)}>
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      ) : (
        <p className="tiny muted">Only an administrator can add or change departments.</p>
      )}
    </div>
  );
}
