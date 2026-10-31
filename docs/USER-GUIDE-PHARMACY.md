# Infoflex Pharm — user guide

**For:** the administrator and the cashiers of a pharmacy running the
**PHARMACY** edition.

Everything in this guide happens on the shop's own computer. The till needs no
internet connection, no subscription and no login to any website.

> Figures are captured from the real screens with `npm run shots:guide`
> ([details](screenshots/README.md)). Each caption describes what is on screen,
> so the guide works with or without the pictures.
>
> **This guide contains no passwords.** The installer password and the vendor
> master password are held by Infoflex only.

---

## 1. Signing in

![Login screen](screenshots/pharmacy-00-login.png)

*Figure 1 — the sign-in screen. Your shop's name is shown above the fields, on
the left the programme name is **Infoflex Pharm**.*

1. Type your **username** and **password** and press **Sign in** (or Enter).
2. The first time an administrator creates an account for you, the password is
   temporary: you are asked to choose your own before anything else opens.
3. Three wrong passwords in a row locks the account for a short while; the
   message tells you how long. Ask the administrator to reset it if you are
   stuck.
4. Leaving the till idle longer than the configured limit signs you out
   automatically. Nothing is lost — your basket is held and restored.

**What a cashier can see:** Point of Sale, Sales & Receipts, Returns, Customers,
Products (view only), Stock & Purchases (view only), Inventory, Batches &
Expiry, Reports (own till only), Shifts & Drawer.
**What only an administrator sees:** Users, Settings, Backup & Restore, Audit
Trail, Licence, and the cost price / gross profit columns everywhere.

---

## 2. The dashboard

![Dashboard](screenshots/pharmacy-01-dashboard.png)

*Figure 2 — today's takings, the number of sales, low-stock and near-expiry
warnings, and the licence status with the days remaining.*

The dashboard is read-only. Click any warning to jump to the screen that fixes
it (for example a near-expiry batch opens **Batches & Expiry**).

---

## 3. Selling at the counter (cashier)

![Point of sale](screenshots/pharmacy-02-pos.png)

*Figure 3 — the till. Search box and cart on the left, totals and the pay button
on the right, shortcuts printed under the heading.*

| Step | What to do |
| --- | --- |
| Find an item | Type part of the name or scan the barcode, then click the row (or press **Enter** on the highlighted result) |
| Change quantity | Type the number in the quantity box on the cart line |
| Discount | Type an amount or a percentage in **Discount**. A cashier is limited by the maximum the administrator set; the box says so |
| Customer | Optional. Required for credit sales and for loyalty points |
| Pay | **F9** (or the big button). Choose Cash, Transfer, POS card or Credit, enter the amount tendered, and the change due is shown |
| Print | **F10** prints the receipt again; the receipt prints automatically when the sale completes if that is switched on |

Rules the till enforces for you:

- **Nothing is ever deleted.** A mistake is **voided** by a supervisor, which
  puts the stock back and keeps the record.
- **Expired stock is never sold** — the till refuses to add a batch whose expiry
  date has passed.
- **Stock leaves the shelf in the same moment as the money is taken.** If the
  payment fails, nothing is deducted.
- **F2** jumps to the search box from anywhere in the sale.

### The receipt

The receipt header is **your shop's name exactly as it was set up**, followed by
your address and phone, then the items, the total in naira with two decimals,
the payment lines, the change and your receipt footer. A reprint always shows
the name, prices, cashier and time **of the original sale**, even if the shop has
since been renamed.

If the shop name is missing, the till refuses to print and tells you to open
**Settings** — that is deliberate: a receipt with no shop name is not a receipt.

---

## 4. Products and prices (administrator)

![Products](screenshots/pharmacy-03-products.png)

*Figure 4 — the product list. Administrators see cost, selling and wholesale
prices and the gross profit; cashiers see the selling price only.*

- **Add a product:** code (or let it generate), barcode, name, brand, pack size
  (e.g. *card of 10 x 1 blister*), unit, category, supplier, reorder level,
  cost price, selling price, wholesale price and minimum wholesale quantity,
  prescription flag.
- **Change a price:** open the product, change the selling price, save. The
  change is audited; existing receipts keep the old price.
- **CSV / Excel:** **Import** accepts the downloadable template and reports every
  row it could not read, with the reason — nothing is imported until you accept
  the report.
- **Cashiers cannot change prices.** Neither can supervisors: only the
  Administrator role may add goods or set prices.

### Batches and expiry (pharmacy only)

![Batches](screenshots/pharmacy-10-batches.png)

*Figure 5 — one row per batch: product, batch number, quantity, expiry, days
left, supplier.*

- Receive stock per batch with its expiry date — **Stock & Purchases →
  Receive stock**.
- The till sells the batch that expires first (first-expiry-first-out).
- Expired batches stay visible but are blocked from sale; use **Write off** with
  a reason to clear them out.

---

## 5. Stock

**Inventory** (everyone) shows the live quantity of every item and its movement
ledger: what came in, what went out, on which sale or adjustment.

**Stock & Purchases → Adjust** (administrator only) records damaged, lost or
corrected stock. A **reason is mandatory** and appears in the audit trail. A
cashier cannot adjust stock; a supervisor cannot either.

---

## 6. Returns and voids

1. **Returns → New return**, enter the receipt number.
2. Tick the lines coming back and the quantity, choose a reason.
3. The till checks the cashier's limit (amount and the number of days after the
   sale). Above the limit, or outside the window, the return waits for a
   supervisor's approval in the same screen.
4. Choose refund method, and whether the goods go back on the shelf. A credit
   note prints with the shop name.

**Void a sale** from **Sales & Receipts**: pick the sale, **Void**, give a
reason. The sale and its stock are reversed, nothing is deleted, the audit trail
records who did it.

---

## 7. Reports

![Reports](screenshots/pharmacy-06-reports.png)

*Figure 6 — the daily summary. The shop name prints at the top of every report.*

| Report | What it answers |
| --- | --- |
| Daily summary | takings, number of sales, returns, payment split, cashier breakdown |
| Monthly | one month at a glance, day by day |
| Stock | what is on the shelf and what it cost |
| Expiry | what expires in the next 30/60/90 days |
| Audit | who changed what, when |

Every report prints with the shop name and can be exported to Excel.

---

## 8. The shop's name and the receipt footer (administrator)

![Settings](screenshots/pharmacy-08-settings.png)

*Figure 7 — Settings. The store name sits at the top, with a live receipt
preview beside it.*

- **Settings → Store name (required).** This is the name printed on every
  receipt, invoice, credit note and report. Change it here when the shop is
  renamed; **documents already issued keep the old name** — they are snapshots.
- Address, phone, receipt footer, and the optional **"Powered by Infoflex"**
  line (on by default, never replaces the shop name) are on the same screen.
- Payment methods you accept, the cashier discount ceiling, the return window
  and return limit, the idle timeout and the printer options are all here.

---

## 9. Users and passwords (administrator)

![Users](screenshots/pharmacy-07-users.png)

*Figure 8 — user list with role, status and the reset-password action.*

- **Add user:** name, username, role (**Administrator**, **Supervisor**,
  **Cashier**), temporary password. The user chooses a new password at first
  sign-in.
- **Reset password** issues a new temporary password; **Disable** blocks the
  account without deleting its history.
- Supervisors may approve voids, refunds and price overrides — they may **not**
  add users, change prices or adjust stock.

---

## 10. Backups (administrator)

![Backup](screenshots/pharmacy-09-backup.png)

- The app backs itself up once a day into
  `%APPDATA%\Infoflex\backups\`, and keeps a rolling set.
- **Backup now** creates one immediately. Copy it to a USB stick or another
  folder at the end of the day.
- **Restore** asks you to type the shop name to confirm, because it replaces the
  current data. Restoring never needs the internet.
- Uninstalling the app **does not** delete the data folder.

---

## 11. Licence

**Licence** (administrator) shows the edition, the customer name, the period and
the days remaining. **Renew** takes a new activation code from Infoflex.

- When the licence expires the selling screens lock. Your data, backups and the
  Licence screen stay reachable.
- If the computer's clock is moved backwards the app locks and asks for the
  vendor master password — that is a tamper check, not a fault.

---

## 12. What a cashier must never do

- Never share a sign-in: every sale, return and void is recorded against the
  signed-in user.
- Never leave the till signed in when you walk away — press **Sign out**.
- Never delete or edit a sale: void it and say why.
- Never change a price at the counter: ask the administrator.

---

*Infoflex Pharm runs on Windows 10 and 11. If something looks wrong, open
**Audit Trail** first — it usually shows exactly which action produced the
number you are looking at.*
