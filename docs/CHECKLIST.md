# Phase verification report

Verified on a headless Linux sandbox (Node 22.22, npm 10.9, no display server,
no wine, no printer). The product is a Windows Electron app, so the checks below
are split into what can be proven here and what must be done on a Windows
machine.

## How it was verified

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm run typecheck` (main + renderer, strict, `noUnusedLocals`) | ✅ clean |
| 2 | `VENDOR_MASTER_PASSWORD=… npm test` | ✅ **72/72 tests pass** (8 API/DB suites + 2 jsdom suites mounting every screen) |
| 3 | `npm run build` (`electron-vite` production bundles) | ✅ `out/main` 137 kB, `out/preload` 0.3 kB, `out/renderer` 824 kB |
| 4 | `npm run dev:web` + `npm run smoke` (fresh database) | ✅ **30/30 end-to-end checks pass** |
| 5 | `npm run db:verify` | ✅ **145 checks pass** — every one of the 30 tables written and read back, manifest matches the migrations |
| 6 | Browser harness served through the Arena preview host | ✅ HTTP 200, React tree + asset graph load, login works |
| 7 | `npx electron --version` / `electron-builder --linux dir` | ❌ blocked by the sandbox: no Electron binary can be downloaded (TLS-intercepting proxy), no GTK/display, no wine |

What the harness proves: the same `invoke()` dispatcher, guards, services,
SQLite schema, transactions and document renderer that the Electron main process
uses. What it cannot prove: Chromium window chrome, the native print dialog and
the NSIS installer itself.

---

## Requirement checklist

### Stack & packaging

| Requirement | Status | Evidence / notes |
| --- | --- | --- |
| Electron + React (TypeScript) + SQLite (better-sqlite3) | ✅ | `electron.vite.config.ts`, `src/main`, `src/renderer`, `src/db/index.ts` |
| Packaged with electron-builder (NSIS) | ⚠️ config only | `electron-builder.yml` (NSIS, per-user, shortcuts, EULA, ico). Installer binary could not be produced in this sandbox — build on Windows with `npm run dist:win` |
| Installable offline | ✅ by design | no network calls anywhere in `src/` (grep for `fetch` finds only the dev harness); all data local |
| One app, two editions chosen at activation | ✅ | `src/shared/editions.ts`, activation screen, signed licence |
| Window title / login page / app icon show the edition product name | ✅ (title + login verified; icon is edition-neutral by design) | `applyTitle()` in `src/main/index.ts`, `LoginPage`, `login` renders product name test; single "IF" icon serves all editions |
| Installer shows the Infoflex product name | ⚠️ | NSIS package is branded **Infoflex** (edition is unknown at install time) — see DECISIONS §5 |
| Logo as app icon, login logo, full-screen login background with overlay | ✅ | `scripts/make-icons.ts` → `resources/resources/build/icon.ico`, `resources/icon.png`, `src/renderer/src/assets/logo.png`; `.auth-screen` background overlay |
| Navy/gold/off-white brand | ✅ | `styles.css` tokens `#1F3F73`, `#C9A24B`, `#F6F4EE` |
| Tagline "Strategy \| Consulting \| Innovation" | ✅ | login, sidebar, printed documents |

### Store name rule

| Requirement | Status | Evidence |
| --- | --- | --- |
| Store name entered at first-run setup, required | ✅ | setup screen; `completeSetup` rejects blank; test "first-run setup requires a store name" |
| Never hard-coded | ✅ | no store name in `src/`; stored in `settings` |
| Printed on receipt, invoice, credit note, every report | ✅ | `documents.ts` uses snapshot fields; smoke test asserts store name in all 7 reports + receipt + credit note |
| Each sale snapshots store name/address/phone | ✅ | `sales.store_name/address/phone`; test "store name change does not alter old receipts" |

### Editions & roles

| Requirement | Status | Evidence |
| --- | --- | --- |
| Edition driven by signed licence data (PHARMACY / SUPERMARKET / BOTH) | ✅ | Ed25519 licence payload; `license.test` cases for all editions |
| Shared code for users, POS, returns, reports, backup, licensing | ✅ | single service layer |
| Edition modules load only when enabled | ✅ | main-process feature guards (`inventory.expiryWatch`, `prescriptions.log` → `EDITION_RESTRICTED` on supermarket licence; test) |
| Sidebar respects flags | ✅ | `availableNav()` filters by permissions + features; jsdom tests for admin vs cashier |
| Admin: full access, only one who adds users / sets passwords / adds goods / sets prices | ✅ | permission matrix + tests ("enforces roles", "keeps at least one active administrator") |
| Supervisor (supermarket): approves voids, refunds, price overrides; no users/prices | ✅ | `SUPERVISOR_PERMISSIONS`; tests for approval rights + `users.create`/`products.create` denial |
| Cashier: sales, receipts, returns within limits, own daily sales | ✅ | test "lets cashiers see only their own sales", limited returns, restricted reports |

### Money & printing

| Requirement | Status | Evidence |
| --- | --- | --- |
| ₦, 2 decimals, thousand separators | ✅ | `formatMoney` → `₦1,234.56`; used in UI and documents |
| Receipt, wholesale invoice, credit note, reports | ✅ | `buildSaleDocument`, `buildCreditNoteDocument`, `buildReportDocument` |
| Reprints use the original store snapshot | ✅ | test asserts old receipt unchanged after renaming the store |

### Licensing

| Requirement | Status | Evidence |
| --- | --- | --- |
| Master password required to activate and renew | ✅ | activation screen + `assertVendorPassword`; tests "requires the master password for renewal" |
| Never stored in plain text (salted hash only) | ✅ | `vendor-secrets.json` holds `scrypt$32768$8$1$…`; test greps the repo for the plaintext; full-repo grep returns nothing |
| No logging of the password | ✅ | audit entries record only "license.master.verify.ok/failed" |
| Tamper-evident licence | ✅ | signature re-verified on every status read; test "detects a licence row edited outside the app" |
| Expiry / renewal | ✅ | expired licence blocks everything but activation; test "blocks an expired licence and allows renewal" |
| Offline | ✅ | verification is local cryptography only |

### Data integrity & audit

| Requirement | Status | Evidence |
| --- | --- | --- |
| DB transactions for money and stock | ✅ | `createSale`, returns, voids, receiving, adjustments all wrapped; test "rolls the whole sale back when stock is insufficient" |
| Completed sales never deleted | ✅ | void sets `VOIDED`, row and items retained; test |
| Audit log for important actions | ✅ | append-only `audit_log`; smoke asserts `license.activate, setup.complete, auth.login, sale.create, sale.void, return.create, user.create`; denials logged as `security.permission.denied` |
| Modular code | ✅ | shared / core / services / api / renderer split |
| Offline | ✅ | no outbound network in shipping code |
| No questions asked; decisions documented | ✅ | `docs/DECISIONS.md` (27 entries) |

### Operational flows exercised end-to-end (smoke test)

Activation (wrong password rejected, correct accepted) → first-run setup (store
name required) → admin login → 3 products (barcode, prescription flag, batches)
→ cash sale with discount + prescription ref → prescription enforcement →
insufficient stock rollback → store rename without history rewrite → transfer
sale → wholesale invoice at wholesale price → credit note within limit → void
with stock restore → cashier account (own sales only, no admin powers) →
pharmacy-only module → 7 report renders → dashboard → audit trail → backup →
HTML export → licence status.

---

## What works

- Everything in the checklist marked ✅, verified by 72 automated tests, 145
database checks and the 30-step end-to-end smoke run against a live instance.
- The full UI (activation, setup, login, POS, products, inventory, returns,
  sales, wholesale, reports, users, settings, backup, audit, licence) mounts and
  routes correctly (jsdom tests) and is browsable in the live preview.
- Licence issuing/renewal via both signed codes and in-app vendor issue, with
  the vendor CLI (`npm run vendor:license`).

## What does not work (or could not be verified here)

1. **The Electron desktop window was not launched.** The sandbox has no display
   server, no GTK libraries and cannot download the Electron binary (proxy TLS
   error). `npm run dev` / `npm run start` are untested in this environment; the
   main-process code they run is the code the harness exercises.
2. **The Windows NSIS installer was not built.** `electron-builder` could not
   download Electron here. Config, file list, asar unpack rules and icons are in
   place; run `npm run dist:win` on Windows.
3. **Physical printing was not tested** (no printer). The HTML documents render
   and export correctly; `webContents.print()` is a thin wrapper.
4. **Native module ABI caveat:** tests/harness need `npm run rebuild:node`; the
   desktop app needs `npm run rebuild:electron`. Both are documented and the
   postinstall hook degrades gracefully offline.
5. **Not implemented in this phase** (documented): VAT/tax, customer accounts,
   supplier purchase orders, multi-branch sync, PDF export, barcode label
   printing.

## Demo data in the preview

The live browser preview is seeded by the smoke test so every screen has content:
store **Grace Pharmacy**, products, sales, a wholesale invoice, a credit note and
a cashier. Sign in with `admin` / `adminpass123`. `npm run reset:data` returns to
the true first-run activation screen.

---

# Phase 2 verification — project setup & database layer

Verified on the same headless Linux sandbox.

## Structure

| Requirement | Status | Evidence |
| --- | --- | --- |
| `src/main`, `src/preload`, `src/renderer`, `src/db`, `src/services`, `src/license`, `src/editions` (pharmacy + supermarket), `docs` | ✅ | directories present; history preserved with `git mv`; both tsconfigs list them |
| Edition modules load only when enabled | ✅ | `src/editions/*` contribute channels; `handlerMapFor(features)` mounts a module only when the licence flag is on, else `EDITION_RESTRICTED` (tests "gates edition modules in the main process") |
| Typed data-access layer | ✅ | `src/db/repositories/` — one typed `Table<T>` per table with a declared column allowlist; unknown columns throw |
| Secure IPC bridge (contextIsolation on, nodeIntegration off) | ✅ | `src/main/index.ts` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`), `src/preload/index.ts` exposes only `invoke` + `appInfo`, every call re-guarded in main |
| DB in the user app-data folder | ✅ | `join(app.getPath('userData'), 'data')`; `INFOFLEX_DATA_DIR` overrides for the harness |

## Schema

| Requirement | Status | Evidence |
| --- | --- | --- |
| Shared tables: users, products, categories, suppliers, customers, sales, sale_items, payments, returns, return_items, stock_movements, purchases, purchase_items, day_closings, settings, audit_log, license_state | ✅ | migration v2; `npm run db:verify` writes + reads each one |
| Pharmacy-only: product_batches (batch no, expiry, qty, cost), generic name, prescription flag | ✅ | `product_batches`; `products.generic_name`, `products.requires_prescription` |
| Supermarket-only: departments, shelf/location, promotions, price_rules, loyalty_members, loyalty_transactions, cashier_shifts, cash_drawer_events, weighed items (PLU, price per kg), multiple barcodes, variants | ✅ | `departments`, `promotions`, `price_rules`, `loyalty_*`, `cashier_shifts`, `cash_drawer_events`, `product_barcodes`, `product_variants`; `products.shelf_location`, `plu_code`, `price_per_kg`, `is_weighed` |
| Receipt numbers unique and sequential | ✅ | `counters` → `RCP-000001`; test "issues unique sequential receipt numbers" (also proves the UNIQUE index rejects a duplicate); credit notes unique via partial index |
| Money stored as integer kobo | ✅ | every amount is an INTEGER column; test asserts no REAL/FLOAT/DOUBLE column exists |
| Money/stock changes in transactions, important actions audited | ✅ | `Database.transaction` (IMMEDIATE) in sales, returns, purchases, stock, day close, shifts; audit rows verified |

## DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| App launches, creates the database | ✅ (harness) | `npm run dev:web` creates `./data/infoflex.db`, applies migrations v1+v2 (`PRAGMA user_version = 2`), first-run licensing screen renders. Desktop launch is still blocked by the sandbox (no display) — see phase 1 limitation 1 |
| A test script inserts and reads a record from each table | ✅ | `npm run db:verify` → 30/30 tables, 145 checks, 0 failures |
| Schema summary in `/docs/SCHEMA.md` | ✅ | generated by `npm run db:schema` — 30 tables, columns, indexes, edition ownership, migration history |
