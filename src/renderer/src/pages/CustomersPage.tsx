import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../state';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import type { CreditPaymentInput } from '../../../shared/types';
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
  SearchBox,
  Select
} from '../components/ui';

interface CustomerRow {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  credit_limit: number;
  active: number;
}

interface CreditBalanceRow {
  customerId: number;
  name: string;
  phone: string | null;
  creditLimit: number;
  outstanding: number;
  invoices: number;
}

interface CreditInvoiceRow {
  id: number;
  receiptNo: string;
  createdAt: string;
  total: number;
  balanceDue: number;
}

interface SupplierRow {
  id: number;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  active: number;
}

const emptyCustomer = { id: undefined as number | undefined, name: '', phone: '', email: '', address: '', creditLimit: 0 };
const emptySupplier = { id: undefined as number | undefined, name: '', contactPerson: '', phone: '', email: '', address: '' };

export default function CustomersPage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [search, setSearch] = useState('');
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [customer, setCustomer] = useState(emptyCustomer);
  const [supplier, setSupplier] = useState(emptySupplier);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [balances, setBalances] = useState<CreditBalanceRow[]>([]);
  const [collectFor, setCollectFor] = useState<CreditBalanceRow | null>(null);
  const [invoices, setInvoices] = useState<CreditInvoiceRow[]>([]);
  const [collect, setCollect] = useState<{ saleId: number | null; amount: string; method: 'CASH' | 'TRANSFER' | 'POS' }>({
    saleId: null,
    amount: '',
    method: 'CASH'
  });
  const admin = can('products.manage');
  const canCollect = can('sales.credit.collect');

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([
      api<CustomerRow[]>('directory.customers.list', { search: search || undefined }),
      api<SupplierRow[]>('directory.suppliers.list', { search: search || undefined })
    ]);
    if (c) setCustomers(c);
    if (s) setSuppliers(s);
  }, [api, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadBalances = useCallback(async () => {
    if (!canCollect) return;
    const rows = await api<CreditBalanceRow[]>('pos.credits.list', {});
    if (rows) setBalances(rows.filter((row) => row.outstanding > 0));
  }, [api, canCollect]);

  useEffect(() => {
    void loadBalances();
  }, [loadBalances]);

  async function openCollect(row: CreditBalanceRow) {
    setCollectFor(row);
    setCollect({ saleId: null, amount: '', method: 'CASH' });
    const list = await api<CreditInvoiceRow[]>('pos.credits.invoices', { customerId: row.customerId });
    setInvoices(list ?? []);
  }

  async function submitCollect() {
    if (!collect.saleId || !collectFor) return;
    const amount = parseMoneyInput(collect.amount);
    if (amount <= 0) return setError('Enter the amount received.');
    setBusy(true);
    setError(null);
    try {
      const payload: CreditPaymentInput = { saleId: collect.saleId, amount, method: collect.method };
      await api('pos.credits.pay', { ...payload });
      notify(`${formatMoney(amount)} received from ${collectFor.name}.`, 'success');
      const list = await api<CreditInvoiceRow[]>('pos.credits.invoices', { customerId: collectFor.customerId });
      setInvoices(list ?? []);
      setCollect({ saleId: null, amount: '', method: 'CASH' });
      await loadBalances();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomer(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('directory.customers.save', {
        ...customer,
        id: customer.id ?? undefined,
        creditLimit: Math.round(customer.creditLimit)
      });
      notify(`${customer.name} saved.`, 'success');
      setCustomer(emptyCustomer);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the customer.');
    } finally {
      setBusy(false);
    }
  }

  async function saveSupplier(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('directory.suppliers.save', { ...supplier, id: supplier.id ?? undefined });
      notify(`${supplier.name} saved.`, 'success');
      setSupplier(emptySupplier);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the supplier.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Customers"
        subtitle="Customer directory for invoices, credit sales and loyalty, plus the suppliers you buy from."
        actions={<SearchBox value={search} onChange={setSearch} placeholder="Search name or phone" />}
      />

      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid-2">
        <Card
          title={`Customers (${customers.length})`}
          actions={
            admin ? (
              <Button size="sm" variant="ghost" onClick={() => setCustomer(emptyCustomer)}>
                New customer
              </Button>
            ) : null
          }
        >
          <DataTable<CustomerRow>
            rows={customers}
            empty="No customers yet."
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
              { key: 'email', label: 'Email', render: (row) => row.email ?? '—' },
              {
                key: 'credit_limit',
                label: 'Credit limit',
                align: 'right',
                render: (row) => (row.credit_limit ? formatMoney(row.credit_limit) : '—')
              },
              {
                key: 'active',
                label: 'Status',
                render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Active' : 'Inactive'}</Badge>
              }
            ]}
            onRowClick={
              admin
                ? (row) =>
                    setCustomer({
                      id: row.id,
                      name: row.name,
                      phone: row.phone ?? '',
                      email: row.email ?? '',
                      address: row.address ?? '',
                      creditLimit: row.credit_limit
                    })
                : undefined
            }
          />
          {admin ? (
            <form className="stack" style={{ marginTop: 14 }} onSubmit={saveCustomer}>
              <div className="form-grid">
                <Field label="Customer name">
                  <Input value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} required />
                </Field>
                <Field label="Phone">
                  <Input value={customer.phone} onChange={(e) => setCustomer({ ...customer, phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <Input type="email" value={customer.email} onChange={(e) => setCustomer({ ...customer, email: e.target.value })} />
                </Field>
                <Field label="Credit limit (₦)" hint="Leave 0 for cash-only customers.">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    value={customer.creditLimit / 100}
                    onChange={(e) => setCustomer({ ...customer, creditLimit: Math.round(Number(e.target.value) * 100) })}
                  />
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                {customer.id ? 'Save changes' : 'Add customer'}
              </Button>
            </form>
          ) : (
            <p className="tiny muted">Only an administrator can add or edit customers.</p>
          )}
        </Card>

        {canCollect ? (
          <Card title={`Credit balances (${balances.length})`}>
            {balances.length === 0 ? (
              <div className="empty">No customer owes anything.</div>
            ) : (
              <DataTable<CreditBalanceRow>
                rows={balances}
                empty="No customer owes anything."
                columns={[
                  { key: 'name', label: 'Customer' },
                  { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
                  { key: 'invoices', label: 'Open invoices', align: 'right' },
                  {
                    key: 'creditLimit',
                    label: 'Credit limit',
                    align: 'right',
                    render: (row) => formatMoney(row.creditLimit)
                  },
                  {
                    key: 'outstanding',
                    label: 'Owing',
                    align: 'right',
                    render: (row) => <strong>{formatMoney(row.outstanding)}</strong>
                  }
                ]}
                onRowClick={(row) => void openCollect(row)}
              />
            )}
            <p className="tiny muted" style={{ marginTop: 10 }}>
              Click a customer to receive a payment against their oldest open invoice. Credit is only offered to
              customers with a limit set above zero.
            </p>
          </Card>
        ) : null}

        <Card title={`Suppliers (${suppliers.length})`}>
          <DataTable<SupplierRow>
            rows={suppliers}
            empty="No suppliers yet."
            columns={[
              { key: 'name', label: 'Supplier' },
              { key: 'contact_person', label: 'Contact', render: (row) => row.contact_person ?? '—' },
              { key: 'phone', label: 'Phone', render: (row) => row.phone ?? '—' },
              { key: 'email', label: 'Email', render: (row) => row.email ?? '—' }
            ]}
            onRowClick={
              admin
                ? (row) =>
                    setSupplier({
                      id: row.id,
                      name: row.name,
                      contactPerson: row.contact_person ?? '',
                      phone: row.phone ?? '',
                      email: row.email ?? '',
                      address: ''
                    })
                : undefined
            }
          />
          {admin ? (
            <form className="stack" style={{ marginTop: 14 }} onSubmit={saveSupplier}>
              <div className="form-grid">
                <Field label="Supplier name">
                  <Input value={supplier.name} onChange={(e) => setSupplier({ ...supplier, name: e.target.value })} required />
                </Field>
                <Field label="Contact person">
                  <Input
                    value={supplier.contactPerson}
                    onChange={(e) => setSupplier({ ...supplier, contactPerson: e.target.value })}
                  />
                </Field>
                <Field label="Phone">
                  <Input value={supplier.phone} onChange={(e) => setSupplier({ ...supplier, phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <Input type="email" value={supplier.email} onChange={(e) => setSupplier({ ...supplier, email: e.target.value })} />
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                {supplier.id ? 'Save changes' : 'Add supplier'}
              </Button>
            </form>
          ) : (
            <p className="tiny muted">Only an administrator can add or edit suppliers.</p>
          )}
        </Card>
      </div>
      {collectFor ? (
        <Modal
          title={`Receive payment · ${collectFor.name}`}
          size="wide"
          onClose={() => setCollectFor(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCollectFor(null)}>
                Close
              </Button>
              <Button onClick={() => void submitCollect()} disabled={busy || !collect.saleId}>
                {busy ? 'Saving…' : 'Record payment'}
              </Button>
            </>
          }
        >
          {error ? <Alert tone="error">{error}</Alert> : null}
          {invoices.length === 0 ? (
            <div className="empty">This customer has no open invoices.</div>
          ) : (
            <DataTable<CreditInvoiceRow>
              rows={invoices}
              empty="No open invoices."
              columns={[
                { key: 'receiptNo', label: 'Invoice' },
                {
                  key: 'createdAt',
                  label: 'Date',
                  render: (row) => new Date(row.createdAt).toLocaleDateString()
                },
                { key: 'total', label: 'Invoice total', align: 'right', render: (row) => formatMoney(row.total) },
                {
                  key: 'balanceDue',
                  label: 'Balance',
                  align: 'right',
                  render: (row) => <strong>{formatMoney(row.balanceDue)}</strong>
                },
                {
                  key: 'pick',
                  label: '',
                  align: 'right',
                  render: (row) => (
                    <Button
                      size="sm"
                      variant={collect.saleId === row.id ? 'gold' : 'ghost'}
                      onClick={() => {
                        setCollect({
                          saleId: row.id,
                          amount: moneyToInput(row.balanceDue),
                          method: collect.method
                        });
                      }}
                    >
                      {collect.saleId === row.id ? 'Selected' : 'Select'}
                    </Button>
                  )
                }
              ]}
            />
          )}
          <div className="form-grid two" style={{ marginTop: 14 }}>
            <Field label="Amount received (₦)">
              <Input
                value={collect.amount}
                onChange={(e) => setCollect({ ...collect, amount: e.target.value })}
                inputMode="decimal"
                style={{ textAlign: 'right' }}
              />
            </Field>
            <Field label="Method">
              <Select
                value={collect.method}
                onChange={(e) => setCollect({ ...collect, method: e.target.value as 'CASH' | 'TRANSFER' | 'POS' })}
              >
                <option value="CASH">Cash</option>
                <option value="TRANSFER">Transfer</option>
                <option value="POS">Card / POS</option>
              </Select>
            </Field>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
