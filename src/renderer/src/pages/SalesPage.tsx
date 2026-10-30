import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Sale, SaleSummary } from '../../../shared/types';
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
  todayInput,
  daysAgoInput
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';
import { formatMoney } from '../../../shared/money';

export default function SalesPage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [pendingOnly, setPendingOnly] = useState(false);
  const [rows, setRows] = useState<SaleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Sale | null>(null);
  const [document, setDocument] = useState<{ html: string } | null>(null);
  const [voidTarget, setVoidTarget] = useState<Sale | null>(null);
  const [voidReason, setVoidReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api<SaleSummary[]>('sales.list', {
      from,
      to,
      search: search || undefined,
      status: status || undefined,
      pendingVoids: pendingOnly || undefined,
      limit: 300
    });
    if (data) setRows(data);
    setLoading(false);
  }, [api, from, to, search, status, pendingOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openSale(id: number) {
    const sale = await api<Sale>('sales.get', { id });
    if (!sale) return;
    setSelected(sale);
    setDocument(null);
    const doc = await api<{ html: string }>('sales.document', { id });
    if (doc) setDocument(doc);
  }

  async function submitVoid() {
    if (!voidTarget) return;
    try {
      const result = await call<{ sale: Sale; applied: boolean }>('sales.void', {
        id: voidTarget.id,
        reason: voidReason
      });
      notify(
        result.applied
          ? `Sale ${result.sale.receiptNo} voided and stock restored.`
          : `Void request for ${result.sale.receiptNo} sent for approval.`,
        'success'
      );
      setVoidTarget(null);
      setVoidReason('');
      setSelected(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not void the sale.', 'error');
    }
  }

  async function decideVoid(sale: Sale, approve: boolean) {
    try {
      await call(approve ? 'sales.approveVoid' : 'sales.rejectVoid', { id: sale.id });
      notify(`Void ${approve ? 'approved' : 'rejected'} for ${sale.receiptNo}.`, 'success');
      setSelected(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Action failed.', 'error');
    }
  }

  const totals = rows.filter((r) => r.status === 'COMPLETED').reduce((sum, r) => sum + r.total, 0);

  return (
    <div className="stack">
      <PageHead
        title="Sales & receipts"
        subtitle="Every completed sale, with reprintable receipts and a full void trail. Completed sales are never deleted."
        actions={
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        }
      />

      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(5, minmax(0,1fr))' }}>
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="Search">
            <SearchBox value={search} onChange={setSearch} placeholder="Receipt, customer, cashier" />
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="COMPLETED">Completed</option>
              <option value="VOIDED">Voided</option>
            </Select>
          </Field>
          <Field label="Quick range">
            <Select
              value=""
              onChange={(e) => {
                const value = e.target.value;
                if (value === 'today') {
                  setFrom(todayInput());
                  setTo(todayInput());
                }
                if (value === 'week') {
                  setFrom(daysAgoInput(6));
                  setTo(todayInput());
                }
                if (value === 'month') {
                  setFrom(daysAgoInput(29));
                  setTo(todayInput());
                }
              }}
            >
              <option value="">Choose…</option>
              <option value="today">Today</option>
              <option value="week">Last 7 days</option>
              <option value="month">Last 30 days</option>
            </Select>
          </Field>
        </div>
        {can('sales.void.approve') ? (
          <label className="row tight small" style={{ marginTop: 10 }}>
            <input
              type="checkbox"
              checked={pendingOnly}
              onChange={(e) => setPendingOnly(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Show only void requests waiting for approval
          </label>
        ) : null}
      </Card>

      <Card
        title={`${rows.length} sale(s) · ${formatMoney(totals)} completed`}
        actions={<Badge tone="neutral">{loading ? 'Loading' : 'Live'}</Badge>}
      >
        <DataTable
          rows={rows}
          onRowClick={(row) => void openSale(row.id)}
          columns={[
            { key: 'receiptNo', label: 'Document' },
            { key: 'createdAt', label: 'Date', render: (r) => formatDateTime(r.createdAt) },
            { key: 'docType', label: 'Type', render: (r) => (r.docType === 'INVOICE' ? 'Invoice' : 'Receipt') },
            { key: 'customerName', label: 'Customer', render: (r) => r.customerName ?? 'Walk-in' },
            { key: 'itemsCount', label: 'Items', align: 'right' },
            { key: 'username', label: 'Cashier' },
            {
              key: 'status',
              label: 'Status',
              render: (r) =>
                r.status === 'VOIDED' ? (
                  <Badge tone="danger">Voided</Badge>
                ) : r.voidRequestedAt ? (
                  <Badge tone="warn">Void pending</Badge>
                ) : (
                  <Badge tone="ok">Completed</Badge>
                )
            },
            { key: 'total', label: 'Total', align: 'right', render: (r) => <Money value={r.total} /> }
          ]}
          empty={loading ? 'Loading…' : 'No sales for this period.'}
        />
      </Card>

      {selected ? (
        <Modal title={`${selected.docType === 'INVOICE' ? 'Invoice' : 'Receipt'} ${selected.receiptNo}`} size="wide" onClose={() => setSelected(null)}>
          <div className="row between" style={{ marginBottom: 12 }}>
            <div>
              <div className="muted small">{formatDateTime(selected.createdAt)} · served by {selected.username}</div>
              <div className="muted small">
                {selected.storeName} · {selected.storeAddress} {selected.storePhone ? `· ${selected.storePhone}` : ''}
              </div>
            </div>
            <div className="row tight">
              {selected.status === 'VOIDED' ? <Badge tone="danger">Voided</Badge> : null}
              {selected.voidRequestedAt ? <Badge tone="warn">Void pending</Badge> : null}
            </div>
          </div>

          {selected.status === 'COMPLETED' && !selected.voidRequestedAt ? (
            <div className="row tight" style={{ marginBottom: 12 }}>
              <Button size="sm" variant="ghost" onClick={() => setVoidTarget(selected)}>
                Request void
              </Button>
            </div>
          ) : null}

          {selected.voidRequestedAt && can('sales.void.approve') ? (
            <Alert tone="warn">
              <div className="grow">
                <strong>Void requested</strong> — {selected.voidReason}
                <div className="small">Approve to restore stock and mark this document void.</div>
              </div>
              <div className="row tight">
                <Button size="sm" onClick={() => void decideVoid(selected, true)}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void decideVoid(selected, false)}>
                  Reject
                </Button>
              </div>
            </Alert>
          ) : null}

          {selected.voidReason && selected.status === 'COMPLETED' ? (
            <Alert tone="warn">Void reason: {selected.voidReason}</Alert>
          ) : null}

          {document ? (
            <div style={{ marginTop: 14 }}>
              <DocumentView
                html={document.html}
                filename={`${selected.receiptNo}.html`}
                title={`${selected.docType} ${selected.receiptNo}`}
              />
            </div>
          ) : null}
        </Modal>
      ) : null}

      {voidTarget ? (
        <Modal
          title={`Void ${voidTarget.receiptNo}?`}
          size="sm"
          onClose={() => setVoidTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setVoidTarget(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={submitVoid} disabled={voidReason.trim().length < 3}>
                {can('sales.void.approve') ? 'Void sale' : 'Send for approval'}
              </Button>
            </>
          }
        >
          <Alert tone="warn">
            The sale is kept on record and marked void; stock is returned to its batch. This is logged in
            the audit trail.
          </Alert>
          <div style={{ marginTop: 12 }}>
            <Field label="Reason" hint="At least 3 characters.">
              <Input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} autoFocus />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
