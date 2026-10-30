import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Batch, Product, StockMoveType } from '../../../shared/types';
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
  Modal,
  Money,
  PageHead,
  SearchBox
} from '../components/ui';

interface InventoryItem extends Product {
  batches: Batch[];
}

interface Alerts {
  lowStock: Product[];
  expiring: { productId: number; sku: string; name: string; batchNo: string; expiryDate: string; daysLeft: number; qty: number }[];
  outOfStock: Product[];
}

interface LedgerRow {
  id: number;
  createdAt: string;
  type: StockMoveType;
  qtyChange: number;
  note: string | null;
  reference: string | null;
}

export default function InventoryPage() {
  const api = useApi();
  const { state, can, notify } = useApp();
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [loading, setLoading] = useState(true);
  const [adjustFor, setAdjustFor] = useState<InventoryItem | null>(null);
  const [adjustBatch, setAdjustBatch] = useState<number | ''>('');
  const [adjustQty, setAdjustQty] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [ledgerFor, setLedgerFor] = useState<InventoryItem | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const pharmacy = Boolean(state?.features.pharmacy);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api<InventoryItem[]>('inventory.list', { search: search || undefined });
    if (data) setItems(data);
    setLoading(false);
  }, [api, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    void (async () => {
      const data = await api<Alerts>('stock.alerts');
      if (data) setAlerts(data);
    })();
  }, [api]);

  async function openAdjust(item: InventoryItem) {
    setAdjustFor(item);
    setAdjustBatch(item.batches[0]?.id ?? '');
    const batch = item.batches[0];
    setAdjustQty(String(batch?.qty ?? 0));
    setAdjustReason('');
  }

  async function submitAdjust() {
    if (!adjustFor) return;
    try {
      await call('stock.adjust', {
        productId: adjustFor.id,
        batchId: adjustBatch === '' ? undefined : adjustBatch,
        newQty: Number(adjustQty),
        reason: adjustReason
      });
      notify('Stock adjusted and logged.', 'success');
      setAdjustFor(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not adjust stock.', 'error');
    }
  }

  async function openLedger(item: InventoryItem) {
    setLedgerFor(item);
    const data = await api<LedgerRow[]>('stock.ledger', { productId: item.id, limit: 100 });
    setLedger(data ?? []);
  }

  const totalValue = items.reduce((sum, item) => sum + item.stockQty * item.costPrice, 0);

  return (
    <div className="stack">
      <PageHead
        title="Inventory"
        subtitle={
          pharmacy
            ? 'Batch and expiry tracking with first-expiry-first-out selling. Expired batches are never sold.'
            : 'Live stock levels with a full movement ledger for every change.'
        }
      />

      <div className="kpi-grid">
        <Kpi label="Products tracked" value={String(items.length)} hint={loading ? 'Loading…' : 'Active catalogue'} />
        <Kpi label="Stock value (cost)" value={formatMoney(totalValue)} hint="Quantity × cost price" />
        <Kpi label="Low stock" value={String(alerts?.lowStock.length ?? 0)} hint="At or below reorder level" />
        <Kpi
          label={pharmacy ? 'Expiring (90 days)' : 'Out of stock'}
          value={String(pharmacy ? alerts?.expiring.length ?? 0 : alerts?.outOfStock.length ?? 0)}
          hint={pharmacy ? 'Batches needing attention' : 'Nothing to sell'}
        />
      </div>

      {alerts && alerts.lowStock.length > 0 ? (
        <Alert tone="warn">
          {alerts.lowStock.length} item(s) are at or below their reorder level:{' '}
          {alerts.lowStock.slice(0, 6).map((p) => p.name).join(', ')}
          {alerts.lowStock.length > 6 ? '…' : ''}
        </Alert>
      ) : null}

      {pharmacy && alerts && alerts.expiring.filter((e) => e.daysLeft < 0).length > 0 ? (
        <Alert tone="error">
          {alerts.expiring.filter((e) => e.daysLeft < 0).length} expired batch(es) still in stock — quarantine
          them or adjust the stock to zero.
        </Alert>
      ) : null}

      <Card>
        <div className="row tight">
          <div className="grow">
            <SearchBox value={search} onChange={setSearch} placeholder="Search inventory" />
          </div>
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card title="Stock on hand">
        <DataTable
          rows={items}
          columns={[
            { key: 'name', label: 'Item' },
            { key: 'sku', label: 'Code' },
            { key: 'stockQty', label: 'Qty', align: 'right' },
            { key: 'reorderLevel', label: 'Reorder', align: 'right' },
            ...(pharmacy
              ? [
                  {
                    key: 'batches',
                    label: 'Batches (expiry)',
                    render: (r: InventoryItem) =>
                      r.batches.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="row tight wrap">
                          {r.batches.map((b) => (
                            <Badge
                              key={b.id}
                              tone={
                                b.expiryDate && new Date(b.expiryDate) < new Date()
                                  ? 'danger'
                                  : b.expiryDate &&
                                      new Date(b.expiryDate).getTime() - Date.now() < 90 * 86400000
                                    ? 'warn'
                                    : 'neutral'
                              }
                            >
                              {b.batchNo} · {b.qty}
                              {b.expiryDate ? ` · ${b.expiryDate.slice(0, 7)}` : ''}
                            </Badge>
                          ))}
                        </div>
                      )
                  }
                ]
              : []),
            {
              key: 'value',
              label: 'Stock value',
              align: 'right',
              render: (r) => <Money value={r.stockQty * r.costPrice} />
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (r) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  <Button size="sm" variant="ghost" onClick={() => void openLedger(r)}>
                    Ledger
                  </Button>
                  {can('stock.adjust') ? (
                    <Button size="sm" variant="ghost" onClick={() => void openAdjust(r)}>
                      Adjust
                    </Button>
                  ) : null}
                </div>
              )
            }
          ]}
          empty={loading ? 'Loading…' : 'No stock records yet.'}
        />
      </Card>

      {adjustFor ? (
        <Modal
          title={`Adjust stock — ${adjustFor.name}`}
          size="sm"
          onClose={() => setAdjustFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdjustFor(null)}>
                Cancel
              </Button>
              <Button onClick={submitAdjust} disabled={adjustReason.trim().length < 3}>
                Save adjustment
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="warn">Stock counts are audited with your name and the reason given.</Alert>
            <Field label="Batch">
              <select
                value={adjustBatch}
                onChange={(e) => {
                  const value = e.target.value === '' ? '' : Number(e.target.value);
                  setAdjustBatch(value);
                  const batch = adjustFor.batches.find((b) => b.id === value);
                  if (batch) setAdjustQty(String(batch.qty));
                }}
              >
                {adjustFor.batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {batch.batchNo} {batch.expiryDate ? `· exp ${batch.expiryDate}` : ''} · {batch.qty} in stock
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Counted quantity">
              <Input type="number" min={0} value={adjustQty} onChange={(e) => setAdjustQty(e.target.value)} />
            </Field>
            <Field label="Reason">
              <Input
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="e.g. Stock count variance"
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {ledgerFor ? (
        <Modal title={`Stock ledger — ${ledgerFor.name}`} size="wide" onClose={() => setLedgerFor(null)}>
          <DataTable
            rows={ledger}
            columns={[
              { key: 'createdAt', label: 'When', render: (r) => formatDateTime(r.createdAt) },
              { key: 'type', label: 'Type' },
              {
                key: 'qtyChange',
                label: 'Change',
                align: 'right',
                render: (r) => (
                  <span style={{ color: r.qtyChange < 0 ? '#b42318' : '#1e7a52', fontWeight: 600 }}>
                    {r.qtyChange > 0 ? '+' : ''}
                    {r.qtyChange}
                  </span>
                )
              },
              { key: 'reference', label: 'Reference', render: (r) => r.reference ?? '—' },
              { key: 'note', label: 'Note', render: (r) => r.note ?? '—' }
            ]}
            empty="No stock movements recorded."
          />
        </Modal>
      ) : null}
    </div>
  );
}
