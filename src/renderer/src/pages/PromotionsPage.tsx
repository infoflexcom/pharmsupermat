import { useCallback, useEffect, useState } from 'react';
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
  Input,
  PageHead,
  Select
} from '../components/ui';

interface PromotionRow {
  id: number;
  name: string;
  promo_type: 'PERCENT' | 'AMOUNT' | 'BOGO' | 'MULTIBUY';
  value: number;
  product_id: number | null;
  category_id: number | null;
  department_id: number | null;
  min_qty: number;
  starts_at: string | null;
  ends_at: string | null;
  active: number;
}

interface PriceRuleRow {
  id: number;
  name: string;
  scope: 'PRODUCT' | 'CATEGORY' | 'DEPARTMENT';
  rule_type: 'DISCOUNT_PERCENT' | 'DISCOUNT_AMOUNT' | 'SET_PRICE';
  value: number;
  product_id: number | null;
  category_id: number | null;
  department_id: number | null;
  requires_supervisor: number;
  active: number;
}

interface DepartmentRow {
  id: number;
  name: string;
}

const emptyPromo = {
  name: '',
  promoType: 'PERCENT' as PromotionRow['promo_type'],
  value: 10,
  productId: '' as number | '',
  departmentId: '' as number | '',
  startsAt: '',
  endsAt: ''
};

const emptyRule = {
  name: '',
  scope: 'PRODUCT' as PriceRuleRow['scope'],
  ruleType: 'DISCOUNT_PERCENT' as PriceRuleRow['rule_type'],
  value: 5,
  productId: '' as number | '',
  departmentId: '' as number | ''
};

export default function PromotionsPage() {
  const api = useApi();
  const { can, notify } = useApp();
  const [promotions, setPromotions] = useState<PromotionRow[]>([]);
  const [rules, setRules] = useState<PriceRuleRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [promo, setPromo] = useState(emptyPromo);
  const [rule, setRule] = useState(emptyRule);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canSetPrices = can('prices.set');

  const load = useCallback(async () => {
    const [promoRows, ruleRows, productRows, departmentRows] = await Promise.all([
      api<PromotionRow[]>('mart.promotions.list', {}),
      api<PriceRuleRow[]>('mart.priceRules.list', {}),
      api<Product[]>('products.list', {}),
      api<DepartmentRow[]>('mart.departments.list', {})
    ]);
    if (promoRows) setPromotions(promoRows);
    if (ruleRows) setRules(ruleRows);
    if (productRows) setProducts(productRows);
    if (departmentRows) setDepartments(departmentRows);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePromotion(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.promotions.save', {
        name: promo.name,
        promoType: promo.promoType,
        value: Math.round(promo.value),
        productId: promo.productId || null,
        departmentId: promo.departmentId || null,
        startsAt: promo.startsAt || null,
        endsAt: promo.endsAt || null
      });
      notify('Promotion saved.', 'success');
      setPromo(emptyPromo);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the promotion.');
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api('mart.priceRules.save', {
        name: rule.name,
        scope: rule.scope,
        ruleType: rule.ruleType,
        value: Math.round(rule.value),
        productId: rule.productId || null,
        departmentId: rule.departmentId || null
      });
      notify('Price rule saved.', 'success');
      setRule(emptyRule);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the price rule.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <PageHead
        title="Promotions & Price Rules"
        subtitle="Supermarket module: what the shop charges, and when. Only the administrator can set prices."
      />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <div className="grid-2">
        <Card title={`Promotions (${promotions.length})`}>
          <DataTable<PromotionRow>
            rows={promotions}
            empty="No promotions yet."
            columns={[
              { key: 'name', label: 'Promotion' },
              { key: 'promo_type', label: 'Type' },
              {
                key: 'value',
                label: 'Value',
                align: 'right',
                render: (row) =>
                  row.promo_type === 'PERCENT'
                    ? `${row.value}%`
                    : row.promo_type === 'AMOUNT'
                      ? formatMoney(row.value)
                      : row.promo_type === 'BOGO'
                        ? 'Buy 1 get 1'
                        : `Multi-buy (${row.min_qty})`
              },
              { key: 'ends_at', label: 'Ends', render: (row) => (row.ends_at ? formatDate(row.ends_at) : '—') },
              {
                key: 'active',
                label: 'Status',
                render: (row) => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Active' : 'Off'}</Badge>
              }
            ]}
          />
          {canSetPrices ? (
            <form className="stack" style={{ marginTop: 14 }} onSubmit={savePromotion}>
              <div className="form-grid">
                <Field label="Name">
                  <Input value={promo.name} onChange={(e) => setPromo({ ...promo, name: e.target.value })} required />
                </Field>
                <Field label="Type">
                  <Select
                    value={promo.promoType}
                    onChange={(e) => setPromo({ ...promo, promoType: e.target.value as PromotionRow['promo_type'] })}
                  >
                    <option value="PERCENT">Percent off</option>
                    <option value="AMOUNT">Amount off (₦)</option>
                    <option value="BOGO">Buy one get one</option>
                    <option value="MULTIBUY">Multi-buy</option>
                  </Select>
                </Field>
                <Field label="Value" hint="Percent (1-100), kobo amount, or the multi-buy quantity.">
                  <Input
                    type="number"
                    min={0}
                    value={promo.value}
                    onChange={(e) => setPromo({ ...promo, value: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Product">
                  <Select
                    value={promo.productId}
                    onChange={(e) => setPromo({ ...promo, productId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">— none —</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Department">
                  <Select
                    value={promo.departmentId}
                    onChange={(e) => setPromo({ ...promo, departmentId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">— none —</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Starts">
                  <Input type="date" value={promo.startsAt} onChange={(e) => setPromo({ ...promo, startsAt: e.target.value })} />
                </Field>
                <Field label="Ends">
                  <Input type="date" value={promo.endsAt} onChange={(e) => setPromo({ ...promo, endsAt: e.target.value })} />
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                Add promotion
              </Button>
            </form>
          ) : (
            <p className="tiny muted">Only an administrator can create promotions.</p>
          )}
        </Card>

        <Card title={`Price rules (${rules.length})`}>
          <DataTable<PriceRuleRow>
            rows={rules}
            empty="No price rules yet."
            columns={[
              { key: 'name', label: 'Rule' },
              { key: 'scope', label: 'Applies to' },
              { key: 'rule_type', label: 'Type' },
              {
                key: 'value',
                label: 'Value',
                align: 'right',
                render: (row) =>
                  row.rule_type === 'DISCOUNT_PERCENT'
                    ? `${row.value}%`
                    : row.rule_type === 'DISCOUNT_AMOUNT'
                      ? formatMoney(row.value)
                      : formatMoney(row.value)
              },
              {
                key: 'requires_supervisor',
                label: 'Approval',
                render: (row) => (row.requires_supervisor ? <Badge tone="warn">Supervisor</Badge> : <Badge tone="neutral">Direct</Badge>)
              }
            ]}
          />
          {canSetPrices ? (
            <form className="stack" style={{ marginTop: 14 }} onSubmit={saveRule}>
              <div className="form-grid">
                <Field label="Name">
                  <Input value={rule.name} onChange={(e) => setRule({ ...rule, name: e.target.value })} required />
                </Field>
                <Field label="Scope">
                  <Select
                    value={rule.scope}
                    onChange={(e) => setRule({ ...rule, scope: e.target.value as PriceRuleRow['scope'] })}
                  >
                    <option value="PRODUCT">Product</option>
                    <option value="CATEGORY">Category</option>
                    <option value="DEPARTMENT">Department</option>
                  </Select>
                </Field>
                <Field label="Rule">
                  <Select
                    value={rule.ruleType}
                    onChange={(e) => setRule({ ...rule, ruleType: e.target.value as PriceRuleRow['rule_type'] })}
                  >
                    <option value="DISCOUNT_PERCENT">Discount %</option>
                    <option value="DISCOUNT_AMOUNT">Discount ₦</option>
                    <option value="SET_PRICE">Set price ₦</option>
                  </Select>
                </Field>
                <Field label="Value">
                  <Input
                    type="number"
                    min={0}
                    value={rule.value}
                    onChange={(e) => setRule({ ...rule, value: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Product">
                  <Select
                    value={rule.productId}
                    onChange={(e) => setRule({ ...rule, productId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">— none —</option>
                    {products.map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Department">
                  <Select
                    value={rule.departmentId}
                    onChange={(e) => setRule({ ...rule, departmentId: e.target.value ? Number(e.target.value) : '' })}
                  >
                    <option value="">— none —</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Button type="submit" size="sm" disabled={busy}>
                Add price rule
              </Button>
            </form>
          ) : (
            <p className="tiny muted">
              Prices are set by the administrator. Supervisors may approve an override at the till but cannot change prices.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
