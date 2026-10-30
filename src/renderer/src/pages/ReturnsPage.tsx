import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Sale, SaleReturn, SaleSummary, SettingsPayload } from '../../../shared/types';
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
  Modal,
  Money,
  PageHead,
  SearchBox,
  Select,
  todayInput
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';

interface LineState {
  saleItemId: number;
  name: string;
  soldQty: number;
  alreadyReturned: number;
  unitPrice: number;
  qty: number;
}

export default function ReturnsPage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [tab, setTab] = useState<'new' | 'list'>('new');
  const [search, setSearch] = useState('');
  const [receipts, setReceipts] = useState<SaleSummary[]>([]);
  const [sale, setSale] = useState<Sale | null>(null);
  const [lines, setLines] = useState<LineState[]>([]);
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ value: SaleReturn; pending: boolean; message: string } | null>(null);
  const [doc, setDoc] = useState<{ html: string } | null>(null);
  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [settings, setSettings] = useState<SettingsPayload | null>(null);

  const loadReceipts = useCallback(async () => {
    const data = await api<SaleSummary[]>('sales.list', { search: search || undefined, limit: 40 });
    if (data) setReceipts(data);
  }, [api, search]);

  const loadReturns = useCallback(async () => {
    const data = await api<SaleReturn[]>('returns.list', {
      from,
      to,
      status: statusFilter || undefined
    });
    if (data) setReturns(data);
  }, [api, from, to, statusFilter]);

  useEffect(() => {
    void (async () => {
      const data = await api<SettingsPayload>('settings.read');
      if (data) setSettings(data);
    })();
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReceipts(), 200);
    return () => window.clearTimeout(timer);
  }, [loadReceipts]);

  useEffect(() => {
    if (tab === 'list') void loadReturns();
  }, [tab, loadReturns]);

  async function pickSale(row: SaleSummary) {
    const full = await api<Sale>('sales.get', { id: row.id });
    if (!full) return;
    setSale(full);
    setResult(null);
    setDoc(null);
    // Already-returned quantities come from the server on submit; the UI caps at sold qty.
    const all = await api<SaleReturn[]>('returns.list', { limit: 200 });
    const returned = new Map<number, number>();
    for (const ret of all ?? []) {
      if (ret.status === 'REJECTED') continue;
      for (const item of ret.items ?? []) {
        returned.set(item.saleItemId, (returned.get(item.saleItemId) ?? 0) + item.qty);
      }
    }
    setLines(
      (full.items ?? []).map((item) => ({
        saleItemId: item.id,
        name: item.name,
        soldQty: item.qty,
        alreadyReturned: returned.get(item.id) ?? 0,
        unitPrice: item.unitPrice,
        qty: 0
      }))
    );
    setReason('');
  }

  const total = lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0);
  // Hint only — the server re-checks the limit and the return window on submit.
  const overLimit = settings ? total > settings.returnLimit : false;

  async function submit() {
    if (!sale) return;
    setBusy(true);
    try {
      const payload = {
        saleId: sale.id,
        reason,
        restock,
        lines: lines
          .filter((line) => line.qty > 0)
          .map((line) => ({ saleItemId: line.saleItemId, qty: line.qty, restock }))
      };
      const outcome = await call<{ value: SaleReturn; pending: boolean; message: string }>(
        'returns.create',
        payload
      );
      setResult(outcome);
      setSale(null);
      setLines([]);
      if (outcome.value.status === 'COMPLETED') {
        const document = await call<{ html: string }>('returns.document', { id: outcome.value.id });
        setDoc(document);
      }
      notify(outcome.message, outcome.pending ? 'info' : 'success');
      void loadReturns();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not process the return.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function approve(ret: SaleReturn) {
    try {
      await call('returns.approve', { id: ret.id });
      notify(`Credit note ${ret.creditNoteNo ?? ''} approved and stock restored.`, 'success');
      await loadReturns();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not approve.', 'error');
    }
  }

  async function reject(ret: SaleReturn) {
    const reasonText = window.prompt('Reason for rejecting this return?') ?? '';
    if (!reasonText.trim()) return;
    try {
      await call('returns.reject', { id: ret.id, reason: reasonText });
      notify('Return rejected.', 'success');
      await loadReturns();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not reject.', 'error');
    }
  }

  async function openDocument(ret: SaleReturn) {
    const document = await api<{ html: string }>('returns.document', { id: ret.id });
    if (document) setDoc(document);
  }

  return (
    <div className="stack">
      <PageHead
        title="Returns & credit notes"
        subtitle={`Cashiers can return up to ${formatMoney(
          settings?.returnLimit ?? 0
        )} within ${settings?.returnWindowDays ?? 7} day(s); larger or older returns need supervisor approval.`}
      />

      <div className="tabs">
        <button className={`tab ${tab === 'new' ? 'active' : ''}`} onClick={() => setTab('new')}>
          New return
        </button>
        <button className={`tab ${tab === 'list' ? 'active' : ''}`} onClick={() => setTab('list')}>
          Credit notes
        </button>
      </div>

      {tab === 'new' ? (
        <div className="stack">
          {!sale ? (
            <Card title="Find the original receipt">
              <SearchBox value={search} onChange={setSearch} placeholder="Receipt number, customer or cashier" autoFocus />
              <div style={{ marginTop: 12 }}>
                <DataTable
                  rows={receipts}
                  onRowClick={(row) => void pickSale(row)}
                  columns={[
                    { key: 'receiptNo', label: 'Receipt' },
                    { key: 'createdAt', label: 'Date', render: (r) => formatDateTime(r.createdAt) },
                    { key: 'customerName', label: 'Customer', render: (r) => r.customerName ?? 'Walk-in' },
                    { key: 'itemsCount', label: 'Items', align: 'right' },
                    { key: 'total', label: 'Total', align: 'right', render: (r) => <Money value={r.total} /> },
                    {
                      key: 'status',
                      label: '',
                      render: (r) => (r.status === 'VOIDED' ? <Badge tone="danger">Voided</Badge> : null)
                    }
                  ]}
                  empty="No receipts match that search."
                />
              </div>
            </Card>
          ) : (
            <Card
              title={`Return against ${sale.receiptNo}`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => setSale(null)}>
                  Change receipt
                </Button>
              }
            >
              <div className="small muted">
                {formatDateTime(sale.createdAt)} · {sale.customerName ?? 'Walk-in'} · total{' '}
                {formatMoney(sale.total)}
              </div>
              <div style={{ marginTop: 12 }}>
                <DataTable
                  rows={lines}
                  columns={[
                    { key: 'name', label: 'Item' },
                    { key: 'soldQty', label: 'Sold', align: 'right' },
                    {
                      key: 'alreadyReturned',
                      label: 'Returned',
                      align: 'right',
                      render: (r) => r.alreadyReturned
                    },
                    { key: 'unitPrice', label: 'Unit', align: 'right', render: (r) => <Money value={r.unitPrice} /> },
                    {
                      key: 'qty',
                      label: 'Return qty',
                      align: 'right',
                      render: (r) => {
                        const max = r.soldQty - r.alreadyReturned;
                        return (
                          <input
                            type="number"
                            min={0}
                            max={max}
                            value={r.qty}
                            disabled={max <= 0}
                            onChange={(e) =>
                              setLines((current) =>
                                current.map((line) =>
                                  line.saleItemId === r.saleItemId
                                    ? {
                                        ...line,
                                        qty: Math.max(0, Math.min(max, Number(e.target.value) || 0))
                                      }
                                    : line
                                )
                              )
                            }
                            style={{ width: 80, textAlign: 'right' }}
                          />
                        );
                      }
                    },
                    {
                      key: 'amount',
                      label: 'Credit',
                      align: 'right',
                      render: (r) => <Money value={r.qty * r.unitPrice} />
                    }
                  ]}
                  empty="No items on this receipt."
                />
              </div>

              <div className="form-grid" style={{ marginTop: 14 }}>
                <Field label="Reason for return">
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Wrong item dispensed"
                  />
                </Field>
                <Field label="Restock">
                  <Select value={restock ? 'yes' : 'no'} onChange={(e) => setRestock(e.target.value === 'yes')}>
                    <option value="yes">Put goods back in stock</option>
                    <option value="no">Do not restock (damaged / expired)</option>
                  </Select>
                </Field>
                <Field label="Total credit">
                  <Input value={formatMoney(total)} readOnly style={{ fontWeight: 700 }} />
                </Field>
              </div>

              {overLimit && !can('returns.approve') ? (
                <div style={{ marginTop: 12 }}>
                  <Alert tone="warn">
                    This return is above the cashier limit. It will be sent to a supervisor for approval.
                  </Alert>
                </div>
              ) : null}

              <div className="row tight" style={{ marginTop: 16 }}>
                <Button onClick={submit} disabled={busy || total <= 0 || reason.trim().length < 3}>
                  {busy ? 'Processing…' : can('returns.approve') ? 'Complete return' : 'Submit return'}
                </Button>
                <Button variant="ghost" onClick={() => setSale(null)}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}

          {result ? (
            <Card title={result.pending ? 'Return submitted for approval' : 'Credit note issued'}>
              <Alert tone={result.pending ? 'warn' : 'success'}>{result.message}</Alert>
              <div className="small muted" style={{ marginTop: 8 }}>
                Total credited: {formatMoney(result.value.total)} ·{' '}
                {result.value.items?.length ?? 0} line(s)
              </div>
            </Card>
          ) : null}

          {doc ? (
            <Card title="Credit note preview">
              <DocumentView html={doc.html} filename={`credit-note-${result?.value.id ?? 'new'}.html`} title="Credit note" />
            </Card>
          ) : null}
        </div>
      ) : (
        <div className="stack">
          <Card>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="Status">
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                  <option value="">All</option>
                  <option value="PENDING">Pending approval</option>
                  <option value="COMPLETED">Completed</option>
                  <option value="REJECTED">Rejected</option>
                </Select>
              </Field>
              <Field label="&nbsp;">
                <Button variant="ghost" onClick={() => void loadReturns()}>
                  Refresh
                </Button>
              </Field>
            </div>
          </Card>

          <Card title={`${returns.length} credit note(s)`}>
            <DataTable
              rows={returns}
              columns={[
                {
                  key: 'creditNoteNo',
                  label: 'Credit note',
                  render: (r) => r.creditNoteNo ?? <Badge tone="warn">Pending</Badge>
                },
                { key: 'saleReceiptNo', label: 'Receipt' },
                { key: 'requestedAt', label: 'Date', render: (r) => formatDateTime(r.requestedAt) },
                { key: 'customerName', label: 'Customer', render: (r) => r.customerName ?? 'Walk-in' },
                { key: 'reason', label: 'Reason' },
                { key: 'requestedByName', label: 'By' },
                {
                  key: 'status',
                  label: 'Status',
                  render: (r) =>
                    r.status === 'COMPLETED' ? (
                      <Badge tone="success">Completed</Badge>
                    ) : r.status === 'PENDING' ? (
                      <Badge tone="warn">Pending</Badge>
                    ) : (
                      <Badge tone="danger">Rejected</Badge>
                    )
                },
                { key: 'total', label: 'Credit', align: 'right', render: (r) => <Money value={r.total} /> },
                {
                  key: 'actions',
                  label: '',
                  align: 'right',
                  render: (r) => (
                    <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                      <Button size="sm" variant="ghost" onClick={() => void openDocument(r)}>
                        View
                      </Button>
                      {r.status === 'PENDING' && can('returns.approve') ? (
                        <>
                          <Button size="sm" onClick={() => void approve(r)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void reject(r)}>
                            Reject
                          </Button>
                        </>
                      ) : null}
                    </div>
                  )
                }
              ]}
              empty="No returns for this period."
            />
          </Card>
        </div>
      )}

      {doc ? (
        <Modal title="Credit note" size="wide" onClose={() => setDoc(null)}>
          <DocumentView html={doc.html} filename={`credit-note.html`} title="Credit note" />
        </Modal>
      ) : null}
    </div>
  );
}
