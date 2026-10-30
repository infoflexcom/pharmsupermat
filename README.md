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
VENDOR_MASTER_PASSWORD='...' npm test      # 122 unit/integration/renderer tests
VENDOR_MASTER_PASSWORD='...' npm run verify:secrets   # proves the password is nowhere in plain text
npm run db:verify           # writes + reads a row in every table on a temp database
npm run db:schema           # regenerates docs/SCHEMA.md from the real migrations
npm run smoke                              # end-to-end against a running instance
npm run build                              # typecheck + electron-vite production build

# Windows installer (on Windows, or Linux with wine)
npm run dist:win            # -> release/Infoflex-Setup-1.0.0.exe
```

First launch asks for the **vendor master password**, then your edition +
expiry (or a paste-in activation code), then your store name and the first
administrator account.

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
| Data safety | WAL SQLite, transactions for every money/stock change, daily + shutdown backups, restore with safety copy |
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
                    marketing, barcodes, reports, dashboard, users, backup, documents, session
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

The schema — 30 tables, which edition owns each one, indexes and the migration
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

See [docs/DECISIONS.md](docs/DECISIONS.md) for the reasoning behind the design,
[docs/OPERATIONS.md](docs/OPERATIONS.md) for day-to-day operation and
[docs/CHECKLIST.md](docs/CHECKLIST.md) for the verification report.
