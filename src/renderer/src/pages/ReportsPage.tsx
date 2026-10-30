import { useState } from 'react';
import { useApi, useApp } from '../state';
import type { ReportKind, ReportResult } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  PageHead,
  Select,
  daysAgoInput,
  todayInput
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';

const REPORTS: { kind: ReportKind; label: string; description: string }[] = [
  { kind: 'SALES_SUMMARY', label: 'Sales summary', description: 'Daily totals, payment split and cashier performance.' },
  { kind: 'PRODUCT_SALES', label: 'Product sales', description: 'Units sold, revenue and profit per product.' },
  { kind: 'STOCK_VALUATION', label: 'Stock valuation', description: 'Current stock at cost and retail value.' },
  { kind: 'LOW_STOCK', label: 'Low stock', description: 'Items at or below their reorder level.' },
  { kind: 'EXPIRY_WATCH', label: 'Expiry watch', description: 'Batches expiring in the next 90 days.' },
  { kind: 'RETURNS', label: 'Returns & credit notes', description: 'Every return with its status and value.' },
  { kind: 'AUDIT', label: 'Audit trail', description: 'Who did what, in order.' }
];

export default function ReportsPage() {
  const api = useApi();
  const { can, state } = useApp();
  const [kind, setKind] = useState<ReportKind>('SALES_SUMMARY');
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [report, setReport] = useState<ReportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<string | null>(null);
  const canSeeAll = can('reports.view.all');
  const available = REPORTS.filter((r) => r.kind !== 'AUDIT' || can('audit.view'));

  async function run() {
    setBusy(true);
    try {
      const result = await api<ReportResult>('reports.build', { kind, from, to });
      if (result) setReport(result);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Reports"
        subtitle={
          canSeeAll
            ? 'Everything is generated offline from your own database. Every report prints with your store name.'
            : "Cashiers can see their own sales for today. Ask a supervisor for wider reports."
        }
      />

      {!canSeeAll ? (
        <Alert tone="info">
          You are signed in as a cashier, so reports are limited to your own sales for today.
        </Alert>
      ) : null}

      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr auto' }}>
          <Field label="Report">
            <Select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
              {available.map((r) => (
                <option key={r.kind} value={r.kind}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" hint={!canSeeAll ? 'Locked to today' : undefined}>
            <Input type="date" value={from} disabled={!canSeeAll} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" hint={!canSeeAll ? 'Locked to today' : undefined}>
            <Input type="date" value={to} disabled={!canSeeAll} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Field label="&nbsp;">
            <Button onClick={run} disabled={busy}>
              {busy ? 'Building…' : 'Run report'}
            </Button>
          </Field>
        </div>
        <div className="row tight wrap" style={{ marginTop: 8 }}>
          <Button size="sm" variant="ghost" onClick={() => { setFrom(todayInput()); setTo(todayInput()); }}>
            Today
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setFrom(daysAgoInput(6)); setTo(todayInput()); }}>
            Last 7 days
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setFrom(daysAgoInput(29)); setTo(todayInput()); }}>
            Last 30 days
          </Button>
          {canSeeAll ? (
            <Button size="sm" variant="ghost" onClick={() => { setFrom(daysAgoInput(364)); setTo(todayInput()); }}>
              Last year
            </Button>
          ) : null}
        </div>
        <div className="tiny muted" style={{ marginTop: 10 }}>
          {REPORTS.find((r) => r.kind === kind)?.description}
        </div>
      </Card>

      {report ? (
        <Card
          title={report.title}
          actions={
            <>
              <Badge tone="neutral">{report.subtitle}</Badge>
              <Button size="sm" onClick={() => setDoc(report.html)}>
                Print / save
              </Button>
            </>
          }
        >
          {Object.keys(report.meta).length > 0 ? (
            <div className="row wrap" style={{ gap: 18, marginBottom: 14 }}>
              {Object.entries(report.meta).map(([key, value]) => (
                <div key={key}>
                  <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                    {key.replace(/([A-Z])/g, ' $1')}
                  </div>
                  <div style={{ fontWeight: 650 }}>
                    {typeof value === 'number' && key.toLowerCase().includes('sale')
                      ? formatMoney(value)
                      : String(value)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          <DataTable
            rows={report.rows}
            columns={report.columns.map((column) => ({
              key: column.key,
              label: column.label,
              align: column.align,
              render: (row: Record<string, string | number | null>) => {
                const value = row[column.key];
                if (column.money && typeof value === 'number') return formatMoney(value);
                if (value === null || value === '') return '—';
                return String(value);
              }
            }))}
            empty="No records for this period."
            footer={
              Object.keys(report.totals).length > 0 ? (
                <tr>
                  <td>Total</td>
                  {report.columns.slice(1).map((column) => {
                    const value = report.totals[column.key];
                    return (
                      <td key={column.key} className={column.align === 'right' ? 'num' : ''}>
                        {value === undefined ? '' : column.money ? formatMoney(value) : value}
                      </td>
                    );
                  })}
                </tr>
              ) : undefined
            }
          />
          <div className="tiny muted" style={{ marginTop: 10 }}>
            {state?.productName} · generated {new Date().toLocaleString('en-NG')}
          </div>
        </Card>
      ) : (
        <Card>
          <div className="empty">Pick a report and period, then press “Run report”.</div>
        </Card>
      )}

      {doc ? (
        <Modal title="Report preview" size="wide" onClose={() => setDoc(null)}>
          <DocumentView html={doc} filename={`${kind.toLowerCase()}-${from}.html`} title={report?.title ?? 'Report'} />
        </Modal>
      ) : null}
    </div>
  );
}
