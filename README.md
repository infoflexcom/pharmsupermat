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
VENDOR_MASTER_PASSWORD='...' npm test      # 63 unit/integration/renderer tests
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
| Products | codes, barcodes, cost/selling/wholesale prices, reorder levels, prescription flag, batches and expiry (pharmacy) |
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
  shared/           types, edition flags, permissions, kobo money helpers, licence code format
  main/
    core/           database + migrations, settings, auth, audit, licence, vendor secrets
    services/       products, stock, sales, returns, inventory, reports, dashboard, users, backup, documents
    api/            context (sessions), registry (channel → permission/feature guards), invoke
    ipc/ (via index.ts) Electron wiring, window title, printing, menu, backups
    print/          offscreen-window printing
  preload/          the only bridge exposed to the renderer (contextBridge)
  renderer/         React app (pages, components, styles)
harness/            browser dev bridge (shares invoke() with Electron)
scripts/            vendor keys, licence issuing, icons, smoke test, dev utils
tests/              vitest suites (API, licensing, POS, returns, reports, renderer)
docs/               decisions, operations, checklist, EULA
```

## Data locations

| What | Where |
| --- | --- |
| Database | `%APPDATA%/Infoflex/data/infoflex.db` |
| Backups | `%APPDATA%/Infoflex/backups/` |
| Exported documents | `%APPDATA%/Infoflex/data/exports/` |
| Browser harness data (dev only) | `./data/` (`npm run reset:data` clears it) |

No network access is required or attempted by the app.

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
