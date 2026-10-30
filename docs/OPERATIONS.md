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

## 9. Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Licence has expired" | Activation screen: enter the master password and a new code/expiry |
| "The vendor master password is not correct" | Check capitalisation; 5 wrong logins throttle the account for 60s (users only) |
| Receipt prints the wrong store name | Old documents keep their snapshot by design; change the store name in Settings for new ones |
| "Only expired stock is available" | Receive a fresh batch (Products → Receive) or adjust the expired batch to zero |
| App won't open a second time | It is a single-instance app — check the taskbar or Task Manager for an existing window |
| "better-sqlite3 was compiled against a different Node.js version" | `npm run rebuild:electron` (app) or `npm run rebuild:node` (tests) |
