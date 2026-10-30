import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../state';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDateTime,
  Input,
  PageHead,
  SearchBox
} from '../components/ui';

interface MemberRow {
  id: number;
  member_no: string;
  name: string;
  phone: string | null;
  email: string | null;
  points: number;
  active: number;
}

interface TransactionRow {
  id: number;
  points_change: number;
  reason: string | null;
  created_at: string;
}

const emptyMember = { id: undefined as number | undefined, name: '', phone: '', email: '' };

export default function LoyaltyPage() {
  const api = useApi();
  const { notify } = useApp();
  const [search, setSearch] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [selected, setSelected] = useState<MemberRow | null>(null);
  const [transactions, setTransactions] = useState<TransactionRow[]>([]);
  const [draft, setDraft] = useState(emptyMember);
  const [points, setPoints] = useState(10);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const rows = await api<MemberRow[]>('mart.loyalty.list', { search: search || undefined });
    if (rows) setMembers(rows);
  }, [api, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function select(member: MemberRow) {
    setSelected(member);
    const rows = await api<TransactionRow[]>('mart.loyalty.transactions', { memberId: member.id, limit: 25 });
    setTransactions(rows ?? []);
  }

  async function saveMember(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.loyalty.save', { ...draft, id: draft.id ?? undefined });
      notify(`${draft.name} saved.`, 'success');
      setDraft(emptyMember);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the member.');
    } finally {
      setBusy(false);
    }
  }

  async function adjust(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      await api('mart.loyalty.adjust', { memberId: selected.id, points, reason: reason || undefined });
      notify(`${points > 0 ? 'Added' : 'Removed'} ${Math.abs(points)} points.`, 'success');
      setReason('');
      await load();
      await select({ ...selected, points: selected.points + points });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not adjust the points.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Loyalty"
        subtitle="Supermarket module: member records and the points ledger behind them."
        actions={<SearchBox value={search} onChange={setSearch} placeholder="Search name, number or phone" />}
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid-2">
        <Card title={`Members (${members.length})`}>
          <DataTable<MemberRow>
            rows={members}
            empty="No loyalty members yet."
            columns={[
              { key: 'member_no', label: 'Member no.' },
              { key: 'name', label: 'Name' },
              { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
              { key: 'points', label: 'Points', align: 'right' },
              {
                key: 'active',
                label: 'Status',
                render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Active' : 'Inactive'}</Badge>
              }
            ]}
            onRowClick={(row) => void select(row)}
          />
          <form className="stack" style={{ marginTop: 14 }} onSubmit={saveMember}>
            <div className="form-grid">
              <Field label="Member name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} required />
              </Field>
              <Field label="Phone">
                <Input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              Add member
            </Button>
          </form>
        </Card>

        <Card
          title={selected ? `${selected.name} · ${selected.points} points` : 'Points ledger'}
          actions={selected ? <Badge tone="gold">{selected.member_no}</Badge> : null}
        >
          {selected ? (
            <form className="row tight" onSubmit={adjust} style={{ alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
              <Field label="Points (± )">
                <Input
                  type="number"
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value))}
                  style={{ width: 100 }}
                  required
                />
              </Field>
              <Field label="Reason">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. goodwill" />
              </Field>
              <Button type="submit" size="sm" disabled={busy}>
                Apply
              </Button>
            </form>
          ) : (
            <p className="tiny muted">Pick a member to see and adjust their points.</p>
          )}
          <DataTable<TransactionRow>
            rows={transactions}
            empty="No points activity yet."
            columns={[
              { key: 'created_at', label: 'When', render: (row) => formatDateTime(row.created_at) },
              {
                key: 'points_change',
                label: 'Change',
                align: 'right',
                render: (row) => (
                  <span style={{ color: row.points_change >= 0 ? '#1e7a3c' : '#b3261e', fontWeight: 600 }}>
                    {row.points_change > 0 ? `+${row.points_change}` : row.points_change}
                  </span>
                )
              },
              { key: 'reason', label: 'Reason', render: (row) => row.reason ?? '—' }
            ]}
          />
        </Card>
      </div>
    </div>
  );
}
