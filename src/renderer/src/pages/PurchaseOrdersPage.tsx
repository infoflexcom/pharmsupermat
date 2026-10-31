import { useCallback, useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Product } from '../../../shared/types';
import { formatMoney } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  formatDate,
  formatDateTime,
  Input,
  Modal,
  Money,
  PageHead,
  Select
} from '../components/ui';

interface SupplierRow {
  id: number;
  name: string;
}

interface PurchaseRow {
  id: number;
  purchase_no: string;
  grn_no: string | null;
  supplier_name: string | null;
  purchase_date: string;
  ordered_at: string | null;
  received_at: string | null;
  total: number;
  status: string;
}

interface PurchaseDetail extends PurchaseRow {
  items: { id: number; name: string; qty: number; cost_price: number; batch_no: string | null; expiry_date: string | null }[];
}

interface DraftLine {
  productId: number | '';
  qty: number;
  costPrice: number;
}

const emptyLine: DraftLine = { productId: '', qty: 1, costPrice: 0 };

/**
 * Supplier purchase orders and goods-received notes. An order is saved without
 * touching stock; receiving it posts the stock, writes the GRN number and closes
 * the order in one transaction.
 */
export default function PurchaseOrdersPage() {
  const api = useApi();
  const { state, can, notify } = useApp();
  const pharmacy = Boolean(state?.features.pharmacy);

  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [orders, setOrders] = useState<PurchaseRow[]>([]);
  const [supplierId, setSupplierId] = useState<number | ''>('');
  const [orderDate, setOrderDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([{ ...emptyLine }]);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<PurchaseRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<PurchaseDetail | null>(null);
  const [receiveFor, setReceiveFor] = useState<PurchaseRow | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');

  const load = useCallback(async () => {
    const [list, sup, pur] = await Promise.all([
      api<Product[]>('products.list', { limit: 500 }),
      api<SupplierRow[]>('directory.suppliers.list', {}),
      api<PurchaseRow[]>('purchases.list', { limit: 60 })
    ]);
    if (list) setProducts(list);
    if (sup) setSuppliers(sup);
    if (pur) setOrders(pur);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const orderTotal = useMemo(
    () => lines.reduce((sum, line) => sum + (line.productId ? line.qty * line.costPrice : 0), 0),
    [lines]
  );

  function updateLine(index: number, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function createOrder(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const items = lines.filter((line) => line.productId);
    if (items.length === 0) return setError('Add at least one product to the order.');
    setBusy(true);
    try {
      await call('purchases.createOrder', {
        supplierId: supplierId || null,
        purchaseDate: orderDate,
        note: note || undefined,
        items: items.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          costPrice: Math.round(line.costPrice)
        }))
      });
      notify('Purchase order saved. Receive it when the goods arrive.', 'success');
      setLines([{ ...emptyLine }]);
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the order.');
    } finally {
      setBusy(false);
    }
  }

  async function receive() {
    if (!receiveFor) return;
    setBusy(true);
    setError(null);
    try {
      await call('purchases.receiveOrder', {
        id: receiveFor.id,
        invoiceNo: invoiceNo || undefined,
        purchaseDate: new Date().toISOString().slice(0, 10)
      });
      notify('Goods received — stock updated and GRN issued.', 'success');
      setReceiveFor(null);
      setInvoiceNo('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not receive the order.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(order: PurchaseRow) {
    try {
      await call('purchases.cancelOrder', { id: order.id });
      notify('Order cancelled.', 'success');
      await load();
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not cancel the order.', 'error');
    }
  }

  async function open(order: PurchaseRow) {
    try {
      const data = await api<PurchaseDetail>('purchases.get', { id: order.id });
      setDetail(data);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not open the order.', 'error');
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Purchase orders"
        subtitle="Order from a supplier, then receive the goods to post stock and issue a goods-received note."
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      {can('prices.set') ? (
        <Card title="New purchase order" actions={<span className="tiny muted">Nothing hits stock until it is received</span>}>
          <form className="stack" onSubmit={createOrder}>
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
              <Field label="Order date">
                <Input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
              </Field>
              <Field label="Note">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
              </Field>
            </div>

            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="num">Qty</th>
                    <th className="num">Unit cost (₦)</th>
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
                            updateLine(index, { productId: product?.id ?? '', costPrice: product?.costPrice ?? 0 });
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
                          style={{ width: 120 }}
                        />
                      </td>
                      <td className="num">{line.productId ? formatMoney(line.qty * line.costPrice) : '—'}</td>
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
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setLines((current) => [...current, { ...emptyLine }])}
              >
                Add line
              </Button>
              <div className="row tight" style={{ alignItems: 'center' }}>
                <strong>{formatMoney(orderTotal)}</strong>
                <Button type="submit" size="sm" disabled={busy}>
                  Save order
                </Button>
              </div>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="Orders and goods received">
        <DataTable<PurchaseRow>
          rows={orders}
          empty="No purchase orders yet."
          onRowClick={(row) => void open(row)}
          columns={[
            { key: 'purchase_no', label: 'Order' },
            { key: 'supplier_name', label: 'Supplier', render: (row) => row.supplier_name ?? '—' },
            { key: 'purchase_date', label: 'Date', render: (row) => formatDate(row.purchase_date) },
            {
              key: 'status',
              label: 'Status',
              render: (row) => (
                <Badge
                  tone={
                    row.status === 'RECEIVED' ? 'success' : row.status === 'CANCELLED' ? 'neutral' : 'warn'
                  }
                >
                  {row.status === 'DRAFT' ? 'ORDERED' : row.status}
                </Badge>
              )
            },
            { key: 'grn_no', label: 'GRN', render: (row) => row.grn_no ?? '—' },
            {
              key: 'received_at',
              label: 'Received',
              render: (row) => (row.received_at ? formatDateTime(row.received_at) : '—')
            },
            { key: 'total', label: 'Total', align: 'right', render: (row) => <Money value={row.total} /> },
            {
              key: 'actions',
              label: '',
              align: 'right',
              render: (row) => (
                <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                  {row.status === 'DRAFT' && can('stock.receive') ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          setConfirmCancel(row);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation();
                          setReceiveFor(row);
                          setInvoiceNo('');
                        }}
                      >
                        Receive
                      </Button>
                    </>
                  ) : null}
                </div>
              )
            }
          ]}
        />
      </Card>

      {detail ? (
        <Modal title={`Order ${detail.purchase_no}`} size="wide" onClose={() => setDetail(null)}>
          <div className="stack">
            <div className="row tight wrap">
              <Badge tone="neutral">{detail.supplier_name ?? 'No supplier'}</Badge>
              <Badge tone={detail.status === 'RECEIVED' ? 'success' : 'warn'}>{detail.status}</Badge>
              {detail.grn_no ? <Badge tone="gold">GRN {detail.grn_no}</Badge> : null}
            </div>
            <DataTable
              rows={detail.items}
              empty="No lines."
              columns={[
                { key: 'name', label: 'Item' },
                { key: 'qty', label: 'Qty', align: 'right' },
                { key: 'cost_price', label: 'Unit cost', align: 'right', render: (r) => <Money value={r.cost_price} /> },
                ...(pharmacy
                  ? [
                      { key: 'batch_no', label: 'Batch', render: (r: { batch_no: string | null }) => r.batch_no ?? '—' },
                      {
                        key: 'expiry_date',
                        label: 'Expiry',
                        render: (r: { expiry_date: string | null }) => (r.expiry_date ? formatDate(r.expiry_date) : '—')
                      }
                    ]
                  : [])
              ]}
            />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <strong>{formatMoney(detail.total)}</strong>
            </div>
          </div>
        </Modal>
      ) : null}

      {receiveFor ? (
        <Modal
          title={`Receive ${receiveFor.purchase_no}`}
          size="sm"
          onClose={() => setReceiveFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReceiveFor(null)}>
                Cancel
              </Button>
              <Button onClick={receive} disabled={busy}>
                Receive goods
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="info">
              Stock is added now and a goods-received note number is issued. This cannot be undone — reverse a mistake
              with a stock adjustment.
            </Alert>
            <Field label="Supplier invoice no." hint="Optional — printed on the GRN.">
              <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} autoFocus />
            </Field>
          </div>
        </Modal>
      ) : null}
      {confirmCancel ? (
        <ConfirmDialog
          title="Cancel this order?"
          confirmLabel="Cancel order"
          cancelLabel="Keep order"
          busy={busy}
          onClose={() => setConfirmCancel(null)}
          onConfirm={() => {
            const order = confirmCancel;
            setConfirmCancel(null);
            void cancel(order);
          }}
        >
          Order <strong>{confirmCancel.purchase_no}</strong> will be marked cancelled. Received stock is not affected. You
          can raise a new order at any time.
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
