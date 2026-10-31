import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, isDesktop } from '../api';
import { useApi, useApp } from '../state';
import type {
  PriceLabelOptions,
  Product,
  ProductExportFile,
  ProductImportResult
} from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  Modal,
  Money,
  PageHead,
  SearchBox,
  Select
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';

const EMPTY_FORM = {
  id: 0,
  sku: '',
  barcode: '',
  name: '',
  brand: '',
  category: '',
  unit: 'unit',
  packSize: '1',
  packUnit: 'pack',
  costPrice: '',
  price: '',
  wholesalePrice: '',
  wholesaleMinQty: '1',
  reorderLevel: '0',
  rxRequired: false,
  genericName: '',
  departmentId: '' as number | '',
  shelfLocation: '',
  pluCode: '',
  pricePerKg: '',
  isWeighed: false,
  expiryTracking: false,
  openingStock: '',
  openingBatchNo: '',
  openingExpiry: ''
};

type ProductForm = typeof EMPTY_FORM;

interface DepartmentRow {
  id: number;
  name: string;
  active?: number;
}

interface BarcodeRow {
  id: number;
  barcode: string;
  pack_qty: number;
  is_primary: number;
}

interface VariantRow {
  id: number;
  variant_name: string;
  price: number;
  stock_qty: number;
}

/** Saves an exported file: desktop writes it to disk, the browser downloads it. */
async function saveExport(file: ProductExportFile): Promise<string> {
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
      ? new Blob([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        })
      : new Blob([file.data], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.filename;
  link.click();
  URL.revokeObjectURL(url);
  return file.filename;
}

async function readImportFile(file: File): Promise<{ filename: string; data: string; encoding: 'base64' | 'utf8' }> {
  const isCsv = /\.(csv|txt)$/i.test(file.name);
  if (isCsv) {
    const text = await file.text();
    return { filename: file.name, data: text, encoding: 'utf8' };
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
  }
  return { filename: file.name, data: btoa(binary), encoding: 'base64' };
}

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
  const [receiveForm, setReceiveForm] = useState({ qty: '', packs: '', weightKg: '', batchNo: '', expiry: '', costPrice: '' });
  const [importResult, setImportResult] = useState<ProductImportResult | null>(null);
  const [importFile, setImportFile] = useState<{ filename: string; data: string; encoding: 'base64' | 'utf8' } | null>(null);
  const [importing, setImporting] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [confirmToggle, setConfirmToggle] = useState<Product | null>(null);
  const [labelHtml, setLabelHtml] = useState<string | null>(null);
  const [labelOptions, setLabelOptions] = useState<PriceLabelOptions>({
    copies: 1,
    showBarcode: true,
    showPrice: true,
    showName: true
  });
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>([]);
  const [variants, setVariants] = useState<VariantRow[]>([]);
  const [newBarcode, setNewBarcode] = useState('');
  const [newVariant, setNewVariant] = useState({ name: '', price: '', stock: '' });

  const manager = can('products.manage');
  const pharmacy = Boolean(state?.features.pharmacy);
  const supermarket = Boolean(state?.features.supermarket);
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

  useEffect(() => {
    if (!supermarket) return;
    void (async () => {
      const data = await api<DepartmentRow[]>('mart.departments.list', {});
      if (data) setDepartments(data);
    })();
  }, [api, supermarket]);

  function openNew() {
    setForm({ ...EMPTY_FORM, expiryTracking: pharmacy });
    setBarcodes([]);
    setVariants([]);
  }

  async function openEdit(product: Product) {
    setForm({
      id: product.id,
      sku: product.sku,
      barcode: product.barcode ?? '',
      name: product.name,
      brand: product.brand ?? '',
      category: product.category ?? '',
      unit: product.unit,
      packSize: String(product.packSize),
      packUnit: product.packUnit,
      costPrice: moneyToInput(product.costPrice),
      price: moneyToInput(product.price),
      wholesalePrice: moneyToInput(product.wholesalePrice),
      wholesaleMinQty: String(product.wholesaleMinQty),
      reorderLevel: String(product.reorderLevel),
      rxRequired: product.rxRequired,
      genericName: product.genericName ?? '',
      departmentId: product.departmentId ?? '',
      shelfLocation: product.shelfLocation ?? '',
      pluCode: product.pluCode ?? '',
      pricePerKg: product.pricePerKg ? moneyToInput(product.pricePerKg) : '',
      isWeighed: product.isWeighed,
      expiryTracking: product.expiryTracking,
      openingStock: '',
      openingBatchNo: '',
      openingExpiry: ''
    });
    if (supermarket) {
      const [codes, variantRows] = await Promise.all([
        api<BarcodeRow[]>('mart.barcodes.list', { productId: product.id }),
        api<VariantRow[]>('mart.variants.list', { productId: product.id })
      ]);
      setBarcodes(codes ?? []);
      setVariants(variantRows ?? []);
    }
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
        brand: form.brand || null,
        category: form.category || null,
        unit: form.unit,
        packSize: Number(form.packSize) || 1,
        packUnit: form.packUnit || 'pack',
        costPrice: parseMoneyInput(form.costPrice),
        price: parseMoneyInput(form.price),
        wholesalePrice: parseMoneyInput(form.wholesalePrice || form.price),
        wholesaleMinQty: Number(form.wholesaleMinQty) || 1,
        reorderLevel: Number(form.reorderLevel) || 0,
        expiryTracking: pharmacy ? true : form.expiryTracking,
        rxRequired: prescriptions ? form.rxRequired : false,
        genericName: pharmacy ? form.genericName || null : null,
        departmentId: supermarket && form.departmentId !== '' ? Number(form.departmentId) : null,
        shelfLocation: supermarket ? form.shelfLocation || null : null,
        pluCode: supermarket ? form.pluCode || null : null,
        pricePerKg: supermarket && form.isWeighed && form.pricePerKg ? parseMoneyInput(form.pricePerKg) : null,
        isWeighed: supermarket ? form.isWeighed : false,
        ...(form.id === 0
          ? {
              openingStock: Number(form.openingStock) || 0,
              openingBatchNo: form.openingBatchNo || undefined,
              openingExpiry: form.openingExpiry || null
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
      const payload: Record<string, unknown> = {
        productId: receiveFor.id,
        costPrice: receiveForm.costPrice ? parseMoneyInput(receiveForm.costPrice) : undefined
      };
      if (receiveFor.isWeighed) {
        payload.weightKg = Number(receiveForm.weightKg);
      } else if (receiveForm.packs && receiveFor.packSize > 1) {
        payload.packs = Number(receiveForm.packs);
      } else {
        payload.qty = Number(receiveForm.qty);
      }
      if (pharmacy || receiveFor.expiryTracking) {
        payload.batchNo = receiveForm.batchNo || undefined;
        payload.expiryDate = receiveForm.expiry || null;
      }
      await call('stock.receive', payload);
      notify(`Stock received for ${receiveFor.name}.`, 'success');
      setReceiveFor(null);
      setReceiveForm({ qty: '', packs: '', weightKg: '', batchNo: '', expiry: '', costPrice: '' });
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not receive stock.', 'error');
    }
  }

  /* ---------------- import / export ---------------- */

  async function runImport(file: File, mode: 'DRY_RUN' | 'IMPORT') {
    setImporting(true);
    try {
      const parsed = await readImportFile(file);
      setImportFile(parsed);
      const result = await call<ProductImportResult>('products.import', { ...parsed, mode });
      setImportResult(result);
      if (mode === 'IMPORT') {
        notify(`${result.created} added, ${result.updated} updated.`, 'success');
        await load();
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not read that file.', 'error');
    } finally {
      setImporting(false);
    }
  }

  async function confirmImport() {
    if (!importFile) return;
    setImporting(true);
    try {
      const result = await call<ProductImportResult>('products.import', { ...importFile, mode: 'IMPORT' });
      setImportResult(result);
      notify(`${result.created} product(s) added, ${result.updated} updated.`, 'success');
      setImportFile(null);
      await load();
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Import failed.', 'error');
    } finally {
      setImporting(false);
    }
  }

  async function exportProducts(format: 'CSV' | 'XLSX') {
    try {
      const file = await call<ProductExportFile>('products.export', { format });
      const path = await saveExport(file);
      notify(`Exported ${file.rows} product(s) to ${path}`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not export products.', 'error');
    }
  }

  async function downloadTemplate() {
    try {
      const file = await call<ProductExportFile>('products.exportTemplate', {});
      const path = await saveExport(file);
      notify(`Template saved to ${path}`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not build the template.', 'error');
    }
  }

  async function printLabels() {
    try {
      const result = await call<{ html: string }>('labels.print', {
        ...labelOptions,
        productIds: selected
      });
      setLabelHtml(result.html);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not build the labels.', 'error');
    }
  }

  function toggleSelected(id: number) {
    setSelected((current) => (current.includes(id) ? current.filter((v) => v !== id) : [...current, id]));
  }

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  return (
    <div className="stack">
      <PageHead
        title={pharmacy ? 'Drugs & products' : 'Products'}
        subtitle="Codes, pack sizes and prices. Only an administrator can add products, edit costs or set prices — every change is audited with the old and new value."
        actions={
          <div className="row tight wrap">
            {manager ? (
              <>
                <Button variant="ghost" onClick={() => void downloadTemplate()}>
                  Template
                </Button>
                <Button variant="ghost" onClick={() => void exportProducts('CSV')}>
                  Export CSV
                </Button>
                <Button variant="ghost" onClick={() => void exportProducts('XLSX')}>
                  Export Excel
                </Button>
                <label className="btn btn-ghost" style={{ cursor: 'pointer' }}>
                  Import
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void runImport(file, 'DRY_RUN');
                    }}
                  />
                </label>
                <Button onClick={openNew}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                  </svg>
                  Add product
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <Card>
        <div className="row tight wrap">
          <div className="grow">
            <SearchBox value={search} onChange={setSearch} placeholder="Search name, brand, code, barcode, PLU or category" />
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
          {!manager ? <span className="tiny muted">View only — asking an administrator to change prices.</span> : null}
          <Button variant="ghost" onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </Card>

      {supermarket ? (
        <Card
          title="Bulk price labels"
          actions={
            <div className="row tight wrap">
              <label className="row tight small muted">
                <input
                  type="checkbox"
                  checked={labelOptions.showBarcode !== false}
                  onChange={(e) => setLabelOptions({ ...labelOptions, showBarcode: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                Barcode
              </label>
              <label className="row tight small muted">
                <input
                  type="checkbox"
                  checked={labelOptions.showPrice !== false}
                  onChange={(e) => setLabelOptions({ ...labelOptions, showPrice: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                Price
              </label>
              <Input
                type="number"
                min={1}
                max={50}
                value={labelOptions.copies ?? 1}
                onChange={(e) => setLabelOptions({ ...labelOptions, copies: Math.max(1, Number(e.target.value)) })}
                style={{ width: 70 }}
                title="Copies per product"
              />
              <Button size="sm" variant="ghost" onClick={() => void printLabels()}>
                {selected.length > 0 ? `Print ${selected.length} label sheet(s)` : 'Print all labels'}
              </Button>
            </div>
          }
        >
          <p className="tiny muted" style={{ margin: 0 }}>
            Tick products in the table below to label only those, or leave everything clear to label the whole
            catalogue. Copies per product multiplies each label.
          </p>
        </Card>
      ) : null}

      <Card title={`${rows.length} ${pharmacy ? 'drug(s)' : 'product(s)'}`}>
        <DataTable
          rows={rows}
          columns={[
            ...(supermarket
              ? [
                  {
                    key: 'select',
                    label: '',
                    render: (r: Product) => (
                      <input
                        type="checkbox"
                        checked={selectedSet.has(r.id)}
                        onChange={() => toggleSelected(r.id)}
                        style={{ width: 'auto' }}
                        aria-label={`Select ${r.name}`}
                      />
                    )
                  }
                ]
              : []),
            {
              key: 'name',
              label: 'Name',
              render: (r: Product) => (
                <div>
                  <div>{r.name}</div>
                  {r.brand ? <div className="tiny muted">{r.brand}</div> : null}
                </div>
              )
            },
            { key: 'sku', label: 'Code' },
            { key: 'category', label: 'Category', render: (r) => r.category ?? '—' },
            {
              key: 'pack',
              label: 'Pack',
              render: (r) => (r.packSize > 1 ? `${r.packSize} × ${r.unit} / ${r.packUnit}` : r.unit)
            },
            ...(manager
              ? [
                  {
                    key: 'costPrice',
                    label: 'Cost',
                    align: 'right' as const,
                    render: (r: Product) => <Money value={r.costPrice} />
                  }
                ]
              : []),
            { key: 'price', label: 'Selling', align: 'right', render: (r) => <Money value={r.price} /> },
            {
              key: 'wholesalePrice',
              label: 'Wholesale',
              align: 'right',
              render: (r) => (
                <div>
                  <Money value={r.wholesalePrice} />
                  <div className="tiny muted">from {r.wholesaleMinQty}</div>
                </div>
              )
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
            ...(pharmacy || supermarket
              ? [
                  {
                    key: 'nearestExpiry',
                    label: 'Nearest expiry',
                    render: (r: Product) =>
                      r.expiryTracking || pharmacy ? (r.nearestExpiry ?? '—') : <span className="muted">not tracked</span>
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
                    <Button size="sm" variant="ghost" onClick={() => void openEdit(r)}>
                      Edit
                    </Button>
                  ) : null}
                  {can('stock.receive') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReceiveFor(r);
                        setReceiveForm({ qty: '', packs: '', weightKg: '', batchNo: '', expiry: '', costPrice: '' });
                      }}
                    >
                      Receive
                    </Button>
                  ) : null}
                  {manager ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => (r.active ? setConfirmToggle(r) : void toggleActive(r))}
                    >
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
            <Field label="Brand / manufacturer">
              <Input value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} />
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
            <Field label="Unit" hint="tablet, sachet, bottle, kg…">
              <Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
            </Field>
            <Field label="Pack size" hint="Units inside one pack/carton.">
              <Input
                type="number"
                min={1}
                value={form.packSize}
                onChange={(e) => setForm({ ...form, packSize: e.target.value })}
              />
            </Field>
            <Field label="Pack name" hint="carton, pack, crate…">
              <Input value={form.packUnit} onChange={(e) => setForm({ ...form, packUnit: e.target.value })} />
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
            <Field label="Wholesale minimum qty" hint="Wholesale price applies from this quantity.">
              <Input
                type="number"
                min={1}
                value={form.wholesaleMinQty}
                onChange={(e) => setForm({ ...form, wholesaleMinQty: e.target.value })}
              />
            </Field>
            {pharmacy ? (
              <>
                <Field label="Generic name">
                  <Input value={form.genericName} onChange={(e) => setForm({ ...form, genericName: e.target.value })} />
                </Field>
                <Field label="Prescription required">
                  <Select
                    value={form.rxRequired ? 'yes' : 'no'}
                    onChange={(e) => setForm({ ...form, rxRequired: e.target.value === 'yes' })}
                  >
                    <option value="no">No — over the counter</option>
                    <option value="yes">Yes — require prescription reference</option>
                  </Select>
                </Field>
              </>
            ) : null}
            {supermarket ? (
              <>
                <Field label="Department">
                  <Select
                    value={form.departmentId}
                    onChange={(e) => setForm({ ...form, departmentId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">Not assigned</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Shelf / aisle">
                  <Input
                    value={form.shelfLocation}
                    onChange={(e) => setForm({ ...form, shelfLocation: e.target.value })}
                    placeholder="e.g. A3"
                  />
                </Field>
                <Field label="PLU code" hint="Scale code for loose produce.">
                  <Input value={form.pluCode} onChange={(e) => setForm({ ...form, pluCode: e.target.value })} />
                </Field>
                <Field label="Sold by weight">
                  <Select
                    value={form.isWeighed ? 'yes' : 'no'}
                    onChange={(e) => setForm({ ...form, isWeighed: e.target.value === 'yes' })}
                  >
                    <option value="no">No — sold by the unit</option>
                    <option value="yes">Yes — price per kg</option>
                  </Select>
                </Field>
                {form.isWeighed ? (
                  <Field label="Price per kg (₦)">
                    <Input
                      value={form.pricePerKg}
                      onChange={(e) => setForm({ ...form, pricePerKg: e.target.value })}
                      inputMode="decimal"
                    />
                  </Field>
                ) : (
                  <Field label="Track expiry" hint="Perishables get near-expiry alerts.">
                    <Select
                      value={form.expiryTracking ? 'yes' : 'no'}
                      onChange={(e) => setForm({ ...form, expiryTracking: e.target.value === 'yes' })}
                    >
                      <option value="no">No</option>
                      <option value="yes">Yes</option>
                    </Select>
                  </Field>
                )}
              </>
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
                {pharmacy || supermarket ? (
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

          {supermarket && form.id ? (
            <>
              <div className="divider" style={{ margin: '18px 0' }} />
              <h3 style={{ fontSize: 13, marginBottom: 10 }}>Extra barcodes</h3>
              <div className="row tight wrap">
                <Input
                  value={newBarcode}
                  onChange={(e) => setNewBarcode(e.target.value)}
                  placeholder="Additional barcode"
                  style={{ maxWidth: 220 }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const updated = await call<BarcodeRow[]>('mart.barcodes.add', {
                        productId: form.id,
                        barcode: newBarcode
                      });
                      setBarcodes(updated ?? []);
                      setNewBarcode('');
                      notify('Barcode added.', 'success');
                    } catch (error) {
                      notify(error instanceof Error ? error.message : 'Could not add the barcode.', 'error');
                    }
                  }}
                  disabled={newBarcode.trim().length < 4}
                >
                  Add barcode
                </Button>
              </div>
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                {barcodes.length === 0 ? (
                  <span className="tiny muted">No extra barcodes yet.</span>
                ) : (
                  barcodes.map((code) => (
                    <Badge key={code.id} tone={code.is_primary ? 'gold' : 'neutral'}>
                      {code.barcode}
                      {code.is_primary ? ' · primary' : ''}
                      {code.is_primary ? null : (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              const updated = await call<BarcodeRow[]>('mart.barcodes.remove', {
                                productId: form.id,
                                barcode: code.barcode
                              });
                              setBarcodes(updated ?? []);
                            } catch (error) {
                              notify(error instanceof Error ? error.message : 'Could not remove the barcode.', 'error');
                            }
                          }}
                          style={{ marginLeft: 6, background: 'none', border: 0, cursor: 'pointer', color: 'inherit' }}
                          aria-label={`Remove ${code.barcode}`}
                        >
                          ×
                        </button>
                      )}
                    </Badge>
                  ))
                )}
              </div>

              <h3 style={{ fontSize: 13, margin: '16px 0 10px' }}>Variants (size / flavour)</h3>
              <DataTable<VariantRow>
                rows={variants}
                empty="No variants — this product is sold as a single item."
                columns={[
                  { key: 'variant_name', label: 'Variant' },
                  { key: 'price', label: 'Price', align: 'right', render: (r) => <Money value={r.price} /> },
                  { key: 'stock_qty', label: 'Stock', align: 'right' }
                ]}
              />
              <div className="row tight wrap" style={{ marginTop: 8 }}>
                <Input
                  value={newVariant.name}
                  onChange={(e) => setNewVariant({ ...newVariant, name: e.target.value })}
                  placeholder="e.g. 1.5 L"
                  style={{ maxWidth: 160 }}
                />
                <Input
                  value={newVariant.price}
                  onChange={(e) => setNewVariant({ ...newVariant, price: e.target.value })}
                  placeholder="Price ₦"
                  inputMode="decimal"
                  style={{ maxWidth: 120 }}
                />
                <Input
                  type="number"
                  min={0}
                  value={newVariant.stock}
                  onChange={(e) => setNewVariant({ ...newVariant, stock: e.target.value })}
                  placeholder="Stock"
                  style={{ maxWidth: 100 }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!newVariant.name.trim() || !newVariant.price}
                  onClick={async () => {
                    try {
                      await call('mart.variants.save', {
                        productId: form.id,
                        variantName: newVariant.name,
                        price: parseMoneyInput(newVariant.price),
                        stockQty: Number(newVariant.stock) || 0
                      });
                      const refreshed = await call<VariantRow[]>('mart.variants.list', { productId: form.id });
                      setVariants(refreshed ?? []);
                      setNewVariant({ name: '', price: '', stock: '' });
                      notify('Variant saved.', 'success');
                    } catch (error) {
                      notify(error instanceof Error ? error.message : 'Could not save the variant.', 'error');
                    }
                  }}
                >
                  Add variant
                </Button>
              </div>
            </>
          ) : null}

          <div style={{ marginTop: 14 }}>
            <Alert tone="info">
              Prices are money-critical: each change is recorded in the audit trail with the old and new value, and
              costs stay hidden from cashiers and supervisors.
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
              <Button
                onClick={receiveStock}
                disabled={
                  receiveFor.isWeighed
                    ? !Number(receiveForm.weightKg)
                    : receiveFor.packSize > 1 && receiveForm.packs
                      ? !Number(receiveForm.packs)
                      : !Number(receiveForm.qty)
                }
              >
                Add stock
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="small muted">
              Currently {receiveFor.stockQty} {receiveFor.unit}(s)
              {manager ? ` at ${formatMoney(receiveFor.costPrice)} cost` : ''}.
            </div>
            {receiveFor.isWeighed ? (
              <Field label="Weight received (kg)">
                <Input
                  type="number"
                  min={0.001}
                  step="0.001"
                  value={receiveForm.weightKg}
                  onChange={(e) => setReceiveForm({ ...receiveForm, weightKg: e.target.value })}
                  autoFocus
                />
              </Field>
            ) : receiveFor.packSize > 1 ? (
              <>
                <Field label={`Packs received (1 ${receiveFor.packUnit} = ${receiveFor.packSize} ${receiveFor.unit})`}>
                  <Input
                    type="number"
                    min={1}
                    value={receiveForm.packs}
                    onChange={(e) => setReceiveForm({ ...receiveForm, packs: e.target.value })}
                    autoFocus
                  />
                </Field>
                <Field label={`Or loose ${receiveFor.unit}s`}>
                  <Input
                    type="number"
                    min={0}
                    value={receiveForm.qty}
                    onChange={(e) => setReceiveForm({ ...receiveForm, qty: e.target.value, packs: '' })}
                  />
                </Field>
              </>
            ) : (
              <Field label="Quantity received">
                <Input
                  type="number"
                  min={1}
                  value={receiveForm.qty}
                  onChange={(e) => setReceiveForm({ ...receiveForm, qty: e.target.value })}
                  autoFocus
                />
              </Field>
            )}
            {pharmacy || receiveFor.expiryTracking ? (
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
            {manager ? (
              <Field label="Cost price (₦)" hint="Defaults to the product's current cost.">
                <Input
                  value={receiveForm.costPrice}
                  onChange={(e) => setReceiveForm({ ...receiveForm, costPrice: e.target.value })}
                  placeholder={moneyToInput(receiveFor.costPrice)}
                />
              </Field>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {importResult ? (
        <Modal
          title={`Import report — ${importResult.mode === 'DRY_RUN' ? 'nothing saved yet' : 'imported'}`}
          size="wide"
          onClose={() => {
            setImportResult(null);
            setImportFile(null);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setImportResult(null);
                  setImportFile(null);
                }}
              >
                Close
              </Button>
              {importResult.mode === 'DRY_RUN' && importFile ? (
                <Button onClick={confirmImport} disabled={importing || importResult.validRows === 0}>
                  {importing ? 'Importing…' : `Import ${importResult.validRows} product(s)`}
                </Button>
              ) : null}
            </>
          }
        >
          <div className="stack">
            <div className="row tight wrap">
              <Badge tone="success">{importResult.validRows} ready</Badge>
              <Badge tone="neutral">{importResult.created} new</Badge>
              <Badge tone="gold">{importResult.updated} updates</Badge>
              {importResult.skipped > 0 ? <Badge tone="neutral">{importResult.skipped} unchanged</Badge> : null}
              {importResult.errors.length > 0 ? (
                <Badge tone="danger">{importResult.errors.length} problem(s)</Badge>
              ) : null}
            </div>
            {importResult.errors.length > 0 ? (
              <Alert tone="warn">
                Rows with problems are skipped; everything else still imports. Fix and re-import to pick them up.
              </Alert>
            ) : null}
            <DataTable
              rows={importResult.preview}
              empty="No valid rows in this file."
              columns={[
                { key: 'row', label: 'Row', align: 'right' },
                { key: 'sku', label: 'Code' },
                { key: 'name', label: 'Name' },
                { key: 'price', label: 'Price', align: 'right', render: (r) => <Money value={r.price} /> },
                { key: 'action', label: 'Action' }
              ]}
            />
            {importResult.errors.length > 0 ? (
              <Card title="Problems found">
                <DataTable
                  rows={importResult.errors.slice(0, 100)}
                  columns={[
                    { key: 'row', label: 'Row', align: 'right' },
                    { key: 'field', label: 'Column', render: (r) => r.field || '—' },
                    { key: 'message', label: 'Problem' }
                  ]}
                />
              </Card>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {labelHtml ? (
        <Modal title="Price labels" size="wide" onClose={() => setLabelHtml(null)}>
          <DocumentView html={labelHtml} filename="price-labels.html" title="Price labels" />
        </Modal>
      ) : null}
      {confirmToggle ? (
        <ConfirmDialog
          title="Take this product off sale?"
          confirmLabel="Deactivate"
          cancelLabel="Keep selling"
          busy={saving}
          onClose={() => setConfirmToggle(null)}
          onConfirm={() => {
            const product = confirmToggle;
            setConfirmToggle(null);
            void toggleActive(product);
          }}
        >
          <strong>{confirmToggle.name}</strong> stays in the catalogue and on old receipts, but the till will refuse to
          sell it. You can reactivate it at any time; nothing is deleted.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
