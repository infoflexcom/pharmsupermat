import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import type { Product, Sale, SaleInput } from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHead,
  SearchBox
} from '../components/ui';
import { DocumentView } from '../components/DocumentView';

interface CartLine {
  productId: number;
  name: string;
  sku: string;
  listPrice: number;
  unitPrice: number;
  qty: number;
  stockQty: number;
  rxRequired: boolean;
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Transfer',
  POS: 'POS',
  SPLIT: 'Split'
};

export default function PosPage({ mode }: { mode: 'RETAIL' | 'INVOICE' }) {
  const api = useApi();
  const { state, can, notify } = useApp();
  const features = state?.features;
  const isWholesale = mode === 'INVOICE';
  const canOverride = can('prices.override');

  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('CASH');
  const [amountPaid, setAmountPaid] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [prescriptionRef, setPrescriptionRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ html: string; sale: Sale } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const loadProducts = useCallback(
    async (term: string) => {
      const list = await api<Product[]>('products.list', { search: term, limit: 60 });
      if (Array.isArray(list)) setProducts(list);
    },
    [api]
  );

  useEffect(() => {
    void loadProducts('');
  }, [loadProducts]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(search), 180);
    return () => window.clearTimeout(timer);
  }, [search, loadProducts]);

  const priceFor = useCallback(
    (product: Product) => (isWholesale ? product.wholesalePrice || product.price : product.price),
    [isWholesale]
  );

  function addToCart(product: Product) {
    if (!product.active) return;
    if (product.stockQty <= 0) {
      notify(`${product.name} is out of stock.`, 'error');
      return;
    }
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (existing) {
        if (existing.qty >= product.stockQty) {
          notify(`Only ${product.stockQty} of ${product.name} in stock.`, 'error');
          return current;
        }
        return current.map((line) =>
          line.productId === product.id ? { ...line, qty: line.qty + 1 } : line
        );
      }
      return [
        ...current,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          listPrice: priceFor(product),
          unitPrice: priceFor(product),
          qty: 1,
          stockQty: product.stockQty,
          rxRequired: product.rxRequired
        }
      ];
    });
  }

  async function handleBarcode(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    const match = await api<Product | null>('products.lookup', { code: term });
    if (match) {
      addToCart(match);
      setSearch('');
    } else if (products.length === 1) {
      addToCart(products[0]);
      setSearch('');
    }
  }

  function updateQty(productId: number, qty: number) {
    setCart((current) =>
      current
        .map((line) =>
          line.productId === productId
            ? { ...line, qty: Math.max(0, Math.min(qty, line.stockQty)) }
            : line
        )
        .filter((line) => line.qty > 0)
    );
  }

  function updatePrice(productId: number, input: string) {
    const value = parseMoneyInput(input);
    setCart((current) =>
      current.map((line) => (line.productId === productId ? { ...line, unitPrice: value } : line))
    );
  }

  const subtotal = useMemo(
    () => cart.reduce((sum, line) => sum + line.unitPrice * line.qty, 0),
    [cart]
  );
  const discountValue = Math.min(parseMoneyInput(discount), subtotal);
  const total = subtotal - discountValue;
  const paid = amountPaid === '' ? total : parseMoneyInput(amountPaid);
  const change = paid - total;
  const needsPrescription = features?.prescriptions && cart.some((line) => line.rxRequired);

  useEffect(() => {
    setAmountPaid(moneyToInput(total));
  }, [total]);

  function resetSale() {
    setCart([]);
    setDiscount('');
    setPaymentMethod('CASH');
    setCustomerName('');
    setCustomerPhone('');
    setCustomerAddress('');
    setPrescriptionRef('');
    setNote('');
    setError(null);
    setAmountPaid('');
    searchRef.current?.focus();
  }

  async function checkout() {
    setError(null);
    if (cart.length === 0) return setError('Add at least one item.');
    if (paid < total) return setError('Amount paid is less than the total.');
    if (isWholesale && !customerName.trim()) return setError('Enter the wholesale customer name.');
    if (needsPrescription && !prescriptionRef.trim())
      return setError('A prescription reference is required for prescription items.');
    const override = cart.find((line) => line.unitPrice !== line.listPrice);
    if (override && !canOverride) {
      return setError('A price override needs a supervisor. Ask an approver to sign in.');
    }

    setBusy(true);
    try {
      const payload: SaleInput = {
        docType: isWholesale ? 'INVOICE' : 'RECEIPT',
        lines: cart.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          ...(line.unitPrice !== line.listPrice ? { unitPrice: line.unitPrice } : {})
        })),
        discount: discountValue,
        paymentMethod: paymentMethod as SaleInput['paymentMethod'],
        amountPaid: paid,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        customerAddress: customerAddress || undefined,
        prescriptionRef: prescriptionRef || undefined,
        note: note || undefined
      };
      const sale = await call<Sale>('sales.create', payload as unknown as Record<string, unknown>);
      const document = await call<{ html: string; sale: Sale }>('sales.document', { id: sale.id });
      setReceipt(document);
      resetSale();
      void loadProducts(search);
      notify(`${isWholesale ? 'Invoice' : 'Sale'} ${sale.receiptNo} completed.`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the sale.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHead
        title={isWholesale ? 'Wholesale invoice' : 'Point of sale'}
        subtitle={
          isWholesale
            ? 'Raise an invoice at wholesale prices. Stock and receipts use the same ledger as retail.'
            : `${features?.itemLabel ?? 'Item'} search, barcode entry and instant receipts.`
        }
        actions={
          <div className="row tight">
            <Badge tone="gold">{isWholesale ? 'WHOLESALE' : 'RETAIL'}</Badge>
            <Button variant="ghost" size="sm" onClick={resetSale}>
              Clear
            </Button>
          </div>
        }
      />

      <div className="pos-grid">
        <Card>
          <div className="row tight">
            <div className="grow">
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder={`Search name, code or scan barcode, then press Enter`}
                autoFocus
                onKeyDown={handleBarcode}
              />
            </div>
            <Button variant="ghost" size="sm" onClick={() => void loadProducts(search)}>
              Refresh
            </Button>
          </div>

          <div className="product-grid">
            {products.length === 0 ? (
              <div className="empty" style={{ gridColumn: '1 / -1' }}>
                No products found. An administrator can add {features?.itemLabel.toLowerCase() ?? 'items'} under
                Products.
              </div>
            ) : (
              products.map((product) => {
                const disabled = !product.active || product.stockQty <= 0;
                return (
                  <button
                    key={product.id}
                    className={`product-tile ${disabled ? 'disabled' : ''}`}
                    onClick={() => addToCart(product)}
                    disabled={disabled}
                    type="button"
                  >
                    <span className="pname">{product.name}</span>
                    <span className="pmeta">
                      {product.sku}
                      {product.barcode ? ` · ${product.barcode}` : ''}
                    </span>
                    <span className="pmeta">
                      {product.stockQty > 0 ? `${product.stockQty} in stock` : 'Out of stock'}
                      {features?.pharmacy && product.nearestExpiry ? ` · exp ${product.nearestExpiry}` : ''}
                    </span>
                    <span className="pprice">{formatMoney(priceFor(product))}</span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        <div className="cart">
          <Card title={`Basket (${cart.reduce((n, l) => n + l.qty, 0)} items)`}>
            <div className="cart-list">
              {cart.length === 0 ? (
                <div className="empty">Tap a {features?.itemLabel.toLowerCase() ?? 'product'} to start a sale.</div>
              ) : (
                cart.map((line) => (
                  <div className="cart-line" key={line.productId}>
                    <div>
                      <div className="name">{line.name}</div>
                      <div className="tiny muted">
                        {line.sku} · {formatMoney(line.listPrice)} list
                      </div>
                    </div>
                    <div className="row tight" style={{ alignItems: 'flex-start' }}>
                      <div className="qty-control">
                        <button type="button" onClick={() => updateQty(line.productId, line.qty - 1)}>
                          −
                        </button>
                        <span>{line.qty}</span>
                        <button type="button" onClick={() => updateQty(line.productId, line.qty + 1)}>
                          +
                        </button>
                      </div>
                      <div style={{ textAlign: 'right', minWidth: 92 }}>
                        <div style={{ fontWeight: 700 }}>{formatMoney(line.unitPrice * line.qty)}</div>
                        {canOverride ? (
                          <input
                            aria-label={`Unit price for ${line.name}`}
                            value={moneyToInput(line.unitPrice)}
                            onChange={(e) => updatePrice(line.productId, e.target.value)}
                            style={{ width: 92, padding: '3px 6px', fontSize: 11.5, marginTop: 4 }}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="totals-box" style={{ marginTop: 12 }}>
              <div className="line">
                <span>Subtotal</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              <div className="line">
                <span>Discount</span>
                <input
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="0.00"
                  style={{ width: 110, padding: '4px 8px', textAlign: 'right' }}
                />
              </div>
              <div className="line total">
                <span>Total</span>
                <span>{formatMoney(total)}</span>
              </div>
            </div>
          </Card>

          <Card title="Payment">
            <div className="stack" style={{ gap: 10 }}>
              <div className="payment-methods">
                {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={paymentMethod === value ? 'active' : ''}
                    onClick={() => setPaymentMethod(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Field label="Amount paid (₦)">
                <Input
                  value={amountPaid}
                  onChange={(e) => setAmountPaid(e.target.value)}
                  inputMode="decimal"
                  style={{ textAlign: 'right', fontWeight: 700, fontSize: 16 }}
                />
              </Field>
              <div className="change-due">
                <span>Change due</span>
                <span>{formatMoney(Math.max(change, 0))}</span>
              </div>

              {isWholesale ? (
                <>
                  <Field label="Customer / business name">
                    <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
                  </Field>
                  <div className="form-grid two">
                    <Field label="Phone">
                      <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
                    </Field>
                    <Field label="Address">
                      <Input value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} />
                    </Field>
                  </div>
                </>
              ) : null}

              {features?.prescriptions ? (
                <Field
                  label="Prescription reference"
                  hint={needsPrescription ? 'Required for prescription-only items.' : 'Optional'}
                >
                  <Input
                    value={prescriptionRef}
                    onChange={(e) => setPrescriptionRef(e.target.value)}
                    placeholder="e.g. RX-10432"
                  />
                </Field>
              ) : null}

              {!isWholesale ? (
                <Field label="Note (optional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Printed on the receipt" />
                </Field>
              ) : null}

              {error ? <Alert tone="error">{error}</Alert> : null}

              <Button variant="gold" block onClick={checkout} disabled={busy || cart.length === 0}>
                {busy ? 'Processing…' : `Complete ${isWholesale ? 'invoice' : 'sale'} · ${formatMoney(total)}`}
              </Button>
              <div className="tiny muted center">
                Stock is deducted and the receipt is numbered in a single database transaction.
              </div>
            </div>
          </Card>
        </div>
      </div>

      {receipt ? (
        <Modal
          title={`${receipt.sale.docType === 'INVOICE' ? 'Invoice' : 'Receipt'} ${receipt.sale.receiptNo}`}
          size="wide"
          onClose={() => setReceipt(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setReceipt(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setReceipt(null);
                  searchRef.current?.focus();
                }}
              >
                New sale
              </Button>
            </>
          }
        >
          <Alert tone="success">
            {receipt.sale.docType === 'INVOICE' ? 'Invoice' : 'Sale'} completed · change due{' '}
            {formatMoney(receipt.sale.changeDue)}
          </Alert>
          <div style={{ marginTop: 14 }}>
            <DocumentView
              html={receipt.html}
              filename={`${receipt.sale.receiptNo}.html`}
              title={`${receipt.sale.docType === 'INVOICE' ? 'Invoice' : 'Receipt'} ${receipt.sale.receiptNo}`}
            />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
