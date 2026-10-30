import { useCallback, useEffect, useState } from 'react';
import { useApi, useSession, useApp } from '../state';
import { formatMoney } from '../../../shared/money';
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
  Select
} from '../components/ui';

interface ShiftRow {
  id: number;
  username: string;
  opened_at: string;
  closed_at: string | null;
  opening_float: number;
  counted_cash: number | null;
  expected_cash: number;
  variance: number;
  status: 'OPEN' | 'CLOSED';
  note: string | null;
}

interface DrawerRow {
  id: number;
  event_type: string;
  amount: number;
  reason: string | null;
  created_at: string;
  username: string | null;
}

export default function ShiftsPage() {
  const api = useApi();
  const session = useSession();
  const { notify } = useApp();
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [events, setEvents] = useState<DrawerRow[]>([]);
  const [openingFloat, setOpeningFloat] = useState(0);
  const [countedCash, setCountedCash] = useState(0);
  const [eventType, setEventType] = useState<'NO_SALE' | 'PAID_IN' | 'PAID_OUT'>('NO_SALE');
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = shifts.find((shift) => shift.status === 'OPEN' && shift.username === session.username) ?? null;

  const load = useCallback(async () => {
    const [rows, drawer] = await Promise.all([
      api<ShiftRow[]>('mart.shifts.list', { limit: 25 }),
      api<DrawerRow[]>('mart.drawer.list', {
        shiftId: shifts.find((shift) => shift.status === 'OPEN' && shift.username === session.username)?.id,
        limit: 50
      })
    ]);
    if (rows) setShifts(rows);
    if (drawer) setEvents(drawer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, session.username]);

  useEffect(() => {
    void load();
  }, [load]);

  async function startShift(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.shifts.open', { openingFloat: Math.round(openingFloat) });
      notify('Shift opened.', 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the shift.');
    } finally {
      setBusy(false);
    }
  }

  async function logEvent(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.drawer.log', {
        eventType,
        amount: Math.round(amount),
        reason: reason || undefined
      });
      notify('Drawer event recorded.', 'success');
      setAmount(0);
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the drawer event.');
    } finally {
      setBusy(false);
    }
  }

  async function endShift(event: React.FormEvent) {
    event.preventDefault();
    if (!open) return;
    setError(null);
    setBusy(true);
    try {
      await api('mart.shifts.close', { shiftId: open.id, countedCash: Math.round(countedCash) });
      notify('Shift closed and reconciled.', 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close the shift.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Shifts & Drawer"
        subtitle="Supermarket module: open a till, log drawer movements, then count and close the shift."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid-2">
        <Card
          title={open ? `Open shift · ${open.username}` : 'Start a shift'}
          actions={open ? <Badge tone="ok">Open since {formatDateTime(open.opened_at)}</Badge> : null}
        >
          {open ? (
            <div className="stack">
              <div className="kpi-row">
                <div className="kpi">
                  <div className="label">Opening float</div>
                  <div className="value">{formatMoney(open.opening_float)}</div>
                </div>
                <div className="kpi">
                  <div className="label">Expected in drawer</div>
                  <div className="value">{formatMoney(open.expected_cash)}</div>
                </div>
              </div>

              <form className="stack" onSubmit={logEvent}>
                <div className="form-grid">
                  <Field label="Drawer movement">
                    <Select value={eventType} onChange={(e) => setEventType(e.target.value as typeof eventType)}>
                      <option value="NO_SALE">No sale (open drawer)</option>
                      <option value="PAID_IN">Paid in</option>
                      <option value="PAID_OUT">Paid out</option>
                    </Select>
                  </Field>
                  <Field label="Amount (₦)">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      value={amount / 100}
                      onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))}
                      disabled={eventType === 'NO_SALE'}
                    />
                  </Field>
                  <Field label="Reason">
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. change for customer" />
                  </Field>
                </div>
                <Button type="submit" size="sm" variant="ghost" disabled={busy}>
                  Record movement
                </Button>
              </form>

              <div className="divider" />

              <form className="row tight" onSubmit={endShift} style={{ alignItems: 'flex-end' }}>
                <Field label="Counted cash (₦)">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={countedCash / 100}
                    onChange={(e) => setCountedCash(Math.round(Number(e.target.value) * 100))}
                    required
                  />
                </Field>
                <Button type="submit" size="sm" disabled={busy}>
                  Close shift
                </Button>
              </form>
            </div>
          ) : (
            <form className="stack" onSubmit={startShift}>
              <Field label="Opening float (₦)" hint="Cash already in the drawer when the shift begins.">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={openingFloat / 100}
                  onChange={(e) => setOpeningFloat(Math.round(Number(e.target.value) * 100))}
                />
              </Field>
              <Button type="submit" size="sm" disabled={busy}>
                Open shift
              </Button>
            </form>
          )}
        </Card>

        <Card title="Drawer log">
          <DataTable<DrawerRow>
            rows={events}
            empty="No drawer events for this shift."
            columns={[
              { key: 'created_at', label: 'When', render: (row) => formatDateTime(row.created_at) },
              { key: 'event_type', label: 'Event' },
              { key: 'amount', label: 'Amount', align: 'right', render: (row) => formatMoney(row.amount) },
              { key: 'reason', label: 'Reason', render: (row) => row.reason ?? '—' }
            ]}
          />
        </Card>
      </div>

      <Card title="Shift history">
        <DataTable<ShiftRow>
          rows={shifts}
          empty="No shifts yet."
          columns={[
            { key: 'username', label: 'Cashier' },
            { key: 'opened_at', label: 'Opened', render: (row) => formatDateTime(row.opened_at) },
            { key: 'closed_at', label: 'Closed', render: (row) => (row.closed_at ? formatDateTime(row.closed_at) : '—') },
            { key: 'opening_float', label: 'Float', align: 'right', render: (row) => formatMoney(row.opening_float) },
            { key: 'expected_cash', label: 'Expected', align: 'right', render: (row) => formatMoney(row.expected_cash) },
            {
              key: 'variance',
              label: 'Variance',
              align: 'right',
              render: (row) =>
                row.status === 'CLOSED' ? (
                  <span style={{ color: row.variance === 0 ? '#1e7a3c' : '#b3261e', fontWeight: 600 }}>
                    {formatMoney(row.variance)}
                  </span>
                ) : (
                  '—'
                )
            },
            {
              key: 'status',
              label: 'Status',
              render: (row) => <Badge tone={row.status === 'OPEN' ? 'warn' : 'neutral'}>{row.status}</Badge>
            }
          ]}
        />
      </Card>
    </div>
  );
}
