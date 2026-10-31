# Operations guide

## 1. Building and installing

```bash
npm ci
npm run build            # typecheck + production bundles in out/
npm run dist:win         # NSIS installer -> release/Infoflex-Setup-<version>.exe
```

- Build the Windows installer on Windows (or Linux with wine installed).
- The installer is branded **Infoflex**, installs per-user by default, offers a
  directory choice, creates desktop + start-menu shortcuts and shows the EULA.
- `deleteAppDataOnUninstall: false` — uninstalling never destroys the shop's
  database.

`npm run dev` runs the Electron app against the Vite dev server.
`npm run dev:web` runs the same UI + API in a browser (review/QA only).

### Native SQLite module

| Runtime | Command |
| --- | --- |
| Electron app | `npm run rebuild:electron` |
| Tests / browser harness | `npm run rebuild:node` |

`postinstall` attempts the Electron build and prints guidance if it cannot (e.g.
an offline machine without Electron headers).

## 2. First install (customer)

1. Run `Infoflex-Setup-x.y.z.exe` and complete the installer.
2. Launch Infoflex. The activation screen appears — nothing else is reachable.
3. Enter the **vendor master password** supplied by Infoflex, then either paste
   the activation code from the vendor, or choose edition/customer/expiry if you
   are the vendor issuing on site.
4. Complete first-run setup: **store name** (required — printed on every
   document), address, phone, receipt footer, and the first administrator
   account.

The window title, login screen and sidebar then show the edition's product name
(`Infoflex Pharm`, `Infoflex Mart` or `Infoflex Pharm & Mart`).

## 3. Issuing and renewing licences (vendor)

```bash
# 12 months, pharmacy edition
VENDOR_MASTER_PASSWORD='...' npm run vendor:license -- \
  --edition PHARMACY --customer "Grace Pharmacy, Ikeja" --months 12

# explicit expiry, both editions, write to a file
VENDOR_MASTER_PASSWORD='...' npm run vendor:license -- \
  --edition BOTH --customer "Uche Stores" --expires 2027-12-31 --out uche.txt
```

Send the resulting `IFX1…` string. The customer pastes it on the activation or
Licence screen together with the master password.

Renewals: same screen, new code (or new expiry in vendor issue mode). The app
warns 30 days before expiry, then blocks everything except activation when the
licence lapses. No grace period — an expired licence cannot sell.

Changing the master password / re-keying:

```bash
VENDOR_MASTER_PASSWORD='new-password' npm run vendor:keys
```

This generates a **new signing key**. Licences issued with the old key will fail
verification, so re-key only when you intend to re-issue licences (document it in
your records).

## 4. Daily use

- **Sign in** with your own account. Cashiers land straight on Point of Sale.
- **Sell**: search or scan, adjust quantity, apply a discount, choose payment
  method, enter amount paid, complete. The receipt opens for printing; stock is
  already deducted.
- **Return**: Returns → find the receipt → choose quantities and restock →
  reason. Above the cashier limit (Settings → Operational rules, default
  ₦20,000) or outside the return window it waits for approval.
- **Void**: Sales & Receipts → open the sale → Request void. A supervisor or
  administrator approves; stock is restored; the receipt is stamped VOIDED and
  stays on record.
- **Price override** in the supermarket edition needs a supervisor; in the
  pharmacy edition only the administrator has that right.
- **Reports**: *Reports → Daily summary* shows any trading day (net sales, money
  taken, discounts, returns, payment split, retail vs wholesale, sales per user);
  *Monthly summary* adds a day table and a daily chart; *All reports* lists every
  report your role may read. Each one prints with the store name, address and
  period at the top and exports to CSV, Excel or (desktop) PDF.
- **Receive stock**: Products → *Receive* on a row (or Stock & Purchases). You
  can type packs (one carton = the product's pack size), loose units, or
  kilograms for a weighed item; the app converts to base units itself.
- **Adjust stock** (administrator only): Inventory → *Adjust*, choose the type —
  *Stock count* / *Correction* (set the true quantity) or *Damaged* / *Lost*
  (remove a quantity) — and give a reason. The reason is mandatory and appears in
  the ledger and the audit trail.
- **Import products**: Products → *Template* to get the exact sheet, fill it in,
  then *Import*. The first pass is a dry run: you see new/updated/unchanged counts
  and every problem row before anything is written. Choose *Import* to commit.
  Rows match on SKU, then barcode, then exact name.
- **Export products**: *Export CSV* or *Export Excel*. In the desktop app the file
  lands in `data/exports`; in the browser it downloads.
- **Stocktake** (supermarket, administrator): Stocktake → *Start new count* →
  type the counted quantities → *Save counted lines* → *Post count*. Posting
  writes the differences as adjustments with reason type COUNT; a posted count
  cannot be re-posted or edited.
- **Purchase orders** (supermarket): Purchase Orders → build the order → *Save
  order* (stock unchanged) → when the goods arrive, *Receive*: stock is posted and
  a goods-received note number is issued. A draft order can be cancelled.
- **Price labels** (supermarket): tick products in the Products list (or leave all
  clear for the whole catalogue), set copies per product, then *Print label
  sheet* — an A4 sheet with a scannable barcode on every label.
- **Weighed goods** (supermarket): mark the product as sold by weight with a price
  per kg and a PLU code. At the till, tapping it opens a weigh dialog (type kg or
  pick a preset); the receipt prints the weight in kg.

## 5. Backups and restore

- **Automatic:** one snapshot per 24 hours, taken when the app opens or closes.
  It is skipped on a machine with no licence yet, so a fresh install does not
  collect empty files.
- **Manual:** Backup & Restore → **Back up now** (the app's own backups folder)
  or **Back up to a folder…** (a flash drive, an external disk, a network share
  the operator can write to).
- **Where files live:** `%APPDATA%/Infoflex/backups/`. Names look like
  `infoflex-backup_2026-03-05_14-22-01_manual.db`; the word at the end is how it
  was made (`manual`, `auto`, `shutdown`).
- **The seven-day warning:** if the newest backup is a week old — or there is
  none at all — the dashboard and the Backup & Restore page show a warning. A
  shop that never copies a backup off the machine is one disk failure from
  losing everything.

### Backing up to a USB stick

1. Plug the stick in and wait for Windows to show it (for example `D:`).
2. Backup & Restore → **Back up to a folder…** → pick the stick.
3. The newer file appears at the top of “Recent backups”; the copy on the stick
   is identical to the one in the app's folder.
4. Eject the stick properly. Keep one copy in the shop and one away from it.

If the drive is not plugged in, or is write-protected/full, the app says so and
leaves the backup folder untouched. **Copy…** on any row copies an older backup
to a chosen folder without making a new one.

### Restoring

1. Backup & Restore → pick the backup row (**Restore**) or type/browse to a file
   (**Restore from a file**), then **type the file name** in the box. The
   Restore button stays disabled until the name matches exactly.
2. The app writes a safety copy of the current database
   (`pre-restore_infoflex.db_<timestamp>.db`) into the backups folder, then
   replaces the database and signs everyone out.
3. Sign in again. Products, sales, customers, stock and settings are exactly as
   they were in the backup.

**What a restore never touches:** the licence. Edition, activation period, expiry
and the licence history are read out of the live database before the swap and
written back afterwards, so restoring another shop's backup — or an old backup
from the same shop — never grants, extends or removes a licence. The backup's own
licence state is recorded in the audit trail (`backup.restore`) for the vendor to
inspect, not applied. Nothing about a licence expires because of a restore.

A failed restore (wrong file, unreadable database, a file from another program)
is refused before anything is replaced: the live database and its data stay as
they were.

## 6. Data location and moving to a new computer

Copy the entire `%APPDATA%/Infoflex` folder (data + backups) from the old
machine to the same path on the new one, install Infoflex there, and sign in.
The licence travels with the database.

## 7. Printing and hardware

Receipts/invoices are A4/thermal friendly HTML. By default they go through the
Windows print dialog, where the operator picks the printer and paper size;
"Save HTML" exports the same document if a digital copy is needed.

**Pinning a receipt printer (Settings → Printing & hardware):** press **Find
printers**, choose the till printer (for example `EPSON TM-T20III Receipt`) and
optionally set **Print without the dialog**. With a printer pinned and silent
printing on, F10 on the till sends the receipt straight to that printer; with
"Ask each time" the Windows dialog appears as before. If the chosen printer is
not connected, Windows shows its usual queue/dialog rather than losing the
receipt. A supermarket install also has a **label printer** name field for shelf
and scale labels.

**Weighing scales (supermarket):** the till understands scale barcodes that
carry the weight, so the cashier never types a weight the scale already printed.
The layout is set in Settings → Printing & hardware:

| Setting | Meaning | Default |
| --- | --- | --- |
| Prefix digit | First digit the scale prints for a weighed item | `2` |
| PLU digits | Digits that identify the item | `5` |
| Weight digits | Grams, after the PLU | `5` |

For `20002500250` with those defaults the till reads PLU `00025` (the product's
PLU code) and 250 g. Some scales append a check digit; the till accepts the
barcode with or without it. The EAN check digit itself is **not** validated —
scales differ, and a rejected label at the till is worse than an unverified one.
Ordinary product barcodes and PLUs still scan one unit at a time.

**Receipt preview:** Settings shows a live preview to the right of the store
identity fields. Type a new store name, footer or thank-you note and the paper
changes before you save; the preview is rendered from the unsaved draft and
never writes to the database.

## 8. Users and roles

| Role | Can do | Cannot do |
| --- | --- | --- |
| Administrator | everything: goods, prices, users, settings, backups, void/return approval, licence | — |
| Supervisor (supermarket/Both) | sell, see all sales, approve voids/returns, override prices, receive stock, reports, audit | add users, change prices, change settings |
| Cashier | sell, print receipts, returns within limits, see own daily sales | approve anything, see others' sales, prices, stock counts |

Only administrators can add users or reset passwords. A new user gets a
temporary password and must change it at first sign-in.

## 9. Database checks, day closing and shifts

```bash
npm run db:verify     # writes + reads a row in every table on a throw-away DB
npm run db:schema     # regenerates docs/SCHEMA.md from the real migrations
```

Both run against a temporary database; neither touches a shop's live file.
Run them after changing `src/db/migrations.ts` or `src/db/schema.ts` — `db:verify`
fails when the two disagree.

**Day closing** (*Reports → End of day close*, channels
`operations.day.reconcile` → `operations.day.close`) shows the opening float,
cash sales, cash refunds and the expected drawer, then saves the counted cash and
the variance in one row per business date. Only `reports.view.all` (supervisor or
administrator) may reconcile or close; closing the same date twice is refused, so
the figures on a printed day report can never silently change. On supermarket
licences the same panel lists every shift and every cashier with their own
over/short.

**Cashier shifts** (supermarket edition): open a shift with a float, log drawer
events (no-sale, paid in, paid out), then close with the counted cash. Only the
cashier who opened the shift can close it; the expected cash comes from the cash
payments recorded against that shift, and every event is in the audit log.

**First run**: the app opens on *Activation Required*. Enter the vendor master
password, then choose the edition (Pharmacy / Supermarket / Both) and the licence
period — the 1/2/3-year buttons fill the end date. The end date is exclusive: the
app locks at 00:00 on that date. After that the setup screen asks for the
administrator account and the shop's details together.

**Licence expiry**: an admin banner appears at 30, 14, 7 and 1 days before the
end date, and everyone sees a ten-minute warning that the current sale should be
finished or saved (the basket is kept in the window and restored afterwards). On
the end date the whole app is replaced by **License Expired — Software Update
Required**. That screen says the data is safe; it is.

**Renewing (software update)**: on the locked screen enter the vendor master
password, then pick a new period (the end date must be in the future and a period
that already ended cannot be reused). The edition may be changed at the same
time. Renewal never asks for the store details and never changes them. The same
form lives in **Licence** inside the app for renewing before expiry.

**Wrong passwords**: five wrong master-password attempts start a 30-second wait,
then 1 minute, 5 minutes, 15 minutes, 30 minutes, 1 hour, 2 hours, 4 hours, 8
hours and finally 24 hours. The delay is stored in the database, so closing the
app does not reset it.

**Clock changes**: if the computer clock is set earlier than the last time the
app ran (more than two minutes), the app locks and asks for the master password
once; correct the clock first. Restoring a backup onto a different computer also
requires the master password, because the licence is bound to the machine.

**Store details**: the setup screen asks for the administrator account and the
shop's details together. The store name is mandatory; the logo is optional
(PNG/JPEG/WebP/SVG up to 200 KB). Settings cannot be reached again until you sign
in as that administrator.

**Locked accounts**: five wrong passwords lock the account until an administrator
opens Users and clicks Unlock. The lock is stored in the database, so closing and
reopening the app does not reset the counter. The administrator's own account can
also lock — unlock it from another admin account, or restore the backed-up
database.

**Idle sign-out**: Settings → Auto sign-out after inactivity (1–720 minutes,
default 15). The main process ends the session and the window returns to the
login card; unsaved form input is lost by design.

**Upgrading an existing installation**: start the new build. The database
migrations run on open and are tracked with `PRAGMA user_version`; schema v2
renames `stock_batches → product_batches`, `stock_moves → stock_movements`,
`license → license_state` and `rx_required → requires_prescription`, backfills
categories and barcodes, and keeps every row; schema v3 adds `users.email`, `users.failed_attempts`,
`users.locked_until`/`locked_reason`, `users.password_algo` and the store-profile
settings (email, PCN/NAFDAC number, VAT number, logo, thank-you note, idle
timeout) with defaults, so existing accounts keep working with their scrypt
hashes until the next sign-in upgrades them to bcrypt. Schema v4 adds licence
periods (`starts_on`/`ends_on`), the HMAC columns, `last_seen_*`, the lock reason,
and the `license_history`, `license_attempts` and `license_guard` tables; an
existing licence is signed once on first start with its old expiry as the first
invalid day. Take a backup first if you want a rollback point.

## 10. Troubleshooting

| Symptom | What to do |
| --- | --- |
| "License Expired — Software Update Required" | Enter the vendor master password on that screen and choose a new end date in the future |
| "The vendor master password is not correct" | Check capitalisation; after five wrong attempts the app waits 30s, then 1m, 5m… (the wait is shown) |
| Receipt prints the wrong store name | Old documents keep their snapshot by design; change the store name in Settings for new ones |
| "Only expired stock is available" | Receive a fresh batch (Products → Receive) or adjust the expired batch to zero |
| App won't open a second time | It is a single-instance app — check the taskbar or Task Manager for an existing window |
| "better-sqlite3 was compiled against a different Node.js version" | `npm run rebuild:electron` (app) or `npm run rebuild:node` (tests) |
| "System clock change detected" | Set the computer clock correctly, then enter the vendor master password |
