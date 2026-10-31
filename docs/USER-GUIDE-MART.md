# Infoflex Mart — user guide

**For:** the administrator and the cashiers of a supermarket running the
**SUPERMARKET** edition.

Everything happens on the shop's own computer. No internet connection, no
subscription, no website login.

> Figures are captured from the real screens with `npm run shots:guide`
> ([details](screenshots/README.md)). Each caption describes what is on screen,
> so the guide works with or without the pictures.
>
> **This guide contains no passwords.** The installer password and the vendor
> master password are held by Infoflex only.

---

## 1. Signing in

![Login screen](screenshots/mart-00-login.png)

*Figure 1 — the sign-in screen over the shop's logo background. The shop name is
above the fields; the programme name on the left is **Infoflex Mart**.*

1. Type your **username** and **password**, press **Sign in**.
2. A temporary password from the administrator must be changed before the till
   opens.
3. Repeated wrong passwords lock the account briefly; the message says for how
   long.
4. Walking away? Just leave it: the till signs you out after the idle limit and
   keeps your basket.

**Cashiers see:** Point of Sale, Sales & Receipts, Returns, Customers, Products
(view only), Departments, Promotions, Stock & Purchases (view only),
Purchase Orders, Stocktake, Inventory, Loyalty, Shifts & Drawer, Reports (own
till only).
**Administrators additionally see:** Users, Settings, Backup & Restore, Audit
Trail, Licence — and cost price, gross profit and stock adjustments.

---

## 2. The dashboard

![Dashboard](screenshots/mart-01-dashboard.png)

*Figure 2 — takings for today, sales count, low stock, today's promotions and the
licence status.*

Read-only; every warning links to the screen that deals with it.

---

## 3. Selling at the counter (cashier)

![Point of sale](screenshots/mart-02-pos.png)

*Figure 3 — the till: search and cart on the left, totals, discount and pay on
the right.*

| Step | What to do |
| --- | --- |
| Find an item | Type a name, scan the barcode, or type a **PLU** for loose goods |
| Weighed goods | Scan the scale barcode or pick the PLU: the till asks for the weight in kilograms and prices it at the price per kg |
| Quantity | Type the number, or press the **+ / −** buttons on the cart line |
| Discount | Amount or percentage; a cashier's discount is capped by the administrator's limit |
| Customer | Optional, but required for credit and for loyalty points |
| Pay | **F9**, choose Cash / Transfer / POS card / Credit, enter the amount tendered, read the change |
| Print | **F10** reprints; the receipt prints automatically after the sale if enabled |

- **F2** jumps to the search box, **F9** pays, **F10** prints.
- **Promotions** (Buy-one-get-one, percentage off, multi-buy) apply automatically
  — only the best single offer is applied to a line, never two at once.
- **Expired or out-of-stock items cannot be sold.**
- A sale is **never deleted**; a supervisor voids it with a reason.

### The receipt

Your shop's name as set up, address, phone, then items, total in naira with two
decimals, payment lines, change, your footer and the optional "Powered by
Infoflex" line. Reprints are snapshots of the original sale.

---

## 4. Catalogue (administrator)

![Products](screenshots/mart-03-products.png)

*Figure 4 — the product list with department, shelf, prices and stock.*

- **Products:** name, barcode(s), department, shelf/aisle, brand, unit, cost,
  selling price, wholesale price, reorder level, variants, PLU and price per kg
  for loose goods.
- **Departments:** the aisles the shop is organised by — a product belongs to
  one, and reports can be filtered by it.
- **Promotions:** percentage off, buy-one-get-one and multi-buy, each with a
  start and end date. Only the best single offer applies to each line.
- Only the **Administrator** may add goods or change prices. Cashiers can look
  but not touch; supervisors can approve a price override at the till.

### Departments

![Departments](screenshots/mart-10-departments.png)

*Figure 5 — departments with shelf locations.*

---

## 5. Stock, stocktake and purchase orders

![Inventory](screenshots/mart-04-inventory.png)

*Figure 6 — live stock per item with the movement ledger.*

- **Stock & Purchases → Receive stock** books in a delivery.
- **Purchase Orders**: raise an order to a supplier, then receive against it; the
  goods-received note updates stock and cost.
- **Stocktake**: capture a count per line (type the counted quantity, or scan
  each unit), then finish the count. A **variance report** shows expected vs
  counted and the value of the difference; only an administrator can post the
  adjustments, and each needs a reason.
- **Adjust** (administrator only) covers damaged/lost/correction — with a
  mandatory reason. Cashiers and supervisors cannot adjust stock.

![Stocktake](screenshots/mart-10-stocktake.png)

*Figure 7 — a stocktake in progress with the variance column.*

---

## 6. Shifts and the cash drawer

**Shifts & Drawer**: open a shift with a float, and record pay-ins and pay-outs
as they happen. **Close shift** produces a counted-vs-expected report you can
print and sign. Cash movements always record who did what.

---

## 7. Loyalty

**Loyalty** (administrator) enrols customers as members. Points accrue
automatically on paid sales, and a member's points can be seen at the till when
you pick the customer. Redeeming points is a normal discount limited by the
administrator's cap.

---

## 8. Returns and voids

1. **Returns → New return**, enter the receipt number, tick the lines, pick a
   reason and whether the goods go back on the shelf.
2. Outside the cashier's limit or the return window the return waits in the
   supervisor approval queue, in the same screen.
3. A credit note prints with the shop name.

Voids live in **Sales & Receipts**: pick the sale, **Void**, give a reason.
Nothing is deleted and everything is audited.

---

## 9. Reports

![Reports](screenshots/mart-06-reports.png)

*Figure 8 — the daily summary; the shop name prints at the top.*

Daily summary (takings, sales, returns, payment split, cashier breakdown),
monthly, stock valuation, department performance, promotion take-up and the
audit trail. Everything prints with the shop name and exports to Excel.

---

## 10. The shop's name and settings (administrator)

![Settings](screenshots/mart-08-settings.png)

*Figure 9 — Settings with the store-name field and a live receipt preview.*

- **Settings → Store name (required).** Printed on every receipt, invoice,
  credit note and report. Renaming the shop does **not** change documents already
  issued.
- Address, phone, receipt footer, the "Powered by Infoflex" switch, payment
  methods, discount ceiling, return window and limit, weighing-scale barcodes,
  printer options and the idle timeout are all on this screen.

---

## 11. Users (administrator)

![Users](screenshots/mart-07-users.png)

*Figure 10 — the user list with roles and password resets.*

- Roles: **Administrator**, **Supervisor**, **Cashier**.
- Add a user with a temporary password; they change it at first sign-in.
- **Reset password**, **Disable**, and role changes are all audited.
- Supervisors approve voids, refunds and price overrides. They cannot add users,
  change prices or adjust stock.

---

## 12. Backups (administrator)

![Backup](screenshots/mart-09-backup.png)

- A backup runs once a day automatically into `%APPDATA%\Infoflex\backups\`.
- **Backup now** for an extra copy before a stocktake or a big delivery; copy it
  to a USB stick.
- **Restore** requires typing the shop name to confirm.
- Uninstalling the app leaves the data folder alone.

---

## 13. Licence

**Licence** shows the edition, customer, period and days remaining, and takes a
renewal code. When it expires the selling screens lock but data and backups stay
reachable. If the clock is moved backwards, the app locks and asks for the
vendor master password.

---

## 14. What a cashier must never do

- Share a sign-in — every sale, return and void is tied to the signed-in user.
- Leave the till signed in while away; press **Sign out**.
- Delete or edit a sale; void it and say why.
- Change a price at the counter; ask the administrator.

---

*Infoflex Mart runs on Windows 10 and 11. **Audit Trail** answers most "why is
this number different?" questions — start there.*
