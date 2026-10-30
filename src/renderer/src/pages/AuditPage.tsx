import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../state';
import type { AuditEntry } from '../../../shared/types';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDateTime,
  Input,
  PageHead,
  SearchBox,
  todayInput,
  daysAgoInput
} from '../components/ui';

export default function AuditPage() {
  const api = useApi();
  const [from, setFrom] = useState(daysAgoInput(13));
  const [to, setTo] = useState(todayInput());
  const [search, setSearch] = useState('');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api<AuditEntry[]>('audit.list', { from, to, search: search || undefined, limit: 800 });
    if (data) setEntries(data);
    setLoading(false);
  }, [api, from, to, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <div className="stack">
      <PageHead
        title="Audit trail"
        subtitle="Append-only record of sales, voids, returns, price changes, stock counts, sign-ins and configuration changes."
        actions={
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 2fr auto' }}>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Search">
            <SearchBox value={search} onChange={setSearch} placeholder="Action, user or details" />
          </Field>
          <Field label="&nbsp;">
            <Button variant="ghost" onClick={() => void load()}>
              Apply
            </Button>
          </Field>
        </div>
      </Card>

      <Card title={`${entries.length} entries`}>
        <DataTable
          rows={entries}
          columns={[
            { key: 'createdAt', label: 'When', render: (r) => formatDateTime(r.createdAt) },
            { key: 'username', label: 'User', render: (r) => r.username ?? '—' },
            { key: 'action', label: 'Action' },
            { key: 'entity', label: 'Entity', render: (r) => (r.entity ? `${r.entity}#${r.entityId ?? ''}` : '—') },
            {
              key: 'severity',
              label: 'Severity',
              render: (r) =>
                r.severity === 'SECURITY' ? (
                  <Badge tone="danger">Security</Badge>
                ) : r.severity === 'WARN' ? (
                  <Badge tone="warn">Warning</Badge>
                ) : (
                  <Badge tone="neutral">Info</Badge>
                )
            },
            {
              key: 'details',
              label: 'Details',
              render: (r) => (
                <span className="small muted" title={r.details ?? ''}>
                  {(r.details ?? '').slice(0, 110)}
                  {(r.details ?? '').length > 110 ? '…' : ''}
                </span>
              )
            }
          ]}
          empty={loading ? 'Loading…' : 'No audit entries in this period.'}
        />
      </Card>
    </div>
  );
}
