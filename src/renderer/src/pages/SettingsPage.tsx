import { useEffect, useState } from 'react';
import { call } from '../api';
import { useApi, useApp } from '../state';
import { RECEIPT_LAYOUTS, type ReceiptLayout, type SettingsPayload } from '../../../shared/types';
import { formatMoney, moneyToInput, parseMoneyInput } from '../../../shared/money';
import { Alert, Badge, Button, Card, Field, Input, PageHead, Select } from '../components/ui';

const MAX_LOGO_BYTES = 200 * 1024;

export default function SettingsPage() {
  const api = useApi();
  const { state, notify, refresh } = useApp();
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [returnLimit, setReturnLimit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState('');
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [printers, setPrinters] = useState<{ name: string; displayName: string }[] | null>(null);
  const [printerNote, setPrinterNote] = useState<string | null>(null);

  function pickLogo(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !settings) return;
    if (file.size > MAX_LOGO_BYTES) {
      setError('The store logo must be smaller than 200 KB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setSettings({ ...settings, storeLogo: reader.result });
      setError(null);
    };
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    void (async () => {
      const data = await api<SettingsPayload>('settings.read');
      if (data) {
        setSettings(data);
        setReturnLimit(moneyToInput(data.returnLimit));
      }
    })();
  }, [api]);

  // The preview follows the draft: type a new store name and the paper changes
  // before anything is saved. Debounced so a keystroke does not spam main.
  useEffect(() => {
    if (!settings) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api<{ html: string; dirty: boolean }>('settings.preview', { draft: settings });
          if (!result) return;
          setPreview(result.html);
          setPreviewNote(result.dirty ? 'Unsaved changes — this is a preview.' : null);
        } catch (err) {
          setPreview('<!doctype html><html><body style="font-family:sans-serif;padding:16px;color:#66707f">The preview could not be built.</body></html>');
          setPreviewNote(err instanceof Error ? err.message : 'Preview failed.');
        }
      })();
    }, 350);
    return () => clearTimeout(timer);
  }, [api, settings]);

  async function loadPrinters() {
    setPrinterNote(null);
    try {
      const list = await api<{ name: string; displayName: string }[]>('print.printers');
      setPrinters(list);
      if (!list?.length) setPrinterNote('Windows did not report any printers. Type a name instead.');
    } catch (err) {
      setPrinters([]);
      setPrinterNote(err instanceof Error ? err.message : 'Could not read the printer list.');
    }
  }

  async function save() {
    if (!settings) return;
    setError(null);
    setBusy(true);
    try {
      const updated = await call<SettingsPayload>('settings.update', {
        ...settings,
        returnLimit: parseMoneyInput(returnLimit)
      });
      setSettings(updated);
      await refresh();
      notify('Settings saved. New documents will use these details.', 'success');
      setReturnLimit(moneyToInput(updated.returnLimit));
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save settings.', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!settings) {
    return (
      <div className="stack">
        <PageHead title="Settings" />
        <Card>
          <div className="empty">Loading settings…</div>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Settings"
        subtitle="Your store identity, receipt wording and the rules for approvals. Existing documents keep the details captured when they were created."
      />

      <Alert tone="info">
        Store name is printed on every receipt, invoice, credit note and report. Changing it here does not
        alter documents already issued. Only the administrator can edit these details.
      </Alert>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card
        title="Live receipt preview"
        actions={<Badge tone={previewNote ? 'warn' : 'success'}>{previewNote ?? 'Matches the saved settings'}</Badge>}
      >
        <iframe className="doc-preview" title="Receipt preview" srcDoc={preview} style={{ height: '52vh' }} />
        <div className="tiny muted" style={{ marginTop: 8 }}>
          This is the paper your till prints: store name, address, phone, the footer, thank-you note, VAT and the
          “Powered by” line, all from the fields below. Change anything and the preview follows before you save.
        </div>
      </Card>

      <Card title="Store identity">
        <div className="form-grid">
          <Field label="Store name (required)">
            <Input
              value={settings.storeName}
              onChange={(e) => setSettings({ ...settings, storeName: e.target.value })}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={settings.storePhone}
              onChange={(e) => setSettings({ ...settings, storePhone: e.target.value })}
            />
          </Field>
          <Field label="Address">
            <Input
              value={settings.storeAddress}
              onChange={(e) => setSettings({ ...settings, storeAddress: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={settings.storeEmail}
              onChange={(e) => setSettings({ ...settings, storeEmail: e.target.value })}
            />
          </Field>
          <Field
            label={
              state?.license.edition === 'PHARMACY'
                ? 'PCN / NAFDAC licence number'
                : state?.license.edition === 'SUPERMARKET'
                  ? 'Business registration number'
                  : 'Regulatory / business licence number'
            }
          >
            <Input
              value={settings.storeLicenceNo}
              onChange={(e) => setSettings({ ...settings, storeLicenceNo: e.target.value })}
            />
          </Field>
          <Field label="Tax / VAT number">
            <Input
              value={settings.storeVatNo}
              onChange={(e) => setSettings({ ...settings, storeVatNo: e.target.value })}
            />
          </Field>
          <Field label="Store logo" hint="PNG, JPEG, WebP or SVG up to 200 KB. Printed above the store name.">
            <div className="row tight">
              {settings.storeLogo ? <img src={settings.storeLogo} alt="" style={{ height: 32 }} /> : null}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={pickLogo} />
              {settings.storeLogo ? (
                <Button size="sm" variant="ghost" type="button" onClick={() => setSettings({ ...settings, storeLogo: '' })}>
                  Remove
                </Button>
              ) : null}
            </div>
          </Field>
          <Field label="Receipt footer">
            <Input
              value={settings.receiptFooter}
              onChange={(e) => setSettings({ ...settings, receiptFooter: e.target.value })}
            />
          </Field>
          <Field label="Thank-you note">
            <Input
              value={settings.thankYouNote}
              onChange={(e) => setSettings({ ...settings, thankYouNote: e.target.value })}
            />
          </Field>
        </div>
      </Card>

      <Card title="Operational rules">
        <div className="form-grid">
          <Field
            label="Cashier return limit (₦)"
            hint="Returns above this amount need supervisor approval."
          >
            <Input value={returnLimit} onChange={(e) => setReturnLimit(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Return window (days)" hint="Returns after this many days need approval.">
            <Input
              type="number"
              min={0}
              value={settings.returnWindowDays}
              onChange={(e) => setSettings({ ...settings, returnWindowDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Low stock alerts" hint="Warn when stock reaches the reorder level.">
            <Select
              value={settings.lowStockAlerts ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, lowStockAlerts: e.target.value === 'yes' })}
            >
              <option value="yes">On</option>
              <option value="no">Off</option>
            </Select>
          </Field>
          <Field label="Auto sign-out after inactivity" hint="Cashiers are signed out after this many idle minutes.">
            <Select
              value={settings.idleTimeoutMinutes}
              onChange={(e) => setSettings({ ...settings, idleTimeoutMinutes: Number(e.target.value) })}
            >
              {[5, 10, 15, 20, 30, 45, 60, 120].map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes} minutes
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Licence expiry warning (days)">
            <Input
              type="number"
              min={1}
              value={settings.licenseExpiryWarningDays}
              onChange={(e) => setSettings({ ...settings, licenseExpiryWarningDays: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="row tight" style={{ marginTop: 16 }}>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
          <span className="small muted">
            Cashier return limit is currently {formatMoney(parseMoneyInput(returnLimit))}
          </span>
        </div>
      </Card>

      <Card title="Till & receipts">
        <div className="form-grid">
          <Field label="VAT" hint="When on, VAT is added on top of the discounted subtotal.">
            <Select
              value={settings.vatEnabled ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, vatEnabled: e.target.value === 'yes' })}
            >
              <option value="no">Off</option>
              <option value="yes">On</option>
            </Select>
          </Field>
          <Field label="VAT rate (%)">
            <Input
              type="number"
              min={0}
              step="0.01"
              value={settings.vatRate}
              onChange={(e) => setSettings({ ...settings, vatRate: Number(e.target.value) })}
            />
          </Field>
          <Field
            label="Discount cap for non-admins (%)"
            hint="Cashiers and supervisors cannot discount beyond this without an administrator."
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={settings.maxDiscountPercent}
              onChange={(e) => setSettings({ ...settings, maxDiscountPercent: Number(e.target.value) })}
            />
          </Field>
          <Field label="Default receipt layout">
            <Select
              value={settings.receiptLayout}
              onChange={(e) => setSettings({ ...settings, receiptLayout: e.target.value as ReceiptLayout })}
            >
              {RECEIPT_LAYOUTS.map((layout) => (
                <option key={layout.value} value={layout.value}>
                  {layout.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Cash payments">
            <Select
              value={settings.paymentCash ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, paymentCash: e.target.value === 'yes' })}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>
          <Field label="Bank transfer payments">
            <Select
              value={settings.paymentTransfer ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, paymentTransfer: e.target.value === 'yes' })}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>
          <Field label="Card / POS payments">
            <Select
              value={settings.paymentPos ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, paymentPos: e.target.value === 'yes' })}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>
          <Field label="Credit sales" hint="Only registered customers with a credit limit can buy on account.">
            <Select
              value={settings.paymentCredit ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, paymentCredit: e.target.value === 'yes' })}
            >
              <option value="yes">Enabled</option>
              <option value="no">Disabled</option>
            </Select>
          </Field>
          <Field label="“Powered by” footer" hint="Small Infoflex line under the receipt footer. It never replaces your store name.">
            <Select
              value={settings.poweredByFooter ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, poweredByFooter: e.target.value === 'yes' })}
            >
              <option value="yes">Show</option>
              <option value="no">Hide</option>
            </Select>
          </Field>
          <Field label="Customer-facing display" hint="Offers a large second-screen view of the basket and total.">
            <Select
              value={settings.customerDisplay ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, customerDisplay: e.target.value === 'yes' })}
            >
              <option value="no">Off</option>
              <option value="yes">On</option>
            </Select>
          </Field>
          {state?.features.supermarket ? (
            <Field label="Require an open cashier shift" hint="Block sales until the cashier opens a shift with a float.">
              <Select
                value={settings.requireShift ? 'yes' : 'no'}
                onChange={(e) => setSettings({ ...settings, requireShift: e.target.value === 'yes' })}
              >
                <option value="no">Off</option>
                <option value="yes">On</option>
              </Select>
            </Field>
          ) : null}
          {state?.features.supermarket ? (
            <>
              <Field label="Loyalty points per ₦100">
                <Input
                  type="number"
                  min={0}
                  value={settings.loyaltyPointsPer100}
                  onChange={(e) => setSettings({ ...settings, loyaltyPointsPer100: Number(e.target.value) })}
                />
              </Field>
              <Field label="Value of one point (₦)">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={moneyToInput(settings.loyaltyPointValue)}
                  onChange={(e) =>
                    setSettings({ ...settings, loyaltyPointValue: parseMoneyInput(e.target.value) })
                  }
                />
              </Field>
              <Field label="Redeem points at the till">
                <Select
                  value={settings.loyaltyRedeemEnabled ? 'yes' : 'no'}
                  onChange={(e) => setSettings({ ...settings, loyaltyRedeemEnabled: e.target.value === 'yes' })}
                >
                  <option value="yes">Allowed</option>
                  <option value="no">Off</option>
                </Select>
              </Field>
            </>
          ) : null}
        </div>
        <div className="row tight" style={{ marginTop: 16 }}>
          <Button onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save till settings'}
          </Button>
        </div>
      </Card>

      <Card title="Printing & hardware">
        <div className="form-grid">
          <Field
            label="Receipt printer"
            hint="Leave on “Ask each time” to pick a printer for every print."
          >
            <Select
              value={settings.printerName}
              onChange={(e) => setSettings({ ...settings, printerName: e.target.value })}
            >
              <option value="">Ask each time (system dialog)</option>
              {printers?.map((printer) => (
                <option key={printer.name} value={printer.name}>
                  {printer.displayName}
                </option>
              ))}
              {settings.printerName && !printers?.some((printer) => printer.name === settings.printerName) ? (
                <option value={settings.printerName}>{settings.printerName} (not detected now)</option>
              ) : null}
            </Select>
          </Field>
          <Field label="Print without the dialog" hint="Only when a printer is pinned above. Sends receipts straight to it.">
            <Select
              value={settings.silentPrint ? 'yes' : 'no'}
              onChange={(e) => setSettings({ ...settings, silentPrint: e.target.value === 'yes' })}
            >
              <option value="no">Show the Windows print dialog</option>
              <option value="yes">Print straight to the chosen printer</option>
            </Select>
          </Field>
          <Field label="&nbsp;">
            <div className="row tight">
              <Button size="sm" variant="ghost" type="button" onClick={() => void loadPrinters()}>
                Find printers
              </Button>
              {printers ? <span className="tiny muted">{printers.length} found</span> : null}
            </div>
          </Field>
          {state?.features.supermarket ? (
            <Field label="Shelf / scale label printer" hint="Used for price and weight labels (informational).">
              <Input
                value={settings.labelPrinterName}
                placeholder="Label printer, e.g. Zebra GK420d"
                onChange={(e) => setSettings({ ...settings, labelPrinterName: e.target.value })}
              />
            </Field>
          ) : null}
        </div>
        {printerNote ? (
          <div className="tiny muted" style={{ marginTop: 8 }}>
            {printerNote}
          </div>
        ) : null}

        {state?.features.supermarket ? (
          <>
            <div className="card-title" style={{ fontSize: 13, fontWeight: 650, margin: '18px 0 6px' }}>
              Weighing scale barcodes
            </div>
            <div className="form-grid">
              <Field label="Prefix digit" hint="The first digit your scale prints on a weight label (often 2).">
                <Input
                  value={settings.scalePrefix}
                  inputMode="numeric"
                  maxLength={3}
                  onChange={(e) => setSettings({ ...settings, scalePrefix: e.target.value.replace(/[^0-9]/g, '') })}
                />
              </Field>
              <Field label="PLU digits" hint="How many of the following digits are the item's PLU code.">
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.scalePluDigits}
                  onChange={(e) => setSettings({ ...settings, scalePluDigits: Number(e.target.value) })}
                />
              </Field>
              <Field label="Weight digits" hint="Grams, read from the rest of the barcode.">
                <Input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.scaleWeightDigits}
                  onChange={(e) => setSettings({ ...settings, scaleWeightDigits: Number(e.target.value) })}
                />
              </Field>
              <Field label="Example" hint="What the till expects for that layout.">
                <div className="small" style={{ paddingTop: 8 }}>
                  <strong>
                    {settings.scalePrefix}
                    {'9'.repeat(Math.max(1, settings.scalePluDigits))}
                    {'0'.repeat(Math.max(0, settings.scaleWeightDigits - 3))}250
                  </strong>{' '}
                  = 250&nbsp;g
                </div>
              </Field>
            </div>
          </>
        ) : null}
      </Card>

      {state?.features.pharmacy ? (
        <Card title="Pharmacy options">
          <div className="form-grid">
            <Field label="Expiry alert (days)" hint="Batches expiring within this many days are flagged on the dashboard and the expiry report.">
              <Input
                type="number"
                min={1}
                max={730}
                value={settings.expiryAlertDays}
                onChange={(e) => setSettings({ ...settings, expiryAlertDays: Number(e.target.value) })}
              />
            </Field>
          </div>
        </Card>
      ) : null}

      {state?.features.supermarket ? (
        <Card title="Supervisor approvals">
          <div className="form-grid">
            <Field
              label="Approval valid for (minutes)"
              hint="How long a supervisor's approval token works at the till before it expires."
            >
              <Input
                type="number"
                min={1}
                max={60}
                value={settings.approvalTtlMinutes}
                onChange={(e) => setSettings({ ...settings, approvalTtlMinutes: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Administrator may approve their own override"
              hint="Supervisors and cashiers never can, whatever this says."
            >
              <Select
                value={settings.supervisorSelfApproval ? 'yes' : 'no'}
                onChange={(e) => setSettings({ ...settings, supervisorSelfApproval: e.target.value === 'yes' })}
              >
                <option value="yes">Allowed</option>
                <option value="no">Needs a second person</option>
              </Select>
            </Field>
            <Field label="Currency" hint="Nigerian Naira is fixed for this build; amounts are stored in kobo.">
              <Input value="NGN — ₦ (2 decimals)" readOnly disabled />
            </Field>
          </div>
        </Card>
      ) : null}

      <Card title="Edition & licence">
        <div className="form-grid">
          <div>
            <div className="tiny muted">Product</div>
            <div style={{ fontWeight: 650 }}>{state?.productName}</div>
          </div>
          <div>
            <div className="tiny muted">Edition</div>
            <div style={{ fontWeight: 650 }}>{state?.license.edition ?? '—'}</div>
          </div>
          <div>
            <div className="tiny muted">Licensed to</div>
            <div style={{ fontWeight: 650 }}>{state?.license.customerName ?? '—'}</div>
          </div>
          <div>
            <div className="tiny muted">Period</div>
            <div style={{ fontWeight: 650 }}>
              {state?.license.startsOn ?? '—'} → {state?.license.endsOn ?? '—'}
            </div>
          </div>
          <div>
            <div className="tiny muted">Expires</div>
            <div style={{ fontWeight: 650 }}>
              {state?.license.expiresAt ? new Date(state.license.expiresAt).toLocaleDateString() : '—'}
            </div>
          </div>
          <div>
            <div className="tiny muted">Status</div>
            <div style={{ fontWeight: 650 }}>
              <Badge tone={state?.license.state === 'VALID' ? 'success' : 'warn'}>{state?.license.state ?? '—'}</Badge>{' '}
              {typeof state?.license.daysRemaining === 'number' ? `${state.license.daysRemaining} day(s) left` : ''}
            </div>
          </div>
        </div>
        <div className="small muted" style={{ marginTop: 12 }}>
          Modules enabled: {state?.features.pharmacy ? 'pharmacy ' : ''}
          {state?.features.supermarket ? 'supermarket ' : ''}
          {state?.features.wholesale ? 'wholesale ' : ''}
          {state?.features.prescriptions ? 'prescriptions' : ''}
        </div>
      </Card>
    </div>
  );
}
