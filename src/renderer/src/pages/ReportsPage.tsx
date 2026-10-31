import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, isDesktop } from '../api';
import { useApi, useApp } from '../state';
import type {
  DailySummary,
  DayReconciliation,
  MonthlySummary,
  ReportCatalogueEntry,
  ReportKind,
  ReportRequest,
  ReportResult
} from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Kpi,
  Modal,
  PageHead,
  Select,
  Spinner,
  daysAgoInput,
  formatDate,
  formatDateTime,
  todayInput
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';

type Tab = 'daily' | 'monthly' | 'library';
type ExportFile = { filename: string; data: string; encoding: 'utf8' | 'base64'; mime?: string };

/** Reports that describe the here and now, so they take no date range. */
const POINT_IN_TIME: ReportKind[] = ['STOCK_VALUATION', 'LOW_STOCK', 'DEBTORS'];

const OWNER_LABEL: Record<string, string> = {
  SHARED: 'Every edition',
  PHARMACY: 'Pharmacy',
  SUPERMARKET: 'Supermarket'
};

/**
 * Saves an exported report: the desktop app writes it into the data folder's
 * exports directory, a browser dev session downloads it instead.
 */
async function saveExport(file: ExportFile): Promise<string> {
  if (isDesktop()) {
    const result = await call<{ path: string }>('documents.saveExport', {
      filename: file.filename,
      data: file.data,
      encoding: file.encoding
    });
    return result.path;
  }
  const blob =
    file.encoding === 'base64'
      ? new Blob([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))], { type: file.mime ?? 'application/octet-stream' })
      : new Blob([file.data], { type: file.mime ?? 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(url);
  return file.filename;
}

/** Money-ish meta keys are formatted as naira; counts stay plain numbers. */
function metaIsMoney(key: string): boolean {
  if (/count|transactions|items|lines|days|users|members|batches|suppliers|scope|period/i.test(key)) return false;
  return /sale|revenue|total|amount|takings|profit|discount|return|refund|cash|tax|vat|cost|value|balance|due|float|tied/i.test(
    key
  );
}

function metaLabel(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** A plain HTML bar chart, no chart library needed offline. */
function BarChart({ labels, values, money }: { labels: string[]; values: number[]; money?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className="report-chart" role="img" aria-label="Daily sales chart">
      {values.map((value, index) => (
        <div key={`${labels[index]}-${index}`} className="report-chart-col" title={`${labels[index]}: ${money ? formatMoney(value) : value}`}>
          <div className="report-chart-bar" style={{ height: `${Math.max(value > 0 ? 4 : 0, (value / max) * 100)}%` }} />
          <div className="report-chart-label">{labels[index].slice(-2)}</div>
        </div>
      ))}
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'muted' | 'good' | 'bad' }) {
  return (
    <div className="figure">
      <div className="tiny muted">{label}</div>
      <div className={tone === 'good' ? 'good' : tone === 'bad' ? 'bad' : ''} style={{ fontWeight: 650 }}>
        {value}
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const api = useApi();
  const { can, notify, state } = useApp();
  const canSeeAll = can('reports.view.all');
  const isAdmin = state?.session?.role === 'ADMIN';

  const [tab, setTab] = useState<Tab>('daily');
  const [doc, setDoc] = useState<{ html: string; filename: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /* ---------------- daily ---------------- */
  const [date, setDate] = useState(todayInput());
  const [daily, setDaily] = useState<DailySummary | null>(null);
  const [recon, setRecon] = useState<DayReconciliation | null>(null);
  const [openingFloat, setOpeningFloat] = useState('');
  const [countedCash, setCountedCash] = useState('');
  const [closeNote, setCloseNote] = useState('');
  const [closing, setClosing] = useState(false);

  const loadDaily = useCallback(
    async (day: string, float?: string) => {
      setBusy(true);
      try {
        const summary = await api<DailySummary>('reports.daily', { date: day });
        if (summary) setDaily(summary);
        if (canSeeAll) {
          const floatKobo = float?.trim() ? Math.round(Number(float) * 100) : undefined;
          const reconciliation = await api<DayReconciliation>('operations.day.reconcile', {
            businessDate: day,
            ...(floatKobo !== undefined && Number.isFinite(floatKobo) ? { openingFloat: floatKobo } : {})
          });
          if (reconciliation) {
            setRecon(reconciliation);
            if (reconciliation.countedCash !== null) {
              setCountedCash(String(reconciliation.countedCash / 100));
            }
          }
        } else setRecon(null);
      } finally {
        setBusy(false);
      }
    },
    [api, canSeeAll]
  );

  /* ---------------- monthly ---------------- */
  const [month, setMonth] = useState(todayInput().slice(0, 7));
  const [monthly, setMonthly] = useState<MonthlySummary | null>(null);

  const loadMonthly = useCallback(
    async (value: string) => {
      setBusy(true);
      try {
        const summary = await api<MonthlySummary>('reports.monthly', { month: value });
        if (summary) setMonthly(summary);
      } finally {
        setBusy(false);
      }
    },
    [api]
  );

  /* ---------------- library ---------------- */
  const [catalogue, setCatalogue] = useState<ReportCatalogueEntry[]>([]);
  const [kind, setKind] = useState<ReportKind>('SALES_SUMMARY');
  const [from, setFrom] = useState(todayInput());
  const [to, setTo] = useState(todayInput());
  const [report, setReport] = useState<ReportResult | null>(null);

  useEffect(() => {
    void api<ReportCatalogueEntry[]>('reports.catalogue', {}).then((list) => {
      if (!list?.length) return;
      setCatalogue(list);
      setKind((current) => (list.some((entry) => entry.kind === current) ? current : list[0].kind));
    });
  }, [api]);

  useEffect(() => {
    if (tab === 'daily') void loadDaily(date);
    if (tab === 'monthly') void loadMonthly(month);
  }, [tab, date, month, loadDaily, loadMonthly]);

  const entry = useMemo(() => catalogue.find((item) => item.kind === kind), [catalogue, kind]);
  const grouped = useMemo(() => {
    const order = ['SHARED', 'PHARMACY', 'SUPERMARKET'];
    return order
      .map((owner) => ({ owner, entries: catalogue.filter((item) => item.owner === owner) }))
      .filter((group) => group.entries.length > 0);
  }, [catalogue]);

  /* ---------------- shared actions ---------------- */

  async function guard<T>(work: () => Promise<T>, success?: string): Promise<T | null> {
    setBusy(true);
    try {
      const result = await work();
      if (success) notify(success, 'success');
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : 'That report could not be built.', 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function requestFor(target: ReportKind | null): ReportRequest {
    const chosen = target ?? kind;
    const isPoint = POINT_IN_TIME.includes(chosen);
    const base: ReportRequest = { kind: chosen };
    if (tab === 'daily') return { kind: chosen, from: date, to: date };
    if (tab === 'monthly') {
      const start = `${month}-01`;
      // Day 0 of the next month is the last day of this one, in UTC so the date
      // never slips for a shop east or west of Greenwich.
      const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
      return { kind: chosen, month, from: start, to: end.toISOString().slice(0, 10) };
    }
    return isPoint ? base : { ...base, from, to };
  }

  async function printReport(target?: ReportKind) {
    const request = requestFor(target ?? null);
    const built = await guard(() => api<ReportResult>('reports.build', request as unknown as Record<string, unknown>));
    if (built) setDoc({ html: built.html, filename: `${String(built.kind).toLowerCase()}-${request.from ?? date}.html`, title: built.title });
  }

  async function exportCsv(target?: ReportKind) {
    const request = requestFor(target ?? null);
    const file = await guard(() =>
      api<ExportFile>('reports.export', request as unknown as Record<string, unknown>)
    );
    if (!file) return;
    const where = await guard(() => saveExport({ ...file, mime: 'text/csv;charset=utf-8' }));
    if (where) notify(`CSV saved: ${where}`, 'success');
  }

  async function exportExcel(target?: ReportKind) {
    const request = requestFor(target ?? null);
    const file = await guard(() =>
      api<ExportFile>('reports.excel', request as unknown as Record<string, unknown>)
    );
    if (!file) return;
    const where = await guard(() =>
      saveExport({ ...file, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    );
    if (where) notify(`Excel saved: ${where}`, 'success');
  }

  async function exportPdf(target?: ReportKind) {
    const request = requestFor(target ?? null);
    const file = await guard(() => api<ExportFile>('reports.pdf', request as unknown as Record<string, unknown>));
    if (!file) return;
    // In the desktop app the main process renders a real PDF; the browser
    // harness has no print engine, so fall back to printing the page.
    const where = await guard(() => saveExport({ ...file, mime: 'application/pdf' }));
    if (where) notify(`PDF saved: ${where}`, 'success');
  }

  async function runLibrary() {
    const request = requestFor(kind);
    const built = await guard(() => api<ReportResult>('reports.build', request as unknown as Record<string, unknown>));
    if (built) setReport(built);
  }

  /* ---------------- day close ---------------- */

  async function closeDay() {
    const naira = Number(countedCash);
    if (!countedCash.trim() || !Number.isFinite(naira) || naira < 0) {
      notify('Type the cash you counted, in naira.', 'info');
      return;
    }
    setClosing(true);
    try {
      const floatKobo = openingFloat.trim() ? Math.round(Number(openingFloat) * 100) : undefined;
      await api('operations.day.close', {
        businessDate: date,
        countedCash: Math.round(naira * 100),
        ...(floatKobo !== undefined && Number.isFinite(floatKobo) ? { openingFloat: floatKobo } : {}),
        note: closeNote.trim() || undefined
      });
      notify('Day closed and saved.', 'success');
      setCloseNote('');
      await loadDaily(date);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The day could not be closed.', 'error');
    } finally {
      setClosing(false);
    }
  }

  /* ---------------- render helpers ---------------- */

  const summary = tab === 'daily' ? daily : tab === 'monthly' ? monthly : null;
  const difference = recon && countedCash.trim() ? Math.round(Number(countedCash) * 100) - recon.expectedCash : null;

  return (
    <div className="stack">
      <PageHead
        title="Reports"
        subtitle={
          canSeeAll
            ? 'Daily and monthly accounts, end-of-day cash and every report — built offline from your own database.'
            : 'Cashiers see their own sales for today. Ask a supervisor for the rest of the reports.'
        }
        actions={
          <div className="row tight wrap">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !summary}
              onClick={() => void exportCsv()}
            >
              Export CSV
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !summary} onClick={() => void exportExcel()}>
              Export Excel
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !summary} onClick={() => void exportPdf()}>
              Export PDF
            </Button>
            <Button size="sm" disabled={busy || !summary} onClick={() => void printReport()}>
              Print
            </Button>
          </div>
        }
      />

      <div className="tabs">
        <button className={`tab ${tab === 'daily' ? 'active' : ''}`} onClick={() => setTab('daily')}>
          Daily summary
        </button>
        <button className={`tab ${tab === 'monthly' ? 'active' : ''}`} onClick={() => setTab('monthly')}>
          Monthly summary
        </button>
        <button className={`tab ${tab === 'library' ? 'active' : ''}`} onClick={() => setTab('library')}>
          All reports
        </button>
      </div>

      {!canSeeAll ? (
        <Alert tone="info">
          You are signed in as a cashier, so every figure here is limited to your own sales for today. Cost and profit
          stay hidden.
        </Alert>
      ) : null}

      {/* ------------------------------- daily ------------------------------- */}
      {tab === 'daily' ? (
        <>
          <Card>
            <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
              <Field label="Trading day">
                <Input type="date" value={date} max={todayInput()} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <div className="row tight wrap" style={{ paddingBottom: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => setDate(todayInput())}>
                  Today
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDate(daysAgoInput(1))}>
                  Yesterday
                </Button>
              </div>
              {busy ? <Spinner /> : null}
            </div>
          </Card>

          {daily ? (
            <Card title={`Daily summary — ${formatDate(daily.date)}`} actions={<Badge tone="neutral">{state?.productName}</Badge>}>
              <div className="kpi-grid">
                <Kpi label="Net sales" value={formatMoney(daily.netSales)} hint="VAT and returns excluded" />
                <Kpi label="Money taken" value={formatMoney(daily.netSalesInclVat)} hint="VAT included, returns deducted" />
                <Kpi label="Transactions" value={String(daily.salesCount)} hint={`${daily.returnsCount} return(s)`} />
                <Kpi label="Discounts" value={formatMoney(daily.discounts)} />
                {daily.grossProfit !== null ? (
                  <>
                    <Kpi label="Cost of goods" value={formatMoney(daily.cogs)} />
                    <Kpi label="Gross profit" value={formatMoney(daily.grossProfit)} hint="Admin only" />
                  </>
                ) : null}
              </div>

              <div className="row wrap" style={{ gap: 26, marginTop: 16 }}>
                <Figure label="Retail" value={`${daily.retailCount} sales · ${formatMoney(daily.retailSales)}`} />
                <Figure label="Wholesale" value={`${daily.wholesaleCount} sales · ${formatMoney(daily.wholesaleSales)}`} />
                <Figure label="Gross sales" value={formatMoney(daily.grossSales)} />
                <Figure label="Returns" value={formatMoney(daily.returnsTotal)} />
                <Figure label="VAT collected" value={formatMoney(daily.tax)} />
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="card-title" style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>
                  Payment methods
                </div>
                {daily.payments.length === 0 ? (
                  <div className="empty">No payments on this day.</div>
                ) : (
                  <DataTable
                    rows={daily.payments as unknown as Record<string, string | number | null>[]}
                    columns={[
                      { key: 'label', label: 'Method' },
                      { key: 'count', label: 'Payments', align: 'right' },
                      { key: 'amount', label: 'Amount', align: 'right', money: true }
                    ]}
                    getKey={(row) => String(row.method)}
                  />
                )}
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="card-title" style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>
                  Sales per user
                </div>
                {daily.users.length === 0 ? (
                  <div className="empty">Nobody sold anything on this day.</div>
                ) : (
                  <DataTable
                    rows={daily.users as unknown as Record<string, string | number | null>[]}
                    columns={[
                      { key: 'name', label: 'User' },
                      { key: 'salesCount', label: 'Sales', align: 'right' },
                      { key: 'gross', label: 'Gross', align: 'right', money: true },
                      { key: 'net', label: 'Net', align: 'right', money: true },
                      { key: 'returns', label: 'Returns', align: 'right', money: true }
                    ]}
                    getKey={(row) => String(row.userId)}
                  />
                )}
              </div>
            </Card>
          ) : (
            <Card>
              <div className="empty">{busy ? 'Building the summary…' : 'Pick a trading day to see its summary.'}</div>
            </Card>
          )}

          {canSeeAll && recon ? (
            <Card
              title="End of day close"
              actions={<Badge tone={recon.closedAt ? 'success' : 'warn'}>{recon.closedAt ? 'Closed' : 'Open'}</Badge>}
            >
              <div className="kpi-grid">
                <Kpi label="Expected cash" value={formatMoney(recon.expectedCash)} hint="Opening float + cash sales − cash refunds" />
                <Kpi
                  label="Counted cash"
                  value={countedCash.trim() ? formatMoney(Math.round(Number(countedCash) * 100)) : '—'}
                  hint={recon.countedCash !== null ? `Saved: ${formatMoney(recon.countedCash)}` : 'Type what is in the drawer'}
                />
                <Kpi
                  label="Difference"
                  value={difference === null ? '—' : formatMoney(difference)}
                  hint={difference === null ? 'Over / short appears once you count' : difference === 0 ? 'Balanced' : difference > 0 ? 'Over' : 'Short'}
                />
                <Kpi label="Cash sales" value={formatMoney(recon.cashSales)} hint={`Refunds ${formatMoney(recon.cashRefunds)}`} />
              </div>

              <div className="row wrap" style={{ gap: 26, marginTop: 16 }}>
                <Figure label="Transfer" value={formatMoney(recon.transferSales)} />
                <Figure label="POS / card" value={formatMoney(recon.posSales)} />
                <Figure label="Opening float" value={formatMoney(recon.openingFloat)} />
                <Figure label="Gross sales" value={formatMoney(recon.grossSales)} />
                <Figure label="Discounts" value={formatMoney(recon.discounts)} />
                <Figure label="Returns" value={formatMoney(recon.returnsTotal)} />
              </div>

              {recon.closedAt ? (
                <Alert tone="success">
                  Closed by {recon.closedBy ?? 'unknown'} on {formatDateTime(recon.closedAt)}
                  {recon.note ? ` — ${recon.note}` : ''}.
                </Alert>
              ) : null}

              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 2fr auto', marginTop: 16 }}>
                <Field label="Opening float (₦)" hint="Change put in at the start">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={openingFloat}
                    onChange={(e) => setOpeningFloat(e.target.value)}
                    onBlur={() => void loadDaily(date, openingFloat)}
                    placeholder={recon.openingFloat ? (recon.openingFloat / 100).toFixed(2) : '0.00'}
                  />
                </Field>
                <Field label="Counted cash (₦)" hint="Everything in the drawer">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={countedCash}
                    onChange={(e) => setCountedCash(e.target.value)}
                    placeholder="0.00"
                  />
                </Field>
                <Field label="Note" hint="Optional, e.g. short by ₦500 for change">
                  <Input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="Anything to explain?" />
                </Field>
                <Field label="&nbsp;">
                  <Button onClick={() => void closeDay()} disabled={closing || !recon.canClose}>
                    {closing ? 'Saving…' : recon.canClose ? 'Close the day' : 'Day closed'}
                  </Button>
                </Field>
              </div>

              {!recon.canClose ? (
                <div className="tiny muted">
                  This day is locked. Its cash, variance and the person who closed it are kept in the audit trail.
                </div>
              ) : null}

              {recon.shiftReconciliation ? (
                <div style={{ marginTop: 20 }}>
                  <div className="card-title" style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>
                    Shifts
                  </div>
                  {recon.shifts.length === 0 ? (
                    <div className="empty">No shifts were opened on this day.</div>
                  ) : (
                    <DataTable
                      rows={recon.shifts as unknown as Record<string, string | number | null>[]}
                      columns={[
                        { key: 'username', label: 'Cashier' },
                        { key: 'openedAt', label: 'Opened', render: (row) => formatDateTime(String(row.openedAt ?? '')) },
                        { key: 'openingFloat', label: 'Float', align: 'right', money: true },
                        { key: 'cashSales', label: 'Cash in', align: 'right', money: true },
                        { key: 'cashRefunds', label: 'Refunds', align: 'right', money: true },
                        { key: 'expectedCash', label: 'Expected', align: 'right', money: true },
                        { key: 'countedCash', label: 'Counted', align: 'right', money: true },
                        { key: 'variance', label: 'Over / short', align: 'right', money: true },
                        { key: 'status', label: 'Status' }
                      ]}
                      getKey={(row) => String(row.shiftId)}
                    />
                  )}

                  <div className="card-title" style={{ fontSize: 13, fontWeight: 650, margin: '16px 0 6px' }}>
                    Per cashier
                  </div>
                  {recon.cashiers.length === 0 ? (
                    <div className="empty">No sales were recorded by any user.</div>
                  ) : (
                    <DataTable
                      rows={recon.cashiers as unknown as Record<string, string | number | null>[]}
                      columns={[
                        { key: 'fullName', label: 'Cashier' },
                        { key: 'salesCount', label: 'Sales', align: 'right' },
                        { key: 'gross', label: 'Gross', align: 'right', money: true },
                        { key: 'cashSales', label: 'Cash in', align: 'right', money: true },
                        { key: 'cashRefunds', label: 'Refunds', align: 'right', money: true },
                        { key: 'expectedCash', label: 'Expected cash', align: 'right', money: true },
                        { key: 'variance', label: 'Over / short', align: 'right', money: true }
                      ]}
                      getKey={(row) => String(row.userId)}
                    />
                  )}
                </div>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}

      {/* ------------------------------ monthly ------------------------------ */}
      {tab === 'monthly' ? (
        <>
          <Card>
            <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
              <Field label="Month">
                <Input
                  type="month"
                  value={month}
                  max={todayInput().slice(0, 7)}
                  onChange={(e) => setMonth(e.target.value || todayInput().slice(0, 7))}
                />
              </Field>
              <div className="row tight wrap" style={{ paddingBottom: 6 }}>
                <Button size="sm" variant="ghost" onClick={() => setMonth(todayInput().slice(0, 7))}>
                  This month
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const now = new Date();
                    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
                    setMonth(previous.toISOString().slice(0, 7));
                  }}
                >
                  Last month
                </Button>
              </div>
              {busy ? <Spinner /> : null}
            </div>
          </Card>

          {monthly ? (
            <Card
              title={`Monthly summary — ${new Date(`${monthly.from}T12:00:00.000Z`).toLocaleDateString('en-NG', {
                month: 'long',
                year: 'numeric'
              })}`}
              actions={<Badge tone="neutral">{`${formatDate(monthly.from)} – ${formatDate(monthly.to)}`}</Badge>}
            >
              <div className="kpi-grid">
                <Kpi label="Net sales" value={formatMoney(monthly.netSales)} hint="VAT and returns excluded" />
                <Kpi label="Money taken" value={formatMoney(monthly.netSalesInclVat)} />
                <Kpi label="Transactions" value={String(monthly.salesCount)} hint={`${monthly.returnsCount} return(s)`} />
                <Kpi label="Discounts" value={formatMoney(monthly.discounts)} />
                {monthly.grossProfit !== null ? (
                  <>
                    <Kpi label="Cost of goods" value={formatMoney(monthly.cogs)} />
                    <Kpi label="Gross profit" value={formatMoney(monthly.grossProfit)} hint="Admin only" />
                  </>
                ) : null}
              </div>

              <div className="row wrap" style={{ gap: 26, marginTop: 16 }}>
                <Figure label="Retail" value={`${monthly.retailCount} sales · ${formatMoney(monthly.retailSales)}`} />
                <Figure label="Wholesale" value={`${monthly.wholesaleCount} sales · ${formatMoney(monthly.wholesaleSales)}`} />
                <Figure label="Gross sales" value={formatMoney(monthly.grossSales)} />
                <Figure label="Returns" value={formatMoney(monthly.returnsTotal)} />
                <Figure label="VAT collected" value={formatMoney(monthly.tax)} />
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="card-title" style={{ fontSize: 13, fontWeight: 650, marginBottom: 6 }}>
                  Daily sales
                </div>
                <BarChart labels={monthly.chart.labels} values={monthly.chart.values} money />
              </div>

              <div style={{ marginTop: 18 }}>
                <DataTable
                  rows={monthly.days as unknown as Record<string, string | number | null>[]}
                  columns={[
                    { key: 'date', label: 'Date', render: (row) => formatDate(String(row.date ?? '')) },
                    { key: 'salesCount', label: 'Sales', align: 'right' },
                    { key: 'net', label: 'Net', align: 'right', money: true },
                    { key: 'takings', label: 'Taken', align: 'right', money: true },
                    { key: 'returns', label: 'Returns', align: 'right', money: true },
                    { key: 'cogs', label: 'Cost', align: 'right', money: true },
                    ...(isAdmin ? [{ key: 'profit', label: 'Profit', align: 'right' as const, money: true }] : [])
                  ]}
                  getKey={(row) => String(row.date)}
                  footer={
                    <tr>
                      <td>Total</td>
                      <td className="num">{monthly.salesCount}</td>
                      <td className="num">{formatMoney(monthly.netSales)}</td>
                      <td className="num">{formatMoney(monthly.netSalesInclVat)}</td>
                      <td className="num">{formatMoney(monthly.returnsTotal)}</td>
                      <td className="num">{formatMoney(monthly.cogs)}</td>
                      {isAdmin ? <td className="num">{monthly.grossProfit === null ? '' : formatMoney(monthly.grossProfit)}</td> : null}
                    </tr>
                  }
                />
              </div>
            </Card>
          ) : (
            <Card>
              <div className="empty">{busy ? 'Building the summary…' : 'Pick a month to see its summary.'}</div>
            </Card>
          )}
        </>
      ) : null}

      {/* ------------------------------ library ------------------------------ */}
      {tab === 'library' ? (
        <>
          <Card>
            <div className="form-grid" style={{ gridTemplateColumns: '2fr 1fr 1fr auto' }}>
              <Field label="Report">
                <Select value={kind} onChange={(e) => setKind(e.target.value as ReportKind)}>
                  {grouped.map((group) => (
                    <optgroup key={group.owner} label={OWNER_LABEL[group.owner] ?? group.owner}>
                      {group.entries.map((item) => (
                        <option key={item.kind} value={item.kind}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              <Field label="From" hint={POINT_IN_TIME.includes(kind) ? 'Not used' : undefined}>
                <Input
                  type="date"
                  value={from}
                  disabled={POINT_IN_TIME.includes(kind)}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="To" hint={POINT_IN_TIME.includes(kind) ? 'Not used' : undefined}>
                <Input
                  type="date"
                  value={to}
                  disabled={POINT_IN_TIME.includes(kind)}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
              <Field label="&nbsp;">
                <Button onClick={() => void runLibrary()} disabled={busy}>
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
              <Button size="sm" variant="ghost" onClick={() => { setFrom(daysAgoInput(364)); setTo(todayInput()); }}>
                Last year
              </Button>
            </div>
            <div className="tiny muted" style={{ marginTop: 10 }}>
              {entry?.description ?? 'Pick a report, then press “Run report”.'}
            </div>
          </Card>

          {report ? (
            <Card
              title={report.title}
              actions={
                <>
                  <Badge tone="neutral">{report.subtitle}</Badge>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void exportCsv()}>
                    CSV
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void exportExcel()}>
                    Excel
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void exportPdf()}>
                    PDF
                  </Button>
                  <Button size="sm" disabled={busy} onClick={() => void printReport()}>
                    P{'\u00ad'}rint
                  </Button>
                </>
              }
            >
              {Object.keys(report.meta).length > 0 ? (
                <div className="row wrap" style={{ gap: 18, marginBottom: 14 }}>
                  {Object.entries(report.meta).map(([key, value]) => (
                    <div key={key}>
                      <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
                        {metaLabel(key)}
                      </div>
                      <div style={{ fontWeight: 650 }}>
                        {typeof value === 'number' && metaIsMoney(key) ? formatMoney(value) : String(value)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
              {report.chart ? (
                <BarChart labels={report.chart.labels} values={report.chart.values} money={report.chart.money} />
              ) : null}
              <DataTable
                rows={report.rows}
                columns={report.columns.map((column) => ({
                  key: column.key,
                  label: column.label,
                  align: column.align,
                  money: column.money,
                  render: (row: Record<string, string | number | null>) => {
                    const value = row[column.key];
                    if (column.money && typeof value === 'number') return formatMoney(value);
                    if (value === null || value === undefined || value === '') return '—';
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
                {state?.productName} · generated {new Date().toLocaleString('en-NG')} · prints with your store name and
                address
              </div>
            </Card>
          ) : (
            <Card>
              <div className="empty">Pick a report and period, then press “Run report”.</div>
            </Card>
          )}
        </>
      ) : null}

      {doc ? (
        <Modal title="Report preview" size="wide" onClose={() => setDoc(null)}>
          <DocumentView html={doc.html} filename={doc.filename} title={doc.title} />
        </Modal>
      ) : null}
    </div>
  );
}
