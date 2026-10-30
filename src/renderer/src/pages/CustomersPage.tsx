import { useCallback, useEffect, useState } from 'react';
import { useApi, useApp } from '../state';
import { formatMoney } from '../../../shared/money';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHead,
  SearchBox
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
  const admin = can('products.manage');

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
    </div>
  );
}
