import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi, useApp } from '../state';
import { formatMoney } from '../../../shared/money';
import type { Product } from '../../../shared/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  formatDate,
  formatDateTime,
  Input,
  PageHead,
  SearchBox,
  Select
} from '../components/ui';

interface SupplierRow {
  id: number;
  name: string;
}

interface PurchaseRow {
  id: number;
  purchase_no: string;
  supplier_name: string | null;
  purchase_date: string;
  total: number;
  status: string;
  items?: { name: string; qty: number }[];
}

interface LedgerRow {
  id: number;
  createdAt: string;
  type: string;
  qtyChange: number;
  note: string | null;
  reference: string | null;
}

interface DraftLine {
  productId: number | '';
  name: string;
  qty: number;
  costPrice: number;
  batchNo: string;
  expiryDate: string;
}

const emptyLine: DraftLine = { productId: '', name: '', qty: 1, costPrice: 0, batchNo: '', expiryDate: '' };

export default function StockPage() {
  const api = useApi();
  const { state, can, notify } = useApp();
  const pharmacy = Boolean(state?.features.pharmacy);

  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [purchases, setPurchases] = useState<PurchaseRow[]>([]);
  const [selected, setSelected] = useState<Product | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);

  const [receiveQty, setReceiveQty] = useState(1);
  const [batchNo, setBatchNo] = useState('');
  const [expiry, setExpiry] = useState('');
  const [costPrice, setCostPrice] = useState(0);

  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<DraftLine[]>([{ ...emptyLine }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [list, sup, pur] = await Promise.all([
      api<Product[]>('products.list', { search: search || undefined }),
      api<SupplierRow[]>('directory.suppliers.list', {}),
      api<PurchaseRow[]>('purchases.list', { limit: 25 })
    ]);
    if (list) setProducts(list);
    if (sup) setSuppliers(sup);
    if (pur) setPurchases(pur);
  }, [api, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadLedger = useCallback(
    async (product: Product) => {
      setSelected(product);
      const rows = await api<LedgerRow[]>('stock.ledger', { productId: product.id, limit: 25 });
      setLedger(rows ?? []);
    },
    [api]
  );

  useEffect(() => {
    if (selected) setCostPrice(selected.costPrice);
  }, [selected]);

  async function receive(event: React.FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    setBusy(true);
    try {
      await api('stock.receive', {
        productId: selected.id,
        qty: receiveQty,
        costPrice,
        batchNo: pharmacy ? batchNo || undefined : undefined,
        expiryDate: pharmacy ? expiry || null : null,
        note: 'Stock received from Stock & Purchases'
      });
      notify(`${receiveQty} × ${selected.name} added to stock.`, 'success');
      setReceiveQty(1);
      setBatchNo('');
      setExpiry('');
      const refreshed = await api<Product[]>('products.list', { search: selected.name });
      if (refreshed) {
        setProducts(refreshed);
        const match = refreshed.find((p) => p.id === selected.id);
        if (match) await loadLedger(match);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not receive stock.');
    } finally {
      setBusy(false);
    }
  }

  const purchaseTotal = useMemo(
    () =>
      lines.reduce((sum, line) => sum + (line.productId ? line.qty * Math.round(line.costPrice) : 0), 0),
    [lines]
  );

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function createPurchase(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const items = lines.filter((line) => line.productId);
    if (items.length === 0) return setError('Add at least one product to the purchase.');
    setBusy(true);
    try {
      await api('purchases.create', {
        supplierId: supplierId || null,
        invoiceNo: invoiceNo || undefined,
        purchaseDate,
        items: items.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          costPrice: Math.round(line.costPrice),
          batchNo: pharmacy ? line.batchNo || undefined : undefined,
          expiryDate: pharmacy ? line.expiryDate || null : null
        }))
      });
      notify('Purchase recorded and stock updated.', 'success');
      setLines([{ ...emptyLine }]);
      setInvoiceNo('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the purchase.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Stock & Purchases"
        subtitle="Receive stock, record supplier purchases and follow every movement of a product."
        actions={<SearchBox value={search} onChange={setSearch} placeholder="Find a product" />}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid-2">
        <Card title="Receive stock" actions={selected ? <Badge tone="gold">{selected.name}</Badge> : null}>
          <form className="stack" onSubmit={receive}>
            <div className="form-grid">
              <Field label="Product">
                <Select
                  value={selected?.id ?? ''}
                  onChange={(e) => {
                    const product = products.find((p) => p.id === Number(e.target.value));
                    if (product) void loadLedger(product);
                  }}
                  required
                >
                  <option value="">Choose a product…</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name} ({product.stockQty} in stock)
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Quantity received">
                <Input
                  type="number"
                  min={1}
                  value={receiveQty}
                  onChange={(e) => setReceiveQty(Math.max(1, Number(e.target.value)))}
                  required
                />
              </Field>
              {pharmacy ? (
                <>
                  <Field label="Batch number">
                    <Input value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder="e.g. PCM-2409" />
                  </Field>
                  <Field label="Expiry date">
                    <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                  </Field>
                </>
              ) : null}
              <Field label="Unit cost (₦)">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={costPrice / 100}
                  onChange={(e) => setCostPrice(Math.round(Number(e.target.value) * 100))}
                />
              </Field>
            </div>
            <Button type="submit" size="sm" disabled={busy || !selected}>
              Add to stock
            </Button>
            {!can('stock.receive') ? <p className="tiny muted">You do not have permission to receive stock.</p> : null}
          </form>
        </Card>

        <Card title="Recent stock movements" actions={selected ? <span className="tiny muted">{selected.sku}</span> : null}>
          <DataTable<LedgerRow>
            rows={ledger}
            empty={selected ? 'No movements for this product yet.' : 'Pick a product to see its ledger.'}
            columns={[
              { key: 'createdAt', label: 'When', render: (row) => formatDateTime(row.createdAt) },
              { key: 'type', label: 'Type' },
              {
                key: 'qtyChange',
                label: 'Change',
                align: 'right',
                render: (row) => (
                  <span style={{ color: row.qtyChange >= 0 ? '#1e7a3c' : '#b3261e', fontWeight: 600 }}>
                    {row.qtyChange > 0 ? `+${row.qtyChange}` : row.qtyChange}
                  </span>
                )
              },
              { key: 'reference', label: 'Reference', render: (row) => row.reference ?? '—' }
            ]}
          />
        </Card>
      </div>

      <Card title="Record a supplier purchase" actions={<span className="tiny muted">Stock is added in the same transaction</span>}>
        <form className="stack" onSubmit={createPurchase}>
          <div className="form-grid">
            <Field label="Supplier">
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Walk-in / not listed</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Supplier invoice no.">
              <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="e.g. INV-778" />
            </Field>
            <Field label="Purchase date">
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </Field>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="num">Qty</th>
                  <th className="num">Unit cost (₦)</th>
                  {pharmacy ? <th>Batch</th> : null}
                  {pharmacy ? <th>Expiry</th> : null}
                  <th className="num">Line total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={index}>
                    <td>
                      <Select
                        value={line.productId}
                        onChange={(e) => {
                          const product = products.find((p) => p.id === Number(e.target.value));
                          updateLine(index, {
                            productId: product?.id ?? '',
                            name: product?.name ?? '',
                            costPrice: product ? product.costPrice : line.costPrice
                          });
                        }}
                      >
                        <option value="">Choose…</option>
                        {products.map((product) => (
                          <option key={product.id} value={product.id}>
                            {product.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={1}
                        value={line.qty}
                        onChange={(e) => updateLine(index, { qty: Math.max(1, Number(e.target.value)) })}
                        style={{ width: 80 }}
                      />
                    </td>
                    <td className="num">
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={line.costPrice / 100}
                        onChange={(e) => updateLine(index, { costPrice: Math.round(Number(e.target.value) * 100) })}
                        style={{ width: 110 }}
                      />
                    </td>
                    {pharmacy ? (
                      <td>
                        <Input
                          value={line.batchNo}
                          onChange={(e) => updateLine(index, { batchNo: e.target.value })}
                          style={{ width: 110 }}
                        />
                      </td>
                    ) : null}
                    {pharmacy ? (
                      <td>
                        <Input
                          type="date"
                          value={line.expiryDate}
                          onChange={(e) => updateLine(index, { expiryDate: e.target.value })}
                          style={{ width: 140 }}
                        />
                      </td>
                    ) : null}
                    <td className="num">
                      {line.productId ? formatMoney(line.qty * Math.round(line.costPrice)) : '—'}
                    </td>
                    <td>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                        disabled={lines.length === 1}
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Button type="button" size="sm" variant="ghost" onClick={() => setLines((current) => [...current, { ...emptyLine }])}>
              Add line
            </Button>
            <div className="row tight" style={{ alignItems: 'center' }}>
              <strong>{formatMoney(purchaseTotal)}</strong>
              <Button type="submit" size="sm" disabled={busy}>
                Save purchase
              </Button>
            </div>
          </div>
        </form>
      </Card>

      <Card title="Recent purchases">
        <DataTable<PurchaseRow>
          rows={purchases}
          empty="No purchases recorded yet."
          columns={[
            { key: 'purchase_no', label: 'Purchase' },
            { key: 'purchase_date', label: 'Date', render: (row) => formatDate(row.purchase_date) },
            { key: 'supplier_name', label: 'Supplier', render: (row) => row.supplier_name ?? '—' },
            { key: 'items', label: 'Lines', align: 'right', render: (row) => String(row.items?.length ?? '—') },
            { key: 'total', label: 'Total', align: 'right', render: (row) => formatMoney(row.total) },
            { key: 'status', label: 'Status', render: (row) => <Badge tone="ok">{row.status}</Badge> }
          ]}
        />
      </Card>
    </div>
  );
}
