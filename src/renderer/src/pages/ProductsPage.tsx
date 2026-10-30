import { useCallback, useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Product } from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  Modal,
  Money,
  PageHead,
  SearchBox,
  Select
} from '../components/ui';

const EMPTY_FORM = {
  id: 0,
  sku: '',
  barcode: '',
  name: '',
  category: '',
  unit: 'unit',
  costPrice: '',
  price: '',
  wholesalePrice: '',
  reorderLevel: '0',
  rxRequired: false,
  openingStock: '',
  openingBatchNo: '',
  openingExpiry: ''
};

type ProductForm = typeof EMPTY_FORM;

export default function ProductsPage() {
  const api = useApi();
  const { state, can, notify } = useApp();
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [rows, setRows] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<ProductForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiveFor, setReceiveFor] = useState<Product | null>(null);
  const [receiveForm, setReceiveForm] = useState({ qty: '', batchNo: '', expiry: '', costPrice: '' });
  const manager = can('products.manage');
  const pharmacy = Boolean(state?.features.pharmacy);
  const prescriptions = Boolean(state?.features.prescriptions);

  const load = useCallback(async () => {
    setLoading(true);
    const data = await api<Product[]>('products.list', {
      search: search || undefined,
      includeInactive,
      limit: 500
    });
    if (data) setRows(data);
    setLoading(false);
  }, [api, search, includeInactive]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  function openNew() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(product: Product) {
    setForm({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode ?? '',
      name: product.name,
      category: product.category ?? '',
      unit: product.unit,
      costPrice: moneyToInput(product.costPrice),
      price: moneyToInput(product.price),
      wholesalePrice: moneyToInput(product.wholesalePrice),
      reorderLevel: String(product.reorderLevel),
      rxRequired: product.rxRequired,
      openingStock: '',
      openingBatchNo: '',
      openingExpiry: ''
    });
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const payload = {
        id: form.id || undefined,
        sku: form.sku || undefined,
        barcode: form.barcode || null,
        name: form.name,
        category: form.category || null,
        unit: form.unit,
        costPrice: parseMoneyInput(form.costPrice),
        price: parseMoneyInput(form.price),
        wholesalePrice: parseMoneyInput(form.wholesalePrice || form.price),
        reorderLevel: Number(form.reorderLevel) || 0,
        rxRequired: prescriptions ? form.rxRequired : false,
        ...(form.id === 0
          ? {
              openingStock: Number(form.openingStock) || 0,
              openingBatchNo: form.openingBatchNo || undefined,
              openingExpiry: pharmacy && form.openingExpiry ? form.openingExpiry : null
            }
          : {})
      };
      await call(form.id ? 'products.update' : 'products.create', payload);
      notify(form.id ? 'Product updated.' : 'Product added.', 'success');
      setForm(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save the product.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(product: Product) {
    try {
      await call('products.setActive', { id: product.id, active: !product.active });
      notify(product.active ? 'Product deactivated.' : 'Product reactivated.', 'success');
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update the product.', 'error');
    }
  }

  async function receiveStock() {
    if (!receiveFor) return;
    try {
      await call('stock.receive', {
        productId: receiveFor.id,
        qty: Number(receiveForm.qty),
        batchNo: pharmacy ? receiveForm.batchNo || undefined : undefined,
        expiryDate: pharmacy && receiveForm.expiry ? receiveForm.expiry : null,
        costPrice: receiveForm.costPrice ? parseMoneyInput(receiveForm.costPrice) : undefined
      });
      notify(`Stock received for ${receiveFor.name}.`, 'success');
      setReceiveFor(null);
      setReceiveForm({ qty: '', batchNo: '', expiry: '', costPrice: '' });
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not receive stock.', 'error');
    }
  }

  return (
    <div className="stack">
      <PageHead
        title={pharmacy ? 'Drugs & products' : 'Products'}
        subtitle="Codes, prices and reorder levels. Only an administrator can add products or set prices — every price change is audited."
        actions={
          manager ? (
            <Button onClick={openNew}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M12 5v14M5 12h14" strokeLinecap="round" />
              </svg>
              Add product
            </Button>
          ) : null
        }
      />

      <Card>
        <div className="row tight wrap">
          <div className="grow">
            <SearchBox value={search} onChange={setSearch} placeholder="Search name, code, barcode or category" />
          </div>
          <label className="row tight small muted">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              style={{ width: 'auto' }}
            />
            Include inactive
          </label>
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card title={`${rows.length} ${pharmacy ? 'drug(s)' : 'product(s)'}`}>
        <DataTable
          rows={rows}
          columns={[
            { key: 'name', label: 'Name' },
            { key: 'sku', label: 'Code' },
            { key: 'category', label: 'Category', render: (r) => r.category ?? '—' },
            { key: 'costPrice', label: 'Cost', align: 'right', render: (r) => <Money value={r.costPrice} /> },
            { key: 'price', label: 'Selling', align: 'right', render: (r) => <Money value={r.price} /> },
            {
              key: 'wholesalePrice',
              label: 'Wholesale',
              align: 'right',
              render: (r) => <Money value={r.wholesalePrice} />
            },
            {
              key: 'stockQty',
              label: 'Stock',
              align: 'right',
              render: (r) =>
                r.stockQty <= 0 ? (
                  <Badge tone="danger">0</Badge>
                ) : r.stockQty <= r.reorderLevel ? (
                  <Badge tone="warn">{r.stockQty}</Badge>
                ) : (
                  <span>{r.stockQty}</span>
                )
            },
            ...(pharmacy
              ? [
                  {
                    key: 'nearestExpiry',
                    label: 'Nearest expiry',
                    render: (r: Product) => r.nearestExpiry ?? '—'
                  }
                ]
              : []),
            {
              key: 'active',
              label: 'Status',
              render: (r) => (r.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>)
            },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (r) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  {manager ? (
                    <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
                      Edit
                    </Button>
                  ) : null}
                  {can('stock.receive') ? (
                    <Button size="sm" variant="ghost" onClick={() => setReceiveFor(r)}>
                      Receive
                    </Button>
                  ) : null}
                  {manager ? (
                    <Button size="sm" variant="ghost" onClick={() => void toggleActive(r)}>
                      {r.active ? 'Deactivate' : 'Activate'}
                    </Button>
                  ) : null}
                </div>
              )
            }
          ]}
          empty={loading ? 'Loading…' : 'No products yet. Add your first product to start selling.'}
        />
      </Card>

      {form ? (
        <Modal
          title={form.id ? 'Edit product' : 'Add product'}
          size="wide"
          onClose={() => setForm(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || !form.name.trim()}>
                {saving ? 'Saving…' : 'Save product'}
              </Button>
            </>
          }
        >
          <div className="form-grid">
            <Field label="Name" hint="As it should appear on receipts.">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            </Field>
            <Field label="Product code / SKU" hint="Leave blank to generate one.">
              <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
            </Field>
            <Field label="Barcode">
              <Input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
            </Field>
            <Field label="Category">
              <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </Field>
            <Field label="Unit">
              <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="pack, carton, sachet…" />
            </Field>
            <Field label="Reorder level" hint="Alert when stock drops to this level.">
              <Input
                type="number"
                min={0}
                value={form.reorderLevel}
                onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })}
              />
            </Field>
            <Field label="Cost price (₦)">
              <Input value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="Selling price (₦)">
              <Input value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} inputMode="decimal" />
            </Field>
            <Field label="Wholesale price (₦)">
              <Input
                value={form.wholesalePrice}
                onChange={(e) => setForm({ ...form, wholesalePrice: e.target.value })}
                inputMode="decimal"
              />
            </Field>
            {prescriptions ? (
              <Field label="Prescription required">
                <Select
                  value={form.rxRequired ? 'yes' : 'no'}
                  onChange={(e) => setForm({ ...form, rxRequired: e.target.value === 'yes' })}
                >
                  <option value="no">No — over the counter</option>
                  <option value="yes">Yes — require prescription reference</option>
                </Select>
              </Field>
            ) : null}
          </div>

          {form.id === 0 ? (
            <>
              <div className="divider" style={{ margin: '18px 0' }} />
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Opening stock</h3>
              <div className="form-grid">
                <Field label="Quantity" hint="Optional; stock is otherwise received later.">
                  <Input
                    type="number"
                    min={0}
                    value={form.openingStock}
                    onChange={(e) => setForm({ ...form, openingStock: e.target.value })}
                  />
                </Field>
                {pharmacy ? (
                  <>
                    <Field label="Batch number">
                      <Input
                        value={form.openingBatchNo}
                        onChange={(e) => setForm({ ...form, openingBatchNo: e.target.value })}
                      />
                    </Field>
                    <Field label="Expiry date">
                      <Input
                        type="date"
                        value={form.openingExpiry}
                        onChange={(e) => setForm({ ...form, openingExpiry: e.target.value })}
                      />
                    </Field>
                  </>
                ) : null}
              </div>
            </>
          ) : null}

          <div style={{ marginTop: 14 }}>
            <Alert tone="info">
              Prices are money-critical: each change is recorded in the audit trail with the old and new value.
            </Alert>
          </div>
        </Modal>
      ) : null}

      {receiveFor ? (
        <Modal
          title={`Receive stock — ${receiveFor.name}`}
          size="sm"
          onClose={() => setReceiveFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReceiveFor(null)}>
                Cancel
              </Button>
              <Button onClick={receiveStock} disabled={!Number(receiveForm.qty)}>
                Add stock
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="small muted">
              Currently {receiveFor.stockQty} {receiveFor.unit}(s) in stock at {formatMoney(receiveFor.costPrice)} cost.
            </div>
            <Field label="Quantity received">
              <Input
                type="number"
                min={1}
                value={receiveForm.qty}
                onChange={(e) => setReceiveForm({ ...receiveForm, qty: e.target.value })}
                autoFocus
              />
            </Field>
            {pharmacy ? (
              <div className="form-grid two">
                <Field label="Batch number">
                  <Input
                    value={receiveForm.batchNo}
                    onChange={(e) => setReceiveForm({ ...receiveForm, batchNo: e.target.value })}
                    placeholder="e.g. PCM-2211"
                  />
                </Field>
                <Field label="Expiry date">
                  <Input
                    type="date"
                    value={receiveForm.expiry}
                    onChange={(e) => setReceiveForm({ ...receiveForm, expiry: e.target.value })}
                  />
                </Field>
              </div>
            ) : null}
            <Field label="Cost price (₦)" hint="Defaults to the product's current cost.">
              <Input
                value={receiveForm.costPrice}
                onChange={(e) => setReceiveForm({ ...receiveForm, costPrice: e.target.value })}
                placeholder={moneyToInput(receiveFor.costPrice)}
              />
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
