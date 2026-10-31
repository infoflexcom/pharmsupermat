import { useEffect, useState } from 'react';
import { useApi, useApp } from '../state';
import type { BackupStatus, DashboardSummary } from '../../../shared/types';
import { Alert, Button, Card, DataTable, formatDateTime, Kpi, Money, PageHead, Badge } from '../components/ui';
import type { ViewKey } from '../components/Layout';
import { formatMoney } from '../../../shared/money';

export default function DashboardPage({ onNavigate }: { onNavigate: (view: ViewKey) => void }) {
  const api = useApi();
  const { session, state, can } = useApp();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [backup, setBackup] = useState<BackupStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await api<DashboardSummary>('dashboard.get');
      if (!alive) return;
      setData(result);
      setLoading(false);
    })();
    void (async () => {
      try {
        const status = await api<BackupStatus>('backup.status');
        if (alive) setBackup(status);
      } catch {
        // A cashier cannot read backups; the warning is simply not shown.
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const license = state?.license;
  const firstName = session?.fullName.split(' ')[0] ?? '';

  return (
    <div className="stack">
      <PageHead
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${firstName}`}
        subtitle={`${session?.storeName || 'Your store'} · ${state?.productName} · ${new Date().toLocaleDateString('en-NG', { dateStyle: 'full' })}`}
        actions={
          <>
            {can('pos.sell') ? (
              <Button onClick={() => onNavigate('pos')}>New sale</Button>
            ) : null}
            {can('returns.create') ? (
              <Button variant="ghost" onClick={() => onNavigate('returns')}>
                Process return
              </Button>
            ) : null}
          </>
        }
      />

      {license?.state === 'EXPIRING' ? (
        <Alert tone="warn">
          Licence expires in {license.daysRemaining} day(s) ({license.expiresAt?.slice(0, 10)}). Renew from the
          Licence page to avoid interruption.
        </Alert>
      ) : null}

      {backup?.stale && can('settings.manage') ? (
        <Alert tone="warn">
          {backup.lastAt
            ? `No backup for ${backup.daysSince} day(s). Take one from Backup & restore.`
            : 'No backup has ever been taken on this computer. Take one from Backup & restore.'}
        </Alert>
      ) : null}

      {data && (data.pendingVoids > 0 || data.pendingReturns > 0) && can('sales.void.approve') ? (
        <Alert tone="info">
          {data.pendingVoids} void request(s) and {data.pendingReturns} return(s) are waiting for approval.
        </Alert>
      ) : null}

      <div className="kpi-grid">
        <Kpi
          label="Today's sales"
          value={loading ? '—' : formatMoney(data?.todaySales ?? 0)}
          hint={`${data?.todayTransactions ?? 0} transaction(s)`}
        />
        <Kpi label="This week" value={loading ? '—' : formatMoney(data?.weekSales ?? 0)} hint="Last 7 days" />
        <Kpi
          label="Returns today"
          value={loading ? '—' : formatMoney(data?.todayReturns ?? 0)}
          hint="Completed credit notes"
        />
        <Kpi
          label="Low stock"
          value={loading ? '—' : String(data?.lowStockCount ?? 0)}
          hint={state?.features.pharmacy ? `${data?.expiringCount ?? 0} batches expiring soon` : 'At or below reorder level'}
        />
      </div>

      <div className="pos-grid" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        <Card
          title="Recent transactions"
          actions={
            can('sales.view.all') ? (
              <Button size="sm" variant="ghost" onClick={() => onNavigate('sales')}>
                View all
              </Button>
            ) : null
          }
        >
          <DataTable
            columns={[
              { key: 'receiptNo', label: 'Receipt' },
              { key: 'createdAt', label: 'Time', render: (r) => formatDateTime(r.createdAt) },
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
                    <Badge tone="success">Paid</Badge>
                  )
              },
              { key: 'total', label: 'Total', align: 'right', render: (r) => <Money value={r.total} /> }
            ]}
            rows={data?.recentSales ?? []}
            empty={loading ? 'Loading…' : 'No sales recorded yet.'}
          />
        </Card>

        <div className="stack">
          <Card title="Best sellers today">
            {(data?.topProducts ?? []).length === 0 ? (
              <div className="empty">{loading ? 'Loading…' : 'Nothing sold yet today.'}</div>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {data?.topProducts.map((product) => (
                  <div key={product.name} className="row between">
                    <div>
                      <div style={{ fontWeight: 600 }}>{product.name}</div>
                      <div className="tiny muted">{product.qty} sold</div>
                    </div>
                    <Money value={product.total} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Quick actions">
            <div className="stack" style={{ gap: 8 }}>
              {can('pos.sell') ? (
                <Button variant="ghost" block onClick={() => onNavigate('pos')}>
                  Open point of sale
                </Button>
              ) : null}
              {can('reports.view.own') ? (
                <Button variant="ghost" block onClick={() => onNavigate('reports')}>
                  {can('reports.view.all') ? 'Run a report' : "View today's sales report"}
                </Button>
              ) : null}
              {can('products.manage') ? (
                <Button variant="ghost" block onClick={() => onNavigate('products')}>
                  Add a product
                </Button>
              ) : null}
              {can('backup.manage') ? (
                <Button variant="ghost" block onClick={() => onNavigate('backup')}>
                  Back up data
                </Button>
              ) : null}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
