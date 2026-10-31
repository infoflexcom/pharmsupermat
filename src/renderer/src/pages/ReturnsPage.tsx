import { useCallback, useEffect, useState } from 'react';
import { ApiClientError, call } from '../api';
import { useApi, useApp } from '../state';
import type {
  ItemCondition,
  RefundMethod,
  ReturnReasonCode,
  ReturnType,
  ReturnableSale,
  SaleReturn,
  SaleSummary,
  SettingsPayload,
  StockWriteoff
} from '../../../shared/types';
import { RETURN_REASONS, RETURN_TYPES } from '../../../shared/types';
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

type Tab = 'new' | 'notes' | 'writeoffs';

interface LineState {
  saleItemId: number;
  name: string;
  soldQty: number;
  alreadyReturned: number;
  returnableQty: number;
  unitPrice: number;
  refundPerUnit: number;
  refundPerKg: number | null;
  isWeighed: boolean;
  batchNo: string | null;
  batchExpired: boolean;
  qty: number;
  resellable: boolean;
  condition: ItemCondition;
}

type Outcome = { value: SaleReturn; pending: boolean; message: string };
type Doc = { html: string; title: string };

const PAYMENT_LABEL: Record<RefundMethod, string> = {
  CASH: 'Cash',
  TRANSFER: 'Bank transfer',
  POS: 'Card / POS',
  STORE_CREDIT: 'Store credit'
};

const reasonLabel = (code: ReturnReasonCode): string =>
  RETURN_REASONS.find((r) => r.value === code)?.label ?? 'Other';

const typeLabel = (type: ReturnType): string => RETURN_TYPES.find((t) => t.value === type)?.label ?? 'Refund';

/** Weighed lines are priced per kilogram and returned in grams. */
const qtyLabel = (qty: number, isWeighed: boolean): string =>
  isWeighed ? `${(qty / 1000).toFixed(3)} kg` : String(qty);

function creditFor(line: LineState): number {
  if (line.qty <= 0) return 0;
  if (line.isWeighed) return Math.round((line.qty * (line.refundPerKg ?? 0)) / 1000);
  return line.qty * line.refundPerUnit;
}

export default function ReturnsPage() {
  const api = useApi();
  const { state, can, notify } = useApp();
  const pharmacy = Boolean(state?.features.pharmacy);

  const [tab, setTab] = useState<Tab>('new');
  const [settings, setSettings] = useState<SettingsPayload | null>(null);

  /* ---- receipt lookup ---- */
  const [receiptNo, setReceiptNo] = useState('');
  const [search, setSearch] = useState('');
  const [receipts, setReceipts] = useState<SaleSummary[]>([]);
  const [lookup, setLookup] = useState<ReturnableSale | null>(null);
  const [lines, setLines] = useState<LineState[]>([]);

  /* ---- return form ---- */
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode>('WRONG_ITEM');
  const [reasonNote, setReasonNote] = useState('');
  const [returnType, setReturnType] = useState<ReturnType>('REFUND');
  const [refundMethod, setRefundMethod] = useState<RefundMethod>('CASH');
  const [exchangeNote, setExchangeNote] = useState('');
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [approvedBy, setApprovedBy] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Outcome | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);

  /* ---- approvals ---- */
  const [approval, setApproval] = useState<{ purpose: 'RETURN' | 'RETURN_WINDOW'; reason: string } | null>(null);
  const [approver, setApprover] = useState({ username: '', password: '' });
  const [approving, setApproving] = useState(false);

  /* ---- registers ---- */
  const [returns, setReturns] = useState<SaleReturn[]>([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [writeoffs, setWriteoffs] = useState<StockWriteoff[]>([]);

  const loadSettings = useCallback(async () => {
    const data = await api<SettingsPayload>('settings.read');
    if (data) setSettings(data);
  }, [api]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const loadReceipts = useCallback(async () => {
    const data = await api<SaleSummary[]>('sales.list', { search: search || undefined, limit: 40 });
    if (data) setReceipts(data);
  }, [api, search]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadReceipts(), 200);
    return () => window.clearTimeout(timer);
  }, [loadReceipts]);

  const loadReturns = useCallback(async () => {
    const data = await api<SaleReturn[]>('returns.list', { from, to, status: statusFilter || undefined });
    if (data) setReturns(data);
  }, [api, from, to, statusFilter]);

  const loadWriteoffs = useCallback(async () => {
    const data = await api<StockWriteoff[]>('returns.writeoffs', { from, to });
    if (data) setWriteoffs(data);
  }, [api, from, to]);

  useEffect(() => {
    if (tab === 'notes') void loadReturns();
    if (tab === 'writeoffs') void loadWriteoffs();
  }, [tab, loadReturns, loadWriteoffs]);

  function applyLookup(found: ReturnableSale) {
    setLookup(found);
    setResult(null);
    setApprovalToken(null);
    setApprovedBy(null);
    setLines(
      found.items.map((item) => ({
        saleItemId: item.saleItemId,
        name: item.name,
        soldQty: item.qty,
        alreadyReturned: item.alreadyReturned,
        returnableQty: item.returnableQty,
        unitPrice: item.unitPrice,
        refundPerUnit: item.refundPerUnit,
        refundPerKg: item.refundPerKg,
        isWeighed: item.isWeighed,
        batchNo: item.batchNo,
        batchExpired: item.batchExpired,
        qty: 0,
        resellable: !item.batchExpired,
        condition: 'SEALED'
      }))
    );
  }

  async function findReceipt() {
    const value = receiptNo.trim();
    if (!value) return;
    try {
      const found = await call<ReturnableSale>('returns.lookup', { receiptNo: value });
      applyLookup(found);
      setReceiptNo('');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Receipt not found.', 'error');
    }
  }

  async function pickReceipt(row: SaleSummary) {
    try {
      const found = await call<ReturnableSale>('returns.lookup', { saleId: row.id });
      applyLookup(found);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Receipt could not be opened.', 'error');
    }
  }

  function changeReason(code: ReturnReasonCode) {
    setReasonCode(code);
    // Expired goods never go back on the shelf, whatever the line said.
    if (code === 'EXPIRED') {
      setLines((current) => current.map((line) => ({ ...line, resellable: false })));
    }
  }

  function updateLine(saleItemId: number, patch: Partial<LineState>) {
    setLines((current) => current.map((line) => (line.saleItemId === saleItemId ? { ...line, ...patch } : line)));
  }

  const total = lines.reduce((sum, line) => sum + creditFor(line), 0);
  const overLimit = Boolean(lookup && total > lookup.returnLimit);
  const needsApproval = overLimit && !lookup?.canApprove;
  const outsideWindow = Boolean(lookup && !lookup.withinWindow);
  const anySelected = lines.some((line) => line.qty > 0);

  async function submit(tokenOverride?: string) {
    if (!lookup) return;
    const selected = lines.filter((line) => line.qty > 0);
    if (selected.length === 0) {
      notify('Choose at least one item to return.', 'error');
      return;
    }
    setBusy(true);
    try {
      const outcome = await call<Outcome>('returns.create', {
        saleId: lookup.sale.id,
        reasonCode,
        reason: reasonNote.trim() || reasonLabel(reasonCode),
        returnType,
        refundMethod: returnType === 'REFUND' ? refundMethod : undefined,
        exchangeNote: returnType === 'EXCHANGE' ? exchangeNote : undefined,
        approvalToken: tokenOverride ?? approvalToken ?? undefined,
        lines: selected.map((line) => ({
          saleItemId: line.saleItemId,
          qty: line.qty,
          resellable: line.resellable,
          condition: line.condition,
          reasonCode
        }))
      });
      setResult(outcome);
      setLookup(null);
      setLines([]);
      setReasonNote('');
      setExchangeNote('');
      setApprovalToken(null);
      setApprovedBy(null);
      notify(outcome.message, outcome.pending ? 'info' : 'success');
      if (outcome.value.status === 'COMPLETED') {
        const preview = await api<{ html: string }>('returns.document', { id: outcome.value.id });
        if (preview) setDoc({ html: preview.html, title: 'Credit note' });
      }
      if (tab === 'notes') void loadReturns();
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'APPROVAL_REQUIRED') {
        setApproval({
          purpose: /window/i.test(error.message) ? 'RETURN_WINDOW' : 'RETURN',
          reason: error.message
        });
        setApprover({ username: '', password: '' });
      } else {
        notify(error instanceof Error ? error.message : 'Could not process the return.', 'error');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitApproval() {
    if (!approval) return;
    setApproving(true);
    try {
      const grant = await call<{ token: string; username: string }>('pos.approve', {
        purpose: approval.purpose,
        username: approver.username,
        password: approver.password,
        reason: approval.reason
      });
      setApprovalToken(grant.token);
      setApprovedBy(grant.username || approver.username);
      setApproval(null);
      notify(
        approval.purpose === 'RETURN_WINDOW'
          ? 'Return window override approved — finishing the return.'
          : 'Return approved — finishing the return.',
        'success'
      );
      // The token is single-use: submit straight away rather than making the
      // cashier press the button a second time.
      await submit(grant.token);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Approval failed.', 'error');
    } finally {
      setApproving(false);
    }
  }

  async function approveReturn(ret: SaleReturn) {
    try {
      const done = await call<SaleReturn>('returns.approve', { id: ret.id });
      notify(`Credit note ${done.creditNoteNo ?? ''} approved. Stock and loyalty updated.`, 'success');
      await loadReturns();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not approve.', 'error');
    }
  }

  async function rejectReturn(ret: SaleReturn) {
    const reasonText = window.prompt('Reason for rejecting this return?') ?? '';
    if (!reasonText.trim()) return;
    try {
      await call('returns.reject', { id: ret.id, reason: reasonText });
      notify('Return rejected. Nothing was restocked.', 'success');
      await loadReturns();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not reject.', 'error');
    }
  }

  async function viewDocument(ret: SaleReturn) {
    try {
      const preview = await api<{ html: string }>('returns.document', { id: ret.id });
      if (preview) setDoc({ html: preview.html, title: `Credit note ${ret.creditNoteNo ?? ''}` });
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not build the credit note.', 'error');
    }
  }

  async function printDocument(ret: SaleReturn) {
    try {
      const printed = await call<{ html: string; duplicate: boolean }>('returns.print', { id: ret.id });
      setDoc({ html: printed.html, title: `Credit note ${ret.creditNoteNo ?? ''}` });
      notify(printed.duplicate ? 'Reprinted as DUPLICATE.' : 'Credit note ready to print.', 'info');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not print the credit note.', 'error');
    }
  }

  const writeoffTotal = writeoffs.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="stack">
      <PageHead
        title="Returns & credit notes"
        subtitle={`Cashiers can return up to ${formatMoney(
          settings?.returnLimit ?? 0
        )} within ${settings?.returnWindowDays ?? 7} day(s) of the sale. Older returns need an administrator; larger ones a supervisor.`}
      />

      <div className="tabs">
        <button className={`tab ${tab === 'new' ? 'active' : ''}`} onClick={() => setTab('new')}>
          New return
        </button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Credit notes
        </button>
        <button className={`tab ${tab === 'writeoffs' ? 'active' : ''}`} onClick={() => setTab('writeoffs')}>
          Write-offs
        </button>
      </div>

      {tab === 'new' ? (
        <div className="stack">
          {!lookup ? (
            <Card title="Find the original receipt">
              <div className="row tight" style={{ alignItems: 'flex-end' }}>
                <Field label="Receipt number">
                  <Input
                    value={receiptNo}
                    onChange={(e) => setReceiptNo(e.target.value)}
                    placeholder="e.g. RCP-000042"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void findReceipt();
                    }}
                    autoFocus
                  />
                </Field>
                <Button onClick={() => void findReceipt()} disabled={!receiptNo.trim()}>
                  Open receipt
                </Button>
              </div>
              <div className="tiny muted" style={{ margin: '10px 0 0' }}>
                Or pick a recent receipt below — the customer’s slip is always the record of truth.
              </div>
              <div style={{ marginTop: 12 }}>
                <SearchBox
                  value={search}
                  onChange={setSearch}
                  placeholder="Search receipts by number, customer or cashier"
                />
              </div>
              <div style={{ marginTop: 12 }}>
                <DataTable
                  rows={receipts}
                  onRowClick={(row) => void pickReceipt(row)}
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
              title={`Return against ${lookup.sale.receiptNo}`}
              actions={
                <Button size="sm" variant="ghost" onClick={() => setLookup(null)}>
                  Change receipt
                </Button>
              }
            >
              <div className="small muted">
                {formatDateTime(lookup.sale.createdAt)} · {lookup.sale.customerName ?? 'Walk-in'} · sold{' '}
                {formatMoney(lookup.sale.total)} · {lookup.ageDays} day(s) old
              </div>

              <div className="row tight wrap" style={{ marginTop: 10 }}>
                <Badge tone="neutral">
                  Window: {lookup.windowDays} day{lookup.windowDays === 1 ? '' : 's'}
                </Badge>
                {lookup.withinWindow ? (
                  <Badge tone="success">Inside the window</Badge>
                ) : (
                  <Badge tone="warn">Outside the window — administrator override needed</Badge>
                )}
                <Badge tone={lookup.overLimit ? 'warn' : 'neutral'}>
                  Cashier limit {formatMoney(lookup.returnLimit)}
                </Badge>
                {lookup.loyaltyPointsReversedSoFar > 0 ? (
                  <Badge tone="gold">{lookup.loyaltyPointsReversedSoFar} loyalty point(s) already reversed</Badge>
                ) : null}
                {approvedBy ? <Badge tone="gold">Approved by {approvedBy}</Badge> : null}
              </div>

              <div style={{ marginTop: 12 }}>
                <DataTable
                  rows={lines}
                  columns={[
                    {
                      key: 'name',
                      label: 'Item',
                      render: (r) => (
                        <div className="stack" style={{ gap: 2 }}>
                          <span>{r.name}</span>
                          <span className="tiny muted">
                            {r.batchNo ? `Batch ${r.batchNo}` : 'No batch'}
                            {r.batchExpired ? ' · expired' : ''}
                            {r.returnableQty <= 0 ? ' · fully returned' : ''}
                          </span>
                        </div>
                      )
                    },
                    { key: 'soldQty', label: 'Sold', align: 'right', render: (r) => qtyLabel(r.soldQty, r.isWeighed) },
                    { key: 'alreadyReturned', label: 'Returned', align: 'right' },
                    { key: 'returnableQty', label: 'Returnable', align: 'right' },
                    {
                      key: 'unitPrice',
                      label: 'Price',
                      align: 'right',
                      render: (r) => (
                        <span>
                          <Money value={r.isWeighed ? (r.refundPerKg ?? 0) : r.unitPrice} />
                          {r.isWeighed ? <span className="tiny muted">/kg</span> : null}
                        </span>
                      )
                    },
                    {
                      key: 'qty',
                      label: 'Return qty',
                      align: 'right',
                      render: (r) => (
                        <input
                          type="number"
                          min={0}
                          max={r.returnableQty}
                          step={r.isWeighed ? 100 : 1}
                          value={r.qty}
                          disabled={r.returnableQty <= 0}
                          onChange={(e) =>
                            updateLine(r.saleItemId, {
                              qty: Math.max(0, Math.min(r.returnableQty, Number(e.target.value) || 0))
                            })
                          }
                          style={{ width: 90, textAlign: 'right' }}
                        />
                      )
                    },
                    {
                      key: 'resellable',
                      label: 'Back to stock',
                      align: 'right',
                      render: (r) => (
                        <input
                          type="checkbox"
                          checked={r.resellable}
                          disabled={r.returnableQty <= 0 || reasonCode === 'EXPIRED'}
                          onChange={(e) => updateLine(r.saleItemId, { resellable: e.target.checked })}
                        />
                      )
                    },
                    ...(pharmacy
                      ? [
                          {
                            key: 'condition',
                            label: 'Condition',
                            align: 'right' as const,
                            render: (r: LineState) => (
                              <Select
                                value={r.condition}
                                onChange={(e) =>
                                  updateLine(r.saleItemId, { condition: e.target.value as ItemCondition })
                                }
                              >
                                <option value="SEALED">Sealed</option>
                                <option value="OPENED">Opened</option>
                              </Select>
                            )
                          }
                        ]
                      : []),
                    {
                      key: 'credit',
                      label: 'Credit',
                      align: 'right',
                      render: (r) => <Money value={creditFor(r)} />
                    }
                  ]}
                  empty="No items on this receipt."
                />
              </div>

              <div className="form-grid" style={{ marginTop: 14 }}>
                <Field label="Return type">
                  <Select value={returnType} onChange={(e) => setReturnType(e.target.value as ReturnType)}>
                    {RETURN_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reason">
                  <Select value={reasonCode} onChange={(e) => changeReason(e.target.value as ReturnReasonCode)}>
                    {RETURN_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {returnType === 'REFUND' ? (
                  <Field label="Refund how">
                    <Select value={refundMethod} onChange={(e) => setRefundMethod(e.target.value as RefundMethod)}>
                      <option value="CASH">{PAYMENT_LABEL.CASH}</option>
                      <option value="TRANSFER">{PAYMENT_LABEL.TRANSFER}</option>
                      <option value="POS">{PAYMENT_LABEL.POS}</option>
                    </Select>
                  </Field>
                ) : null}
                {returnType === 'EXCHANGE' ? (
                  <Field label="Taken in exchange" hint="What the customer is leaving with.">
                    <Input
                      value={exchangeNote}
                      onChange={(e) => setExchangeNote(e.target.value)}
                      placeholder="e.g. Amoxil 250mg x1"
                    />
                  </Field>
                ) : null}
                <Field label="Note" hint="Optional detail kept on the credit note.">
                  <Input
                    value={reasonNote}
                    onChange={(e) => setReasonNote(e.target.value)}
                    placeholder="e.g. Wrong strength dispensed"
                  />
                </Field>
                <Field label="Total credit">
                  <Input value={formatMoney(total)} readOnly style={{ fontWeight: 700 }} />
                </Field>
              </div>

              {returnType === 'STORE_CREDIT' ? (
                <div style={{ marginTop: 10 }}>
                  <Alert tone="info">Store credit is recorded against this credit note — no cash leaves the till.</Alert>
                </div>
              ) : null}

              {outsideWindow ? (
                <div style={{ marginTop: 10 }}>
                  <Alert tone="warn">
                    This receipt is {lookup.ageDays} day(s) old and the return window is {lookup.windowDays} day(s). An
                    administrator must approve the override before the return can be saved.
                  </Alert>
                </div>
              ) : null}

              {needsApproval ? (
                <div style={{ marginTop: 10 }}>
                  <Alert tone="warn">
                    {formatMoney(total)} is above the {formatMoney(lookup.returnLimit)} cashier limit. A supervisor or
                    administrator must approve this return. Without approval it waits in the credit notes list.
                  </Alert>
                </div>
              ) : null}

              <div className="row tight" style={{ marginTop: 16 }}>
                <Button onClick={() => void submit()} disabled={busy || !anySelected}>
                  {busy ? 'Processing…' : can('returns.approve') ? 'Complete return' : 'Save return'}
                </Button>
                {(outsideWindow || needsApproval) && !approvalToken ? (
                  <Button
                    variant="gold"
                    onClick={() =>
                      setApproval({
                        purpose: outsideWindow ? 'RETURN_WINDOW' : 'RETURN',
                        reason: outsideWindow
                          ? 'Return outside the return window.'
                          : 'Return above the cashier limit.'
                      })
                    }
                  >
                    Enter approval PIN
                  </Button>
                ) : null}
                <Button variant="ghost" onClick={() => setLookup(null)}>
                  Cancel
                </Button>
              </div>
            </Card>
          )}

          {result ? (
            <Card
              title={result.pending ? 'Return waiting for approval' : 'Credit note issued'}
              actions={
                result.value.status === 'COMPLETED' ? (
                  <Button size="sm" variant="ghost" onClick={() => void printDocument(result.value)}>
                    Print credit note
                  </Button>
                ) : null
              }
            >
              <Alert tone={result.pending ? 'warn' : 'success'}>{result.message}</Alert>
              <div className="small muted" style={{ marginTop: 8 }}>
                {result.value.creditNoteNo ? `${result.value.creditNoteNo} · ` : ''}
                {typeLabel(result.value.returnType)} · {reasonLabel(result.value.reasonCode)} ·{' '}
                {formatMoney(result.value.total)}
              </div>
              {result.value.discountReversed || result.value.promoReversed || result.value.loyaltyPointsReversed ? (
                <div className="small muted" style={{ marginTop: 4 }}>
                  {result.value.discountReversed
                    ? `Discounts reversed ${formatMoney(result.value.discountReversed)} · `
                    : ''}
                  {result.value.promoReversed ? `Promotion reversed ${formatMoney(result.value.promoReversed)} · ` : ''}
                  {result.value.loyaltyPointsReversed
                    ? `${result.value.loyaltyPointsReversed} loyalty point(s) taken back`
                    : ''}
                </div>
              ) : null}
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === 'notes' ? (
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
                {
                  key: 'type',
                  label: 'Type',
                  render: (r) => (
                    <div className="stack" style={{ gap: 2 }}>
                      <span>{typeLabel(r.returnType)}</span>
                      <span className="tiny muted">
                        {reasonLabel(r.reasonCode)}
                        {r.windowOverride ? ' · window override' : ''}
                      </span>
                    </div>
                  )
                },
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
                      <Button size="sm" variant="ghost" onClick={() => void viewDocument(r)}>
                        View
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void printDocument(r)}>
                        Print
                      </Button>
                      {r.status === 'PENDING' && can('returns.approve') ? (
                        <>
                          <Button size="sm" onClick={() => void approveReturn(r)}>
                            Approve
                          </Button>
                          <Button size="sm" variant="danger" onClick={() => void rejectReturn(r)}>
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
      ) : null}

      {tab === 'writeoffs' ? (
        <div className="stack">
          <Card>
            <div className="form-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))' }}>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field label="Total written off">
                <Input value={formatMoney(writeoffTotal)} readOnly style={{ fontWeight: 700 }} />
              </Field>
              <Field label="&nbsp;">
                <Button variant="ghost" onClick={() => void loadWriteoffs()}>
                  Refresh
                </Button>
              </Field>
            </div>
          </Card>

          <Card title={`${writeoffs.length} written-off line(s)`}>
            <DataTable
              rows={writeoffs}
              columns={[
                { key: 'createdAt', label: 'Date', render: (r) => formatDateTime(r.createdAt) },
                { key: 'productName', label: 'Product', render: (r) => r.productName ?? `#${r.productId}` },
                { key: 'batchNo', label: 'Batch', render: (r) => r.batchNo ?? '—' },
                { key: 'qty', label: 'Qty', align: 'right' },
                { key: 'costPrice', label: 'Cost', align: 'right', render: (r) => <Money value={r.costPrice} /> },
                { key: 'value', label: 'Value', align: 'right', render: (r) => <Money value={r.value} /> },
                { key: 'reasonCode', label: 'Reason', render: (r) => reasonLabel(r.reasonCode) },
                { key: 'username', label: 'By', render: (r) => r.username ?? '—' }
              ]}
              empty="Nothing has been written off in this period."
            />
          </Card>
        </div>
      ) : null}

      {approval ? (
        <Modal
          title={approval.purpose === 'RETURN_WINDOW' ? 'Administrator override' : 'Supervisor approval needed'}
          size="sm"
          onClose={() => setApproval(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setApproval(null)}>
                Cancel
              </Button>
              <Button
                variant="gold"
                onClick={() => void submitApproval()}
                disabled={approving || !approver.username || !approver.password}
              >
                {approving ? 'Checking…' : 'Approve'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="warn">{approval.reason}</Alert>
            <div className="tiny muted">
              {approval.purpose === 'RETURN_WINDOW'
                ? 'Only an administrator can extend the return window for this sale.'
                : 'A supervisor or administrator can approve a return above the cashier limit.'}
            </div>
            <Field label="Approver username">
              <Input
                value={approver.username}
                onChange={(e) => setApprover({ ...approver, username: e.target.value })}
                autoFocus
              />
            </Field>
            <Field label="Password or PIN">
              <Input
                type="password"
                value={approver.password}
                onChange={(e) => setApprover({ ...approver, password: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {doc ? (
        <Modal title={doc.title} size="wide" onClose={() => setDoc(null)}>
          <DocumentView html={doc.html} filename="credit-note.html" title={doc.title} />
        </Modal>
      ) : null}
    </div>
  );
}
