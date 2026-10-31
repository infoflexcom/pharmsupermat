# Infoflex Pharm · Infoflex Mart

One installable, fully offline Windows desktop till for pharmacies and
supermarkets. The edition — **Pharmacy**, **Supermarket** or **Both** — is
chosen by the signed licence at activation, and the same installer serves all
three.

- **Electron + React (TypeScript) + SQLite (better-sqlite3)**, packaged with
  electron-builder (NSIS).
- Brand: navy `#1F3F73`, gold `#C9A24B`, off-white — tagline
  *Strategy | Consulting | Innovation*.
- Every customer document prints the **customer's own store name** (captured on
  the document at the time it was issued).
- Naira only, integer kobo internally, `₦1,234.56` on screen and on paper.

---

## Quick start

```bash
npm install                 # installs deps and tries to rebuild SQLite for Electron

# Desktop app (Electron)
npm run dev

# Browser preview of the same UI + the same main-process API (handy for review,
# CI and screenshots — not part of the installer)
npm run dev:web             # http://localhost:4173

# Checks
npm run typecheck
VENDOR_MASTER_PASSWORD='...' npm test                  # 197 unit/integration/renderer tests
VENDOR_MASTER_PASSWORD='...' npm run verify:secrets    # password nowhere in plain text (source + installer + build)
VENDOR_MASTER_PASSWORD='...' npm run verify:portable   # a copied app folder still has to be activated
npm run db:verify           # writes + reads a row in every table on a temp database
npm run db:schema           # regenerates docs/SCHEMA.md from the real migrations
npm run smoke                              # end-to-end against a running instance
npm run e2e                                # 16 journeys x 2 editions on fresh databases
npm run build                              # typecheck + electron-vite production build

# Windows installer (on Windows, or Linux with wine — see "Installer" below)
VENDOR_MASTER_PASSWORD='...' npm run dist:win   # -> release/Infoflex-Setup-1.0.0.exe
```

The installer asks for the **vendor installer password** before it will copy a
single file; the first launch then asks for the **vendor master password**, your
edition + expiry (or a paste-in activation code), and finally the store name and
the first administrator account. Nothing can be done in the app until that
activation has happened — including on a folder that was copied from another
computer.

---

## What is in the box

| Area | Details |
| --- | --- |
| Point of sale | search / barcode, cart, discount, four payment methods, change due, printable receipt, stock deducted in the same transaction |
| Products | codes, barcodes, brand, pack size with automatic pack→unit conversion, cost/selling/wholesale prices, wholesale minimum, reorder levels, prescription flag, batches and expiry (pharmacy); bulk CSV/Excel import with an error report, export and a downloadable template |
| Stock control | receiving by pack, by unit or by weight (kg), adjustments for damaged/lost/correction with a mandatory reason, supervisor-level receipts, administrator-only adjustments |
| Supermarket extras | departments, shelf/aisle, multiple barcodes, variants, weighed items with PLU and price per kg, stocktake with a variance report, supplier purchase orders and goods-received notes, bulk price-label printing |
| Inventory | live stock, FEFO batch selling, expired stock never sold, stock receiving, audited stock counts, movement ledger |
| Returns | credit notes, cashier limit + return window, supervisor approval queue, optional restocking |
| Voids | never deletes a sale — marks it void, reverses stock, approval trail, everything audited |
| Wholesale | invoices at wholesale prices with customer details |
| Reports | sales summary, product sales/profit, stock valuation, low stock, expiry watch, returns, audit trail — all printable with the store name |
| Users | Admin / Supervisor (supermarket only) / Cashier with per-call permission checks |
| Testing | 191 unit/API/renderer tests, a 16-check end-to-end run against a fresh install per edition (`npm run e2e`), a 54-check smoke run against a live server, and a database verifier (194 checks) |
| Data safety | WAL SQLite, transactions for every money/stock change, a daily automatic backup, manual backup to a USB stick or any folder, typed-confirmation restore that always keeps the licence and writes an undo copy, and a warning after seven days without a backup |
| Demo data | optional sample shop (Admin): 30 pharmacy products with batches, or 60 supermarket products in two departments with weighed items and promotions, plus sample users — removable in one step |
| Settings | store profile with a live receipt preview, printer selection and silent printing, VAT, discount limit, return window, idle timeout, payment methods, edition-specific pharmacy alerts and supermarket scale/till rules — licence status shown read-only |
| Licensing | Ed25519-signed licence, scrypt-hashed master password, sealed vendor key, expiry + renewal |
| Audit | append-only log of sales, voids, returns, price changes, stock counts, logins, permission denials |

## Editions & flags

| Module | PHARMACY | SUPERMARKET | BOTH |
| --- | --- | --- | --- |
| POS, returns, reports, backup, licensing | ✓ | ✓ | ✓ |
| Batches, expiry, FEFO, prescriptions | ✓ | — | ✓ |
| Supervisor role, price-override approval | — | ✓ | ✓ |
| Wholesale invoicing | ✓ | ✓ | ✓ |

Flags are derived from the signed licence inside the **main process**. The
sidebar hides what you were not sold, and every IPC channel is re-checked
against the flags, the role, the user's current permissions and the licence
expiry. Editing the renderer or the database cannot turn a module on.

## Project layout

```
src/
  db/               SQLite wrapper (open/transactions), schema.ts manifest
    migrations.ts   append-only migrations, versioned with PRAGMA user_version
    repositories/   typed data access, one repository per table
  shared/           types, edition flags, permissions, kobo money helpers, licence code format
  license/          signed licence verification, vendor key material
  services/         products, stock, sales, returns, directory, purchases, operations,
                    marketing, barcodes, reports, dashboard, users, backup, documents,
                    receiptPreview, session
  editions/
    pharmacy/       batch/expiry module (feature-gated IPC channels)
    supermarket/    departments, promotions, price rules, loyalty, shifts, drawer, variants
  main/
    api/            registry (channel → permission/feature guards), invoke, arg helpers
    ipc/ (via index.ts) Electron wiring, window title, printing, menu, backups
    print/          offscreen-window printing
  preload/          the only bridge exposed to the renderer (contextBridge)
  renderer/         React app (pages, components, styles)
harness/            browser dev bridge (shares invoke() with Electron)
scripts/            vendor keys, licence issuing, icons, smoke test, DB verifier, schema doc
tests/              vitest suites (API, licensing, POS, returns, reports, DB, renderer)
docs/               decisions, operations, checklist, EULA, SCHEMA.md
```

## Data locations

| What | Where |
| --- | --- |
| Database | `%APPDATA%/Infoflex/data/infoflex.db` |
| Backups | `%APPDATA%/Infoflex/backups/` |
| Exported documents | `%APPDATA%/Infoflex/data/exports/` |
| Browser harness data (dev only) | `./data/` (`npm run reset:data` clears it) |

Set `INFOFLEX_DATA_DIR` to point the whole app at a different folder (used by
the harness and the smoke test). No network access is required or attempted by
the app.

The schema — 39 tables, which edition owns each one, indexes and the migration
history — is documented in [`docs/SCHEMA.md`](docs/SCHEMA.md), generated from
the live database by `npm run db:schema`.

## Database layer

- **Append-only migrations** in `src/db/migrations.ts`, tracked with
  `PRAGMA user_version`, each applied inside a transaction with rollback.
- **Typed repositories** in `src/db/repositories/` (plain CRUD with a column
  allowlist); business rules — stock, money, approvals, audit — stay in
  `src/services/*` so they always run inside a service-level transaction.
- **One manifest**, `src/db/schema.ts`, lists every table with its owning
  edition. `npm run db:verify` fails if the database and the manifest drift.
- **Edition modules** in `src/editions/*` own their channels; the main process
  only mounts a module when the signed licence enables it.

## Vendor tooling

### Activation (vendor procedure)

1. The customer reads you the **install code** shown on their activation screen
   (or you activate on site).
2. You issue a signed code — it carries the edition, the customer name and the
   expiry date, and is signed offline with the vendor key:
   `VENDOR_MASTER_PASSWORD='...' npm run vendor:license -- --edition PHARMACY --customer "Grace Pharmacy, Ikeja" --months 12`
3. The customer pastes the code, or you type the master password on their till
   and choose edition + expiry directly. Either way the app re-verifies the
   signature offline; there is no server and no callback.

### Edition selection

The edition is *licence data*, not a build variant — one installer serves all
three. The activation code (or the on-site activation form) says `PHARMACY`,
`SUPERMARKET` or `BOTH`; `src/shared/editions.ts` turns that into the product
name and feature flags, the main process mounts only those modules' channels,
and the sidebar only shows what is mounted.

### Renewal

Issue a new code with a later expiry (`--months 12` from today) and paste it
into **Licence → Renew**. Renewing keeps every record; it never wipes data. If
the shop lets the licence lapse, the app locks the business screens (point of
sale, stock, reports) but leaves backups, the licence screen and existing data
reachable.

```bash
# Re-issue the master key material (changes the vendor password/hash)
VENDOR_MASTER_PASSWORD='...' npm run vendor:keys

# Issue a licence code for a customer
VENDOR_MASTER_PASSWORD='...' npm run vendor:license -- \
  --edition PHARMACY --customer "Grace Pharmacy, Ikeja" --months 12

# Regenerate app icons / logos from the vector master
npm run icons
```

The master password is **never** stored in plain text: the repo holds a salted
scrypt hash plus the vendor signing key sealed with AES-256-GCM under a key
derived from that password.

## Installer

`electron-builder` produces one NSIS installer for all three editions:
desktop shortcut, Start Menu entry, uninstaller, per-user install, EULA page,
the brand icon, and a **vendor authorisation page** that will not let the
install continue without the installer password.

```bash
VENDOR_MASTER_PASSWORD='...' npm run installer:gate   # mint salt + PBKDF2 digests
VENDOR_MASTER_PASSWORD='...' npm run installer:gate:check   # does gate.nsh match this password?
npm run dist:win        # gate + build + package  (Windows, or Linux + wine)
npm run dist:win:dir    # unpacked folder only, for a smoke test
```

The gate header (`resources/build/generated/gate.nsh`) is git-ignored and holds
a salt plus PBKDF2 digests only; `resources/build/gate.ps1` (shipped inside the
installer) recomputes the digest of what was typed. Five wrong attempts close
the installer; `/S` silent installs are refused because there is no page to
show. Details and the exact behaviour table are in
[docs/OPERATIONS.md §1](docs/OPERATIONS.md).

The installer is only a speed bump: **activation in the app is the real
enforcement.** `npm run verify:portable` copies the built application into a
temporary folder outside the repository and proves that every business channel
is refused until a licence exists, that the licence survives the folder being
moved, and that deleting user data demands activation again.

## User guides

| Guide | Who it is for |
| --- | --- |
| [docs/USER-GUIDE-PHARMACY.md](docs/USER-GUIDE-PHARMACY.md) | pharmacy administrators and cashiers — batches, expiry, prescriptions |
| [docs/USER-GUIDE-MART.md](docs/USER-GUIDE-MART.md) | supermarket administrators and cashiers — weighed goods, stocktake, shifts |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | whoever installs, licenses, backs up and supports the till |
| [docs/DECISIONS.md](docs/DECISIONS.md) | the reasoning behind every rule in the app |
| [docs/CHECKLIST.md](docs/CHECKLIST.md) | what was tested, phase by phase |
| [docs/FINAL-REPORT.md](docs/FINAL-REPORT.md) | final delivery report: works / tested / limitations / ideas |

Guide figures are rendered by `npm run shots:guide` (see
[docs/screenshots/README.md](docs/screenshots/README.md)); each figure in the
guides names its file, and the caption describes exactly what is on screen.

## Troubleshooting

| Symptom | What it means |
| --- | --- |
| Installer says *"The installer password was entered incorrectly 5 times"* | it closed on purpose; ask Infoflex for the password again |
| Installer says *"the password check could not run"* | Windows PowerShell is missing or blocked by policy — contact Infoflex, the installer fails closed |
| App shows **Activation required** on a computer that was already activated | the data folder is not the one that was activated (new Windows profile, or `%APPDATA%\Infoflex\data` was deleted/restored) — re-activate or restore the folder |
| **Licence locked — clock** | the system date was moved backwards; sign in with the master password to clear it |
| **Licence expired** | business screens are locked until a renewal code is entered |
| Receipts print without a store name | the store name was never set: **Settings → Store name (required)**, then reprint |
| Wrong figure on a reprint | reprints are snapshots — the store name and prices are those of the original sale, by design |
| Another PC cannot open the shop's data | the app is per-machine; copy the backup file, or restore it via **Backup & Restore** |

Nothing in the app needs (or attempts) a network connection.
