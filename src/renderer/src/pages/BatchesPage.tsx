import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../state';
import { formatMoney } from '../../../shared/money';
import type { Batch, Product } from '../../../shared/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDate,
  PageHead,
  SearchBox,
  Select
} from '../components/ui';

interface ExpiryRow {
  productId: number;
  sku: string;
  name: string;
  batchNo: string;
  expiryDate: string;
  daysLeft: number;
  qty: number;
}

export default function BatchesPage() {
  const api = useApi();
  const [windowDays, setWindowDays] = useState(90);
  const [expiring, setExpiring] = useState<ExpiryRow[]>([]);
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadExpiring = useCallback(async () => {
    const rows = await api<ExpiryRow[]>('pharmacy.expiryWatch', { windowDays });
    if (rows) setExpiring(rows);
  }, [api, windowDays]);

  useEffect(() => {
    void loadExpiring();
  }, [loadExpiring]);

  const loadProducts = useCallback(async () => {
    const rows = await api<Product[]>('products.list', { search: search || undefined });
    if (rows) setProducts(rows);
  }, [api, search]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  async function showBatches(productId: number) {
    const product = products.find((p) => p.id === productId) ?? null;
    setSelected(product);
    setBatches([]);
    setError(null);
    if (!product) return;
    const rows = await api<Batch[]>('stock.batches', { productId: product.id });
    setBatches(rows ?? []);
  }

  const expired = expiring.filter((row) => row.daysLeft < 0);
  const soon = expiring.filter((row) => row.daysLeft >= 0 && row.daysLeft <= 30);

  return (
    <div className="stack">
      <PageHead
        title="Batches & Expiry"
        subtitle="Pharmacy module: first-expiry-first-out selling, expired stock is refused at the till."
        actions={
          <Field label="Alert window">
            <Select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
              {[30, 60, 90, 180, 365].map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </Select>
          </Field>
        }
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="kpi-row">
        <div className="kpi">
          <div className="label">Expired batches</div>
          <div className="value">{expired.length}</div>
          <div className="hint">never sold; write off via a stock adjustment</div>
        </div>
        <div className="kpi">
          <div className="label">Expiring within 30 days</div>
          <div className="value">{soon.length}</div>
          <div className="hint">move these to the front shelf or return them</div>
        </div>
        <div className="kpi">
          <div className="label">In the alert window</div>
          <div className="value">{expiring.length}</div>
          <div className="hint">batches still holding stock</div>
        </div>
      </div>

      <Card title="Expiry watch">
        <DataTable<ExpiryRow>
          rows={expiring}
          empty="Nothing is expiring in this window."
          columns={[
            { key: 'name', label: 'Product' },
            { key: 'sku', label: 'Code' },
            { key: 'batchNo', label: 'Batch' },
            { key: 'expiryDate', label: 'Expires', render: (row) => formatDate(row.expiryDate) },
            {
              key: 'daysLeft',
              label: 'Days left',
              align: 'right',
              render: (row) => (
                <Badge tone={row.daysLeft < 0 ? 'danger' : row.daysLeft <= 30 ? 'warn' : 'neutral'}>
                  {row.daysLeft < 0 ? `${Math.abs(row.daysLeft)} days ago` : `${row.daysLeft} days`}
                </Badge>
              )
            },
            { key: 'qty', label: 'Qty', align: 'right' }
          ]}
        />
      </Card>

      <Card title="Batches for a product" actions={<SearchBox value={search} onChange={setSearch} placeholder="Find a product" />}>
        <div className="form-grid">
          <Field label="Product">
            <Select value={selected?.id ?? ''} onChange={(e) => void showBatches(Number(e.target.value))}>
              <option value="">Choose a product…</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
          </Field>
          {selected ? (
            <Field label="Stock">
              <div style={{ paddingTop: 10 }}>{selected.stockQty} units</div>
            </Field>
          ) : null}
        </div>

        <DataTable<Batch>
          rows={batches}
          empty={selected ? 'This product has no batches.' : 'Choose a product to see its batches.'}
          columns={[
            { key: 'batchNo', label: 'Batch' },
            { key: 'expiryDate', label: 'Expiry', render: (row) => (row.expiryDate ? formatDate(row.expiryDate) : '—') },
            { key: 'qty', label: 'Quantity', align: 'right' },
            { key: 'costPrice', label: 'Unit cost', align: 'right', render: (row) => formatMoney(row.costPrice) }
          ]}
        />
        <p className="tiny muted">
          Batches are sold oldest-expiry first. Receiving more stock happens in Stock &amp; Purchases.
        </p>
        <div className="row tight">
          <Button size="sm" variant="ghost" onClick={() => void loadExpiring()}>
            Refresh alerts
          </Button>
        </div>
      </Card>
    </div>
  );
}
