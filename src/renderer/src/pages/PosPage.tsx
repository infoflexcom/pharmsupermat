import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, ApiClientError } from '../api';
import { useApi, useApp } from '../state';
import type {
  CustomerBalance,
  HeldSale,
  PaymentMethod,
  PosConfig,
  PriceTier,
  Product,
  ReceiptLayout,
  Sale,
  SaleDocumentPayload,
  SaleInput,
  SaleQuote
} from '../../../shared/types';
import { RECEIPT_LAYOUTS } from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageHead, SearchBox, Select } from '../components/ui';
import { DocumentView } from '../components/DocumentView';

interface CartLine {
  productId: number;
  name: string;
  sku: string;
  listPrice: number;
  unitPrice: number;
  /** Units for normal goods, grams for weighed goods (kept as an integer). */
  qty: number;
  stockQty: number;
  rxRequired: boolean;
  isWeighed?: boolean;
  /** Manual discount on this line, in kobo. */
  lineDiscount?: number;
}

interface TenderRow {
  method: Exclude<PaymentMethod, 'SPLIT'>;
  amount: number;
}

interface MemberRow {
  id: number;
  name: string;
  memberNo: string;
  phone: string | null;
  points: number;
}

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  address: string | null;
  creditLimit: number;
}

/** Line money: weighed goods are priced per kilogram, qty is in grams. */
function lineTotalOf(line: CartLine): number {
  const gross = line.isWeighed ? Math.round((line.unitPrice * line.qty) / 1000) : line.unitPrice * line.qty;
  return Math.max(0, gross - (line.lineDiscount ?? 0));
}

function lineGrossOf(line: CartLine): number {
  return line.isWeighed ? Math.round((line.unitPrice * line.qty) / 1000) : line.unitPrice * line.qty;
}

function lineQtyLabel(line: CartLine): string {
  return line.isWeighed ? `${(line.qty / 1000).toFixed(3)} kg` : String(line.qty);
}

const PAYMENT_LABELS: Record<string, string> = {
  CASH: 'Cash',
  TRANSFER: 'Transfer',
  POS: 'POS / Card',
  CREDIT: 'Credit'
};

export default function PosPage({ mode }: { mode: 'RETAIL' | 'INVOICE' }) {
  const api = useApi();
  const { state, notify } = useApp();
  const features = state?.features;

  const [config, setConfig] = useState<PosConfig | null>(null);
  const [tier, setTier] = useState<PriceTier>(mode === 'INVOICE' ? 'WHOLESALE' : 'RETAIL');
  const [search, setSearch] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState('');
  const [quote, setQuote] = useState<SaleQuote | null>(null);
  const [method, setMethod] = useState<Exclude<PaymentMethod, 'SPLIT'>>('CASH');
  const [split, setSplit] = useState(false);
  const [tender, setTender] = useState<TenderRow[]>([{ method: 'CASH', amount: 0 }]);
  const [amountPaid, setAmountPaid] = useState('');
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerHits, setCustomerHits] = useState<CustomerRow[]>([]);
  const [customerBalance, setCustomerBalance] = useState<CustomerBalance | null>(null);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [prescriptionRef, setPrescriptionRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<SaleDocumentPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [weighFor, setWeighFor] = useState<Product | null>(null);
  const [weightInput, setWeightInput] = useState('');
  const [holds, setHolds] = useState<HeldSale[]>([]);
  const [holdsOpen, setHoldsOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberHits, setMemberHits] = useState<MemberRow[]>([]);
  const [member, setMember] = useState<MemberRow | null>(null);
  const [redeemPoints, setRedeemPoints] = useState('');
  const [approvalOpen, setApprovalOpen] = useState<{ reason: string; purpose: 'PRICE_OVERRIDE' | 'DISCOUNT' } | null>(null);
  const [approver, setApprover] = useState({ username: '', password: '' });
  const [approving, setApproving] = useState(false);
  const [layout, setLayout] = useState<ReceiptLayout>('THERMAL_80');
  const [showDisplay, setShowDisplay] = useState(false);
  const [openingFloat, setOpeningFloat] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const draftKey = `infoflex.cart.${mode}`;
  const isWholesale = tier === 'WHOLESALE';

  const loadConfig = useCallback(async () => {
    try {
      const next = await api<PosConfig>('pos.config', {});
      if (next) {
        setConfig(next);
        setLayout(next.receiptLayout);
        const firstEnabled = next.paymentMethods.find((m) => m.enabled && m.method !== 'CREDIT');
        if (firstEnabled) {
          setMethod(firstEnabled.method as Exclude<PaymentMethod, 'SPLIT'>);
          setTender([{ method: firstEnabled.method as Exclude<PaymentMethod, 'SPLIT'>, amount: 0 }]);
        }
      }
    } catch {
      /* the till still works with defaults; the server enforces everything */
    }
  }, [api]);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

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

  /** The basket survives a licence lock, a reload or a crash. */
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as CartLine[];
      if (Array.isArray(parsed) && parsed.length > 0) setCart(parsed);
    } catch {
      /* ignore a corrupt draft */
    }
  }, [draftKey]);

  useEffect(() => {
    try {
      if (cart.length > 0) window.localStorage.setItem(draftKey, JSON.stringify(cart));
      else window.localStorage.removeItem(draftKey);
    } catch {
      /* storage may be unavailable */
    }
  }, [cart, draftKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProducts(search), 180);
    return () => window.clearTimeout(timer);
  }, [search, loadProducts]);

  const priceFor = useCallback(
    (product: Product) => {
      if (product.isWeighed && product.pricePerKg) return product.pricePerKg;
      if (isWholesale && product.wholesalePrice && product.wholesalePrice < product.price) {
        return product.wholesalePrice;
      }
      return product.price;
    },
    [isWholesale]
  );

  /* ---------------- pricing: the server is the source of truth ---------------- */

  const discountValue = parseMoneyInput(discount);
  const redeem = Number(redeemPoints) || 0;

  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await api<SaleQuote>('pos.quote', {
          lines: cart.map((line) => ({
            productId: line.productId,
            qty: line.qty,
            ...(line.unitPrice !== line.listPrice ? { unitPrice: line.unitPrice } : {}),
            ...(line.lineDiscount ? { discount: line.lineDiscount } : {})
          })),
          tier,
          docType: isWholesale ? 'INVOICE' : 'RECEIPT',
          discount: discountValue,
          loyaltyMemberId: member?.id ?? null,
          ...(member && redeem ? { loyaltyRedeemed: redeem } : {})
        });
        if (!cancelled) setQuote(next);
      } catch (err) {
        if (!cancelled) setQuote(null);
        const message = err instanceof Error ? err.message : '';
        if (message) setError(message);
      }
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, cart, tier, isWholesale, discountValue, member, redeem]);

  /** Local fallback shown while the server quote is in flight. */
  const localSubtotal = useMemo(() => cart.reduce((sum, line) => sum + lineGrossOf(line), 0), [cart]);
  const subtotal = quote?.subtotal ?? localSubtotal;
  const itemDiscount = quote?.itemDiscount ?? cart.reduce((sum, l) => sum + (l.lineDiscount ?? 0), 0);
  const promoDiscount = quote?.promoDiscount ?? 0;
  const manualDiscount = quote?.manualDiscount ?? Math.min(discountValue, Math.max(0, subtotal - itemDiscount - promoDiscount));
  const tax = quote?.tax ?? 0;
  const loyaltyValue = quote?.loyaltyValue ?? 0;
  const total = quote?.total ?? Math.max(0, subtotal - itemDiscount - promoDiscount - manualDiscount + tax);
  const totalDiscount = itemDiscount + promoDiscount + manualDiscount;

  useEffect(() => {
    if (!split) setAmountPaid(moneyToInput(total));
  }, [total, split, method]);

  const cashTendered = split
    ? tender.filter((t) => t.method !== 'CREDIT').reduce((sum, t) => sum + t.amount, 0)
    : method === 'CREDIT'
      ? 0
      : amountPaid === ''
        ? total
        : parseMoneyInput(amountPaid);
  const credited = split ? tender.filter((t) => t.method === 'CREDIT').reduce((sum, t) => sum + t.amount, 0) : method === 'CREDIT' ? total : 0;
  const change = Math.max(0, cashTendered - total);
  const needsPrescription = Boolean(features?.prescriptions) && cart.some((line) => line.rxRequired);
  const enabledMethods = (config?.paymentMethods ?? []).filter((m) => m.enabled);
  const creditAllowed = enabledMethods.some((m) => m.method === 'CREDIT');

  /* ---------------- cart ---------------- */

  function addWeighed(product: Product, grams: number) {
    if (!product.isWeighed) return;
    if (!Number.isFinite(grams) || grams <= 0) {
      notify('Enter a weight greater than zero.', 'error');
      return;
    }
    if (grams > product.stockQty) {
      notify(`Only ${(product.stockQty / 1000).toFixed(3)} kg of ${product.name} in stock.`, 'error');
      return;
    }
    setCart((current) => {
      const existing = current.find((line) => line.productId === product.id);
      if (existing) {
        return current.map((line) =>
          line.productId === product.id ? { ...line, qty: Math.min(line.qty + grams, product.stockQty) } : line
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
          qty: grams,
          stockQty: product.stockQty,
          rxRequired: product.rxRequired,
          isWeighed: true
        }
      ];
    });
  }

  function addToCart(product: Product) {
    if (product.isWeighed) {
      setWeighFor(product);
      setWeightInput('');
      return;
    }
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
        // Scanning the same barcode again simply increments the line.
        return current.map((line) => (line.productId === product.id ? { ...line, qty: line.qty + 1 } : line));
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

  /** Barcode or PLU: scan and the line appears (a repeat scan adds one more). */
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
    } else {
      notify(`No ${features?.itemLabel.toLowerCase() ?? 'item'} matches “${term}”.`, 'error');
    }
  }

  function updateQty(productId: number, qty: number) {
    setCart((current) =>
      current
        .map((line) => (line.productId === productId ? { ...line, qty: Math.max(0, Math.min(qty, line.stockQty)) } : line))
        .filter((line) => line.qty > 0)
    );
  }

  function setWeight(productId: number, grams: number) {
    setCart((current) =>
      current.map((line) => (line.productId === productId ? { ...line, qty: Math.max(0, grams) } : line)).filter((l) => l.qty > 0)
    );
  }

  function updatePrice(productId: number, input: string) {
    const value = parseMoneyInput(input);
    setCart((current) => current.map((line) => (line.productId === productId ? { ...line, unitPrice: value } : line)));
  }

  function updateLineDiscount(productId: number, input: string) {
    const value = Math.max(0, parseMoneyInput(input));
    setCart((current) => current.map((line) => (line.productId === productId ? { ...line, lineDiscount: value } : line)));
  }

  function resetSale() {
    setCart([]);
    setDiscount('');
    setQuote(null);
    setSplit(false);
    setCustomer(null);
    setCustomerBalance(null);
    setCustomerName('');
    setCustomerPhone('');
    setCustomerAddress('');
    setPrescriptionRef('');
    setNote('');
    setMember(null);
    setRedeemPoints('');
    setMemberSearch('');
    setMemberHits([]);
    setError(null);
    setAmountPaid('');
    setTender([{ method: 'CASH', amount: 0 }]);
    searchRef.current?.focus();
  }

  /* ---------------- loyalty and customers ---------------- */

  useEffect(() => {
    if (!memberSearch.trim()) {
      setMemberHits([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const hits = await api<MemberRow[]>('mart.loyalty.list', { search: memberSearch });
        if (Array.isArray(hits)) setMemberHits(hits.slice(0, 6));
      } catch {
        setMemberHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [api, memberSearch]);

  useEffect(() => {
    if (!customerSearch.trim()) {
      setCustomerHits([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const hits = await api<CustomerRow[]>('directory.customers.list', { search: customerSearch });
        if (Array.isArray(hits)) setCustomerHits(hits.slice(0, 6));
      } catch {
        setCustomerHits([]);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [api, customerSearch]);

  async function chooseCustomer(next: CustomerRow) {
    setCustomer(next);
    setCustomerName(next.name);
    setCustomerPhone(next.phone ?? '');
    setCustomerAddress(next.address ?? '');
    setCustomerSearch('');
    setCustomerHits([]);
    try {
      const balance = await api<CustomerBalance | null>('pos.credits.customer', { customerId: next.id });
      setCustomerBalance(balance ?? null);
    } catch {
      setCustomerBalance(null);
    }
  }

  /* ---------------- holds ---------------- */

  async function holdCurrent() {
    if (cart.length === 0) return setError('There is nothing to hold.');
    try {
      await call<HeldSale>('pos.holds.save', {
        label: customerName || note || undefined,
        customerName: customerName || undefined,
        total,
        linesCount: cart.length,
        payload: {
          lines: cart,
          tier,
          discount: manualDiscount,
          customerName,
          customerPhone,
          customerAddress,
          note,
          prescriptionRef,
          memberId: member?.id ?? null,
          redeem
        }
      });
      notify('Basket held. Recall it from the Held button.', 'success');
      resetSale();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hold the basket.');
    }
  }

  async function openHolds() {
    try {
      const list = await call<HeldSale[]>('pos.holds.list', {});
      setHolds(Array.isArray(list) ? list : []);
      setHoldsOpen(true);
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not load held baskets.', 'error');
    }
  }

  async function recall(id: number) {
    try {
      const held = await call<HeldSale & { payload: string }>('pos.holds.get', { id });
      const payload = JSON.parse(held.payload) as {
        lines: CartLine[];
        tier: PriceTier;
        discount?: number;
        customerName?: string;
        customerPhone?: string;
        customerAddress?: string;
        note?: string;
        prescriptionRef?: string;
        redeem?: number;
      };
      setCart(Array.isArray(payload.lines) ? payload.lines : []);
      setTier(payload.tier ?? 'RETAIL');
      setDiscount(payload.discount ? moneyToInput(payload.discount) : '');
      setCustomerName(payload.customerName ?? '');
      setCustomerPhone(payload.customerPhone ?? '');
      setCustomerAddress(payload.customerAddress ?? '');
      setNote(payload.note ?? '');
      setPrescriptionRef(payload.prescriptionRef ?? '');
      setRedeemPoints(payload.redeem ? String(payload.redeem) : '');
      await call('pos.holds.cancel', { id });
      setHoldsOpen(false);
      notify(`Recalled ${held.holdNo}.`, 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not recall that basket.', 'error');
    }
  }

  async function discardHold(id: number) {
    try {
      await call('pos.holds.cancel', { id });
      setHolds((current) => current.filter((h) => h.id !== id));
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not cancel that basket.', 'error');
    }
  }

  /* ---------------- checkout ---------------- */

  function tenderPayload(): { paymentMethod: PaymentMethod; amountPaid: number; payments?: { method: PaymentMethod; amount: number }[] } {
    if (split) {
      const rows = tender.filter((t) => t.amount > 0);
      return {
        paymentMethod: rows.length > 1 ? ('SPLIT' as PaymentMethod) : (rows[0]?.method ?? 'CASH'),
        amountPaid: cashTendered,
        payments: rows
      };
    }
    if (method === 'CREDIT') {
      return {
        paymentMethod: 'CREDIT',
        amountPaid: 0,
        payments: credited > 0 ? [{ method: 'CREDIT', amount: credited }] : undefined
      };
    }
    return {
      paymentMethod: method,
      amountPaid: amountPaid === '' ? total : parseMoneyInput(amountPaid)
    };
  }

  async function complete(token?: string) {
    setError(null);
    if (cart.length === 0) return setError('Add at least one item.');
    if (isWholesale && !customerName.trim()) return setError('Enter the wholesale customer name.');
    if (needsPrescription && !prescriptionRef.trim())
      return setError('A prescription reference is required for prescription items.');
    if (credited > 0 && !customer) return setError('Choose a credit customer before selling on account.');

    const tenderInfo = tenderPayload();
    if (!split && method !== 'CREDIT' && tenderInfo.amountPaid < total) {
      return setError('Amount paid is less than the total.');
    }
    if (split) {
      const settled = tender.reduce((sum, t) => sum + t.amount, 0);
      if (settled + change < total) return setError('The split payments do not cover the total.');
    }
    if (credited > 0 && cashTendered > total) {
      return setError('A credit sale cannot give change. Reduce the amount tendered.');
    }

    setBusy(true);
    try {
      const payload: SaleInput = {
        docType: isWholesale ? 'INVOICE' : 'RECEIPT',
        tier,
        lines: cart.map((line) => ({
          productId: line.productId,
          qty: line.qty,
          ...(line.unitPrice !== line.listPrice ? { unitPrice: line.unitPrice } : {}),
          ...(line.lineDiscount ? { discount: line.lineDiscount } : {})
        })),
        discount: manualDiscount,
        paymentMethod: tenderInfo.paymentMethod,
        amountPaid: tenderInfo.amountPaid,
        ...(tenderInfo.payments ? { payments: tenderInfo.payments } : {}),
        customerId: customer?.id ?? null,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        customerAddress: customerAddress || undefined,
        prescriptionRef: prescriptionRef || undefined,
        note: note || undefined,
        loyaltyMemberId: member?.id ?? null,
        ...(member && redeem > 0 ? { loyaltyRedeemed: redeem } : {}),
        ...(token ? { approvalToken: token } : {})
      };
      const sale = await call<Sale>('sales.create', payload as unknown as Record<string, unknown>);
      const document = await call<SaleDocumentPayload>('pos.print', { id: sale.id, layout });
      setReceipt(document);
      void loadConfig();
      void loadProducts(search);
      notify(`${isWholesale ? 'Invoice' : 'Sale'} ${sale.receiptNo} completed.`, 'success');
      resetSale();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'APPROVAL_REQUIRED') {
        setApprovalOpen({
          reason: err.message,
          purpose: /price/i.test(err.message) ? 'PRICE_OVERRIDE' : 'DISCOUNT'
        });
        setApprover({ username: '', password: '' });
      } else {
        setError(err instanceof Error ? err.message : 'Could not complete the sale.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitApproval() {
    if (!approvalOpen) return;
    setApproving(true);
    try {
      const grant = await call<{ token: string }>('pos.approve', {
        purpose: approvalOpen.purpose,
        username: approver.username,
        password: approver.password,
        reason: approvalOpen.reason
      });
      const token = grant.token;
      setApprovalOpen(null);
      await complete(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed.');
    } finally {
      setApproving(false);
    }
  }

  async function reprint() {
    if (!receipt) return;
    try {
      const document = await call<SaleDocumentPayload>('pos.print', { id: receipt.sale.id, layout });
      setReceipt(document);
      notify('Reprinted as DUPLICATE.', 'info');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not print.', 'error');
    }
  }

  async function openShift() {
    try {
      await call('mart.shifts.open', { openingFloat: parseMoneyInput(openingFloat) });
      setOpeningFloat('');
      await loadConfig();
      notify('Shift opened.', 'success');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Could not open a shift.', 'error');
    }
  }

  /* ---------------- shortcuts: F2 search, F9 pay, F10 print ---------------- */

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'F2') {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === 'F9') {
        event.preventDefault();
        if (!busy && !receipt) void complete();
      } else if (event.key === 'F10') {
        event.preventDefault();
        void reprint();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const shiftMissing = Boolean(config?.requireShift && !config.shift);

  return (
    <div>
      <PageHead
        title={isWholesale ? 'Wholesale invoice' : 'Point of sale'}
        subtitle={
          isWholesale
            ? 'Raise an invoice at wholesale prices. Stock and receipts use the same ledger as retail.'
            : `${features?.itemLabel ?? 'Item'} search, barcode scan and instant receipts. F2 search · F9 pay · F10 print.`
        }
        actions={
          <div className="row tight">
            <div className="seg-toggle">
              <button type="button" className={!isWholesale ? 'active' : ''} onClick={() => setTier('RETAIL')}>
                Retail
              </button>
              <button
                type="button"
                className={isWholesale ? 'active' : ''}
                onClick={() => setTier('WHOLESALE')}
                disabled={config ? !config.wholesaleEnabled : false}
              >
                Wholesale
              </button>
            </div>
            <Button variant="ghost" size="sm" onClick={() => void openHolds()}>
              Held (F4)
            </Button>
            {config?.customerDisplay ? (
              <Button variant="ghost" size="sm" onClick={() => setShowDisplay(true)}>
                Customer display
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={resetSale}>
              Clear
            </Button>
          </div>
        }
      />

      {shiftMissing ? (
        <Alert tone="warn">
          <div className="row tight" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span>No shift is open. Open one with the cash drawer float before the first sale.</span>
            <Input
              value={openingFloat}
              onChange={(e) => setOpeningFloat(e.target.value)}
              placeholder="Opening float ₦"
              style={{ width: 150 }}
            />
            <Button size="sm" onClick={() => void openShift()}>
              Open shift
            </Button>
          </div>
        </Alert>
      ) : null}

      <div className="pos-grid">
        <Card>
          <div className="row tight">
            <div className="grow">
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder="Scan barcode, type name/code/PLU, then press Enter"
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
                No products found. An administrator can add {features?.itemLabel.toLowerCase() ?? 'items'} under Products.
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
                      {product.pluCode ? ` · PLU ${product.pluCode}` : ''}
                    </span>
                    <span className="pmeta">
                      {product.stockQty > 0
                        ? product.isWeighed
                          ? `${(product.stockQty / 1000).toFixed(2)} kg in stock`
                          : `${product.stockQty} in stock`
                        : 'Out of stock'}
                      {features?.pharmacy && product.nearestExpiry ? ` · exp ${product.nearestExpiry}` : ''}
                    </span>
                    <span className="pprice">
                      {formatMoney(priceFor(product))}
                      {product.isWeighed ? <span className="tiny"> /kg</span> : null}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        <div className="cart">
          <Card title={`Basket (${cart.length} line${cart.length === 1 ? '' : 's'})`}>
            <div className="cart-list">
              {cart.length === 0 ? (
                <div className="empty">Tap a {features?.itemLabel.toLowerCase() ?? 'product'} to start a sale.</div>
              ) : (
                cart.map((line) => {
                  const quoteLine = quote?.lines.find((l) => l.productId === line.productId);
                  return (
                    <div className="cart-line" key={line.productId}>
                      <div>
                        <div className="name">{line.name}</div>
                        <div className="tiny muted">
                          {line.sku} · {formatMoney(line.listPrice)} list
                          {quoteLine?.promotionName ? ` · ${quoteLine.promotionName}` : ''}
                        </div>
                      </div>
                      <div className="row tight" style={{ alignItems: 'flex-start' }}>
                        {line.isWeighed ? (
                          <div className="qty-control">
                            <input
                              aria-label={`Weight for ${line.name} in kg`}
                              value={(line.qty / 1000).toFixed(3)}
                              onChange={(e) => setWeight(line.productId, Math.round(Number(e.target.value) * 1000))}
                              style={{ width: 70, padding: '2px 4px', textAlign: 'right' }}
                            />
                            <span className="tiny muted">kg</span>
                          </div>
                        ) : (
                          <div className="qty-control">
                            <button type="button" onClick={() => updateQty(line.productId, line.qty - 1)}>
                              −
                            </button>
                            <span>{line.qty}</span>
                            <button type="button" onClick={() => updateQty(line.productId, line.qty + 1)}>
                              +
                            </button>
                          </div>
                        )}
                        <div style={{ textAlign: 'right', minWidth: 96 }}>
                          <div style={{ fontWeight: 700 }}>{formatMoney(lineTotalOf(line))}</div>
                          {line.isWeighed ? (
                            <div className="tiny muted">
                              {formatMoney(line.unitPrice)}/kg · {lineQtyLabel(line)}
                            </div>
                          ) : null}
                          {quoteLine && quoteLine.promoDiscount > 0 ? (
                            <div className="tiny" style={{ color: 'var(--gold-dark, #8a6d21)' }}>
                              promo −{formatMoney(quoteLine.promoDiscount)}
                            </div>
                          ) : null}
                          <div className="row tight" style={{ justifyContent: 'flex-end', marginTop: 3 }}>
                            {config?.canOverridePrice ? (
                              <input
                                aria-label={`Unit price for ${line.name}`}
                                value={moneyToInput(line.unitPrice)}
                                onChange={(e) => updatePrice(line.productId, e.target.value)}
                                style={{ width: 74, padding: '2px 5px', fontSize: 11 }}
                              />
                            ) : null}
                            <input
                              aria-label={`Discount for ${line.name}`}
                              placeholder="disc"
                              value={line.lineDiscount ? moneyToInput(line.lineDiscount) : ''}
                              onChange={(e) => updateLineDiscount(line.productId, e.target.value)}
                              style={{ width: 58, padding: '2px 5px', fontSize: 11 }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="totals-box" style={{ marginTop: 12 }}>
              <div className="line">
                <span>Subtotal</span>
                <span>{formatMoney(subtotal)}</span>
              </div>
              {promoDiscount > 0 ? (
                <div className="line">
                  <span>Promotions</span>
                  <span>−{formatMoney(promoDiscount)}</span>
                </div>
              ) : null}
              {itemDiscount > 0 ? (
                <div className="line">
                  <span>Item discounts</span>
                  <span>−{formatMoney(itemDiscount)}</span>
                </div>
              ) : null}
              <div className="line">
                <span>Discount {config ? `(cap ${config.maxDiscountPercent}%)` : ''}</span>
                <input
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  placeholder="0.00"
                  style={{ width: 110, padding: '4px 8px', textAlign: 'right' }}
                />
              </div>
              {tax > 0 ? (
                <div className="line">
                  <span>VAT {config ? `${config.vatRate}%` : ''}</span>
                  <span>{formatMoney(tax)}</span>
                </div>
              ) : null}
              {loyaltyValue > 0 ? (
                <div className="line">
                  <span>Loyalty points ({redeem})</span>
                  <span>−{formatMoney(loyaltyValue)}</span>
                </div>
              ) : null}
              {totalDiscount > 0 ? (
                <div className="line tiny muted">
                  <span>Total saved</span>
                  <span>
                    {formatMoney(totalDiscount)} ({subtotal > 0 ? ((totalDiscount / subtotal) * 100).toFixed(1) : '0'}%)
                  </span>
                </div>
              ) : null}
              <div className="line total">
                <span>Total</span>
                <span>{formatMoney(total)}</span>
              </div>
            </div>
          </Card>

          <Card title="Payment">
            <div className="stack" style={{ gap: 10 }}>
              {enabledMethods.length === 0 ? (
                <Alert tone="warn">
                  No payment methods are enabled. An administrator can switch them on in Settings → Till &amp; receipts.
                </Alert>
              ) : (
                <div className="payment-methods">
                  {enabledMethods
                    .filter((m) => m.method !== 'CREDIT' || customer)
                    .map((m) => (
                      <button
                        key={m.method}
                        type="button"
                        className={!split && method === m.method ? 'active' : ''}
                        onClick={() => {
                          setSplit(false);
                          setMethod(m.method as Exclude<PaymentMethod, 'SPLIT'>);
                        }}
                      >
                        {m.label}
                      </button>
                    ))}
                  <button type="button" className={split ? 'active' : ''} onClick={() => setSplit((v) => !v)}>
                    Split
                  </button>
                </div>
              )}

              {split ? (
                <div className="stack" style={{ gap: 6 }}>
                  {tender.map((row, index) => (
                    <div key={index} className="row tight">
                      <Select
                        value={row.method}
                        onChange={(e) =>
                          setTender((current) =>
                            current.map((t, i) =>
                              i === index ? { ...t, method: e.target.value as TenderRow['method'] } : t
                            )
                          )
                        }
                        style={{ width: 130 }}
                      >
                        {enabledMethods
                          .filter((m) => m.method !== 'CREDIT' || customer)
                          .map((m) => (
                            <option key={m.method} value={m.method}>
                              {PAYMENT_LABELS[m.method] ?? m.method}
                            </option>
                          ))}
                      </Select>
                      <Input
                        value={moneyToInput(row.amount)}
                        onChange={(e) =>
                          setTender((current) =>
                            current.map((t, i) => (i === index ? { ...t, amount: parseMoneyInput(e.target.value) } : t))
                          )
                        }
                        inputMode="decimal"
                        style={{ textAlign: 'right' }}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setTender((current) => current.filter((_, i) => i !== index))}
                        disabled={tender.length === 1}
                      >
                        ✕
                      </Button>
                    </div>
                  ))}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setTender((current) => [
                        ...current,
                        { method: current.some((t) => t.method === 'TRANSFER') ? 'CASH' : 'TRANSFER', amount: 0 }
                      ])
                    }
                  >
                    + Add payment
                  </Button>
                </div>
              ) : method === 'CREDIT' ? (
                <Alert tone="info">The full {formatMoney(total)} goes on {customer?.name ?? 'the customer'}’s account.</Alert>
              ) : (
                <Field label="Amount tendered (₦)">
                  <Input
                    value={amountPaid}
                    onChange={(e) => setAmountPaid(e.target.value)}
                    inputMode="decimal"
                    style={{ textAlign: 'right', fontWeight: 700, fontSize: 16 }}
                  />
                </Field>
              )}

              <div className="change-due">
                <span>{credited > 0 ? 'On account' : 'Change due'}</span>
                <span>{formatMoney(credited > 0 ? credited : change)}</span>
              </div>

              {creditAllowed ? (
                <div className="stack" style={{ gap: 4 }}>
                  <Field label="Credit customer (for wholesale accounts)">
                    <Input
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      placeholder={customer ? customer.name : 'Search customers…'}
                    />
                  </Field>
                  {customerHits.length > 0 ? (
                    <div className="stack" style={{ gap: 2 }}>
                      {customerHits.map((hit) => (
                        <button key={hit.id} type="button" className="link-row" onClick={() => void chooseCustomer(hit)}>
                          {hit.name} · {formatMoney(hit.creditLimit)} limit
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {customer ? (
                    <div className="tiny muted">
                      {customer.name} · limit {formatMoney(customer.creditLimit)}
                      {customerBalance ? ` · owing ${formatMoney(customerBalance.outstanding)}` : ''}
                      <Button variant="ghost" size="sm" onClick={() => setCustomer(null)}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {features?.supermarket ? (
                <div className="stack" style={{ gap: 4 }}>
                  <Field label="Loyalty member">
                    <Input
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                      placeholder={member ? `${member.name} · ${member.points} pts` : 'Search by name, phone or card…'}
                    />
                  </Field>
                  {memberHits.length > 0 ? (
                    <div className="stack" style={{ gap: 2 }}>
                      {memberHits.map((hit) => (
                        <button
                          key={hit.id}
                          type="button"
                          className="link-row"
                          onClick={() => {
                            setMember(hit);
                            setMemberHits([]);
                            setMemberSearch('');
                          }}
                        >
                          {hit.name} · {hit.memberNo} · {hit.points} pts
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {member ? (
                    <div className="row tight" style={{ alignItems: 'center', gap: 6 }}>
                      <span className="tiny muted">{member.name}</span>
                      <Input
                        value={redeemPoints}
                        onChange={(e) => setRedeemPoints(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="Redeem pts"
                        style={{ width: 96 }}
                      />
                      <span className="tiny muted">of {member.points}</span>
                      <Button variant="ghost" size="sm" onClick={() => setMember(null)}>
                        Remove
                      </Button>
                    </div>
                  ) : null}
                  {quote && quote.loyaltyEarned > 0 ? (
                    <div className="tiny muted">Earns {quote.loyaltyEarned} points on this sale.</div>
                  ) : null}
                </div>
              ) : null}

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

              <Field label="Note (optional)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Printed on the receipt" />
              </Field>

              <Field label="Receipt layout">
                <Select value={layout} onChange={(e) => setLayout(e.target.value as ReceiptLayout)}>
                  {RECEIPT_LAYOUTS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>

              {error ? <Alert tone="error">{error}</Alert> : null}
              {quote?.requiresApproval ? <Alert tone="warn">{quote.approvalReason} An approver will be asked to sign in.</Alert> : null}

              <Button variant="gold" block onClick={() => void complete()} disabled={busy || cart.length === 0}>
                {busy ? 'Processing…' : `Complete ${isWholesale ? 'invoice' : 'sale'} · ${formatMoney(total)} (F9)`}
              </Button>
              <div className="row tight" style={{ justifyContent: 'space-between' }}>
                <Button variant="ghost" size="sm" onClick={() => void holdCurrent()}>
                  Hold basket
                </Button>
                <span className="tiny muted">
                  {config?.shift
                    ? `Shift open · float ${formatMoney(config.shift.openingFloat)} · expected ${formatMoney(config.shift.expectedCash)}`
                    : 'No shift open'}
                </span>
              </div>
              <div className="tiny muted center">
                Stock is deducted (FEFO where batches expire) and the receipt is numbered in a single database transaction.
              </div>
            </div>
          </Card>
        </div>
      </div>

      {weighFor ? (
        <Modal
          title={`Weigh ${weighFor.name}`}
          size="sm"
          onClose={() => setWeighFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setWeighFor(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  addWeighed(weighFor, Math.round(Number(weightInput) * 1000));
                  setWeighFor(null);
                }}
                disabled={!Number(weightInput)}
              >
                Add to basket
              </Button>
            </>
          }
        >
          <div className="stack">
            <div className="small muted">
              {formatMoney(weighFor.pricePerKg ?? 0)} per kg · {(weighFor.stockQty / 1000).toFixed(3)} kg in stock
              {weighFor.pluCode ? ` · PLU ${weighFor.pluCode}` : ''}
            </div>
            <Field label="Weight (kg)" hint="Type the weight shown on the scale, or use the preset buttons.">
              <Input
                type="number"
                min={0.001}
                step="0.001"
                value={weightInput}
                onChange={(e) => setWeightInput(e.target.value)}
                autoFocus
              />
            </Field>
            <div className="row tight wrap">
              {[0.25, 0.5, 1, 2, 5].map((kg) => (
                <Button key={kg} size="sm" variant="ghost" onClick={() => setWeightInput(String(kg))}>
                  {kg} kg
                </Button>
              ))}
            </div>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">Line total</span>
              <strong>
                {formatMoney(Math.round(((weighFor.pricePerKg ?? 0) * Math.round(Number(weightInput) * 1000)) / 1000) || 0)}
              </strong>
            </div>
          </div>
        </Modal>
      ) : null}

      {holdsOpen ? (
        <Modal
          title="Held baskets"
          size="wide"
          onClose={() => setHoldsOpen(false)}
          footer={
            <Button variant="ghost" onClick={() => setHoldsOpen(false)}>
              Close
            </Button>
          }
        >
          {holds.length === 0 ? (
            <div className="empty">No baskets are held.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Hold</th>
                  <th>Customer / label</th>
                  <th>Lines</th>
                  <th className="num">Total</th>
                  <th>Cashier</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {holds.map((held) => (
                  <tr key={held.id}>
                    <td>{held.holdNo}</td>
                    <td>{held.customerName || held.label || '—'}</td>
                    <td>{held.linesCount}</td>
                    <td className="num">{formatMoney(held.total)}</td>
                    <td>{held.username}</td>
                    <td className="num">
                      <div className="row tight" style={{ justifyContent: 'flex-end' }}>
                        <Button size="sm" onClick={() => void recall(held.id)}>
                          Recall
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void discardHold(held.id)}>
                          Discard
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Modal>
      ) : null}

      {approvalOpen ? (
        <Modal
          title="Supervisor approval needed"
          size="sm"
          onClose={() => setApprovalOpen(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setApprovalOpen(null)}>
                Cancel
              </Button>
              <Button variant="gold" onClick={() => void submitApproval()} disabled={approving}>
                {approving ? 'Checking…' : 'Approve'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <Alert tone="warn">{approvalOpen.reason}</Alert>
            <div className="tiny muted">
              {approvalOpen.purpose === 'DISCOUNT'
                ? 'Only an administrator can approve a discount above the cap.'
                : 'A supervisor or administrator can approve a price override.'}
            </div>
            <Field label="Approver username">
              <Input value={approver.username} onChange={(e) => setApprover({ ...approver, username: e.target.value })} autoFocus />
            </Field>
            <Field label="Approver password">
              <Input
                type="password"
                value={approver.password}
                onChange={(e) => setApprover({ ...approver, password: e.target.value })}
              />
            </Field>
          </div>
        </Modal>
      ) : null}

      {showDisplay ? (
        <div className="customer-display" role="dialog" aria-label="Customer display">
          <div className="cd-head">
            <strong>{config?.loyaltyEnabled ? 'Thank you for shopping with us' : 'Your order'}</strong>
            <Button variant="ghost" size="sm" onClick={() => setShowDisplay(false)}>
              Close
            </Button>
          </div>
          <div className="cd-lines">
            {cart.length === 0 ? (
              <div className="cd-empty">Waiting for the next item…</div>
            ) : (
              cart.map((line) => (
                <div className="cd-line" key={line.productId}>
                  <span>
                    {line.name} <span className="cd-qty">× {lineQtyLabel(line)}</span>
                  </span>
                  <span>{formatMoney(lineTotalOf(line))}</span>
                </div>
              ))
            )}
          </div>
          <div className="cd-total">
            <span>Total</span>
            <span>{formatMoney(total)}</span>
          </div>
          {change > 0 ? (
            <div className="cd-change">
              Change {formatMoney(change)}
            </div>
          ) : null}
        </div>
      ) : null}

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
              <Button variant="ghost" onClick={() => void reprint()}>
                Reprint (F10)
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
            {receipt.sale.docType === 'INVOICE' ? 'Invoice' : 'Sale'} completed · change due {formatMoney(receipt.sale.changeDue)}
            {receipt.sale.balanceDue > 0 ? ` · on account ${formatMoney(receipt.sale.balanceDue)}` : ''}
            {receipt.duplicate ? ' · DUPLICATE copy' : ''}
          </Alert>
          <div style={{ marginTop: 14 }}>
            <DocumentView
              html={receipt.html}
              filename={`${receipt.sale.receiptNo}${receipt.duplicate ? '-duplicate' : ''}.html`}
              title={`${receipt.sale.docType === 'INVOICE' ? 'Invoice' : 'Receipt'} ${receipt.sale.receiptNo}`}
            />
          </div>
          <div className="row tight" style={{ marginTop: 10 }}>
            <Badge tone="info">{receipt.layout}</Badge>
            {receipt.duplicate ? <Badge tone="warn">DUPLICATE</Badge> : <Badge tone="success">ORIGINAL</Badge>}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
