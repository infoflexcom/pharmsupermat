import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi, useApp } from '../state';
import type { StockCountDetail, StockCountItemRow, StockCountRow } from '../../../shared/types';
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
  Kpi,
  Money,
  PageHead
} from '../components/ui';

/**
 * Stocktake — count the shelves, see the variance, then post it. Posting writes
 * one stock movement per line with type COUNT, so the ledger shows exactly why
 * the quantity changed.
 */
export default function StocktakePage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [counts, setCounts] = useState<StockCountRow[]>([]);
  const [detail, setDetail] = useState<StockCountDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const rows = await api<StockCountRow[]>('stocktake.list', { limit: 40 });
    if (rows) setCounts(rows);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = useCallback(
    async (id: number) => {
      const data = await api<StockCountDetail>('stocktake.get', { id });
      setDetail(data);
      setDrafts({});
    },
    [api]
  );

  async function startCount() {
    setError(null);
    setBusy(true);
    try {
      const data = await api<StockCountDetail>('stocktake.create', { note: note || undefined });
      setDetail(data);
      setNote('');
      await load();
      notify('Count sheet created from current stock.', 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a count.');
    } finally {
      setBusy(false);
    }
  }

  async function saveProgress() {
    if (!detail) return;
    const entries = Object.entries(drafts)
      .filter(([, value]) => value !== '')
      .map(([itemId, value]) => ({ itemId: Number(itemId), countedQty: Number(value) }));
    if (entries.length === 0) return setError('Type at least one counted quantity.');
    setBusy(true);
    setError(null);
    try {
      const data = await api<StockCountDetail>('stocktake.save', {
        countId: detail.count.id,
        entries
      });
      setDetail(data);
      setDrafts({});
      notify(`${entries.length} line(s) saved.`, 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the count.');
    } finally {
      setBusy(false);
    }
  }

  async function post() {
    if (!detail) return;
    if (!window.confirm('Post this count? Stock quantities will be changed to the counted values and cannot be reverted.')) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const data = await api<StockCountDetail>('stocktake.post', { countId: detail.count.id });
      setDetail(data);
      setDrafts({});
      notify('Count posted — stock adjusted.', 'success');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post the count.');
    } finally {
      setBusy(false);
    }
  }

  const draftRows = useMemo(() => {
    if (!detail) return [];
    return detail.items.map((item) => ({ ...item, draft: drafts[item.id] }));
  }, [detail, drafts]);

  const liveVariance = useMemo(() => {
    if (!detail) return { qty: 0, value: 0 };
    return detail.items.reduce(
      (sum, item) => {
        const raw = drafts[item.id];
        const counted = raw === undefined || raw === '' ? item.counted_qty : Number(raw);
        if (counted === null || counted === undefined) return sum;
        const variance = counted - item.system_qty;
        return { qty: sum.qty + variance, value: sum.value + variance * item.cost_price };
      },
      { qty: 0, value: 0 }
    );
  }, [detail, drafts]);

  const isDraft = detail?.count.status === 'DRAFT';

  return (
    <div className="stack">
      <PageHead
        title="Stocktake"
        subtitle="Count the shelves, review the variance, then post it. Only an administrator can post a count — every adjustment is logged with its reason."
        actions={
          <Button onClick={startCount} disabled={busy || !can('stock.adjust')}>
            Start new count
          </Button>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {!can('stock.adjust') ? (
        <Alert tone="info">Counts are visible here, but only an administrator can start or post one.</Alert>
      ) : null}

      <Card title="Recent counts">
        <DataTable<StockCountRow>
          rows={counts}
          empty="No counts yet."
          onRowClick={(row) => void open(row.id)}
          columns={[
            { key: 'count_no', label: 'Count' },
            {
              key: 'status',
              label: 'Status',
              render: (row) => (
                <Badge tone={row.status === 'POSTED' ? 'success' : row.status === 'CANCELLED' ? 'neutral' : 'warn'}>
                  {row.status}
                </Badge>
              )
            },
            { key: 'items_counted', label: 'Lines', align: 'right' },
            {
              key: 'variance_qty',
              label: 'Variance qty',
              align: 'right',
              render: (row) => (
                <span style={{ fontWeight: 600, color: row.variance_qty < 0 ? '#b42318' : '#1e7a52' }}>
                  {row.variance_qty > 0 ? `+${row.variance_qty}` : row.variance_qty}
                </span>
              )
            },
            {
              key: 'variance_value',
              label: 'Variance value',
              align: 'right',
              render: (row) => (can('products.manage') ? <Money value={row.variance_value} /> : '—')
            },
            { key: 'username', label: 'Started by' },
            { key: 'created_at', label: 'Started', render: (row) => formatDateTime(row.created_at) },
            { key: 'posted_at', label: 'Posted', render: (row) => (row.posted_at ? formatDateTime(row.posted_at) : '—') }
          ]}
        />
      </Card>

      {detail ? (
        <Card
          title={`Count ${detail.count.count_no} — ${detail.count.status}`}
          actions={
            isDraft ? (
              <div className="row tight">
                <Button size="sm" variant="ghost" onClick={saveProgress} disabled={busy}>
                  Save counted lines
                </Button>
                <Button size="sm" onClick={post} disabled={busy}>
                  Post count
                </Button>
              </div>
            ) : (
              <span className="tiny muted">Posted by {detail.count.posted_by ?? '—'}</span>
            )
          }
        >
          <div className="kpi-grid" style={{ marginBottom: 12 }}>
            <Kpi label="Lines counted" value={String(detail.totals.counted)} />
            <Kpi
              label="Variance quantity"
              value={String(liveVariance.qty)}
              hint="Positive means more stock than the system had"
            />
            {can('products.manage') ? (
              <Kpi label="Variance value (cost)" value={formatMoney(liveVariance.value)} hint="Quantity × cost price" />
            ) : null}
          </div>
          <DataTable<StockCountItemRow & { draft?: string }>
            rows={draftRows}
            empty="This count has no lines."
            columns={[
              { key: 'name', label: 'Item' },
              { key: 'sku', label: 'Code' },
              { key: 'system_qty', label: 'System', align: 'right' },
              {
                key: 'counted',
                label: 'Counted',
                align: 'right',
                render: (row) =>
                  isDraft ? (
                    <Input
                      type="number"
                      min={0}
                      value={row.draft ?? (row.counted_qty ?? '')}
                      onChange={(e) => setDrafts({ ...drafts, [row.id]: e.target.value })}
                      style={{ width: 90 }}
                      aria-label={`Counted quantity for ${row.name}`}
                    />
                  ) : (
                    String(row.counted_qty ?? '—')
                  )
              },
              {
                key: 'variance',
                label: 'Variance',
                align: 'right',
                render: (row) => {
                  const raw = row.draft;
                  const counted = raw === undefined || raw === '' ? row.counted_qty : Number(raw);
                  if (counted === null || counted === undefined) return '—';
                  const variance = counted - row.system_qty;
                  return (
                    <span style={{ color: variance === 0 ? undefined : variance < 0 ? '#b42318' : '#1e7a52' }}>
                      {variance > 0 ? `+${variance}` : variance}
                    </span>
                  );
                }
              },
              ...(can('products.manage')
                ? [
                    {
                      key: 'cost',
                      label: 'Cost',
                      align: 'right' as const,
                      render: (row: StockCountItemRow) => <Money value={row.cost_price} />
                    }
                  ]
                : [])
            ]}
          />
        </Card>
      ) : null}

      {!detail ? (
        <Card title="Start a count">
          <div className="row tight wrap" style={{ alignItems: 'flex-end' }}>
            <div className="grow">
              <Field label="Note" hint="Optional — e.g. “Month-end count, aisle 3”.">
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>
            <Button onClick={startCount} disabled={busy || !can('stock.adjust')}>
              Create count sheet
            </Button>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
