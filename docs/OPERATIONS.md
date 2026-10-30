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
- **Reports** print with the store name at the top.

## 5. Backups and restore

- Automatic: once per 24 hours on start-up and on clean shutdown.
- Manual: File → Backup now (desktop menu) or Backup & Restore → Back up now.
- Files live in `%APPDATA%/Infoflex/backups/`. Copy them to a flash drive
  regularly — they are the whole shop.
- Restore: Backup & Restore → Restore. The current database is copied to
  `pre-restore_…` first, then replaced, and everyone is signed out.

## 6. Data location and moving to a new computer

Copy the entire `%APPDATA%/Infoflex` folder (data + backups) from the old
machine to the same path on the new one, install Infoflex there, and sign in.
The licence travels with the database.

## 7. Printing

Receipts/invoices are A4/thermal friendly HTML printed through the Windows print
dialog. Choose the printer and paper size there; "Save HTML" exports the same
document if you need a digital copy. Printers are the only thing the app talks to
outside its own database — and only through the OS.

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

**Day closing** (`operations.day.totals` → `operations.day.close`) stores one row
per business date with cash/transfer/POS totals, returns, expected cash and the
variance against the counted drawer. Closing the same date twice is refused, so
the figures on a printed day report can never silently change.

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
