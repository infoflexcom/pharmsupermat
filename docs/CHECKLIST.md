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
| App launches, creates the database | ✅ (harness) | `npm run dev:web` creates `./data/infoflex.db`, applies migrations v1–v3 (`PRAGMA user_version = 3`), first-run licensing screen renders. Desktop launch is still blocked by the sandbox (no display) — see phase 1 limitation 1 |
| A test script inserts and reads a record from each table | ✅ | `npm run db:verify` → 30/30 tables, 145 checks, 0 failures |
| Schema summary in `/docs/SCHEMA.md` | ✅ | generated by `npm run db:schema` — 30 tables, columns, indexes, edition ownership, migration history |

---

# Phase 3 verification — setup, authentication & branded login

## Requirement checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| First-run setup only after activation and only when no users exist | ✅ | `setup.status` (`licensed`, `setupRequired`), `setup.complete` returns `CONFLICT` once an administrator exists |
| Admin section: full name, username, password, confirm + strength hint | ✅ | `pages/SetupPage.tsx` (4-bar `passwordStrength`), main process re-validates every field |
| Store section worded by edition | ✅ | `SetupStatus.storeNameLabel` → "Pharmacy name" / "Supermarket name" / "Business name"; test asserts all three |
| Store name required | ✅ | blank/whitespace → `VALIDATION`; store details are not saved either (single transaction; test queries the DB) |
| Address, phone(s), email, PCN/NAFDAC number, VAT number, logo, receipt footer, thank-you note | ✅ | `SettingsPayload` + `settings.read`/`settings.update`; logo is a validated `data:image/...` URL ≤200 KB |
| Live receipt mini-preview of the store name | ✅ | `aria-label="Receipt preview"` on the setup page; renderer test types a name and asserts the preview updates |
| Setup saves both sections together; afterwards goes to login and never returns | ✅ | `db.transaction()` in `setup.complete`; `setupRequired` false afterwards |
| Only an Admin edits store details later | ✅ | `settings.update` requires `settings.manage`; supervisor/cashier get `FORBIDDEN` (test) |
| bcrypt/argon2 hashing, never plaintext | ✅ | bcrypt cost 10; test reads `users.password_hash` (`$2…`, no plaintext) |
| Lock after 5 failures, Admin unlocks | ✅ | `locked_until`/`locked_reason`, `FORBIDDEN` while locked, `users.unlock` + `user.unlock` audit |
| Auto-logout after configurable idle time | ✅ | `idleTimeoutMinutes` (1–720, default 15) enforced in the main process and mirrored by the renderer timer |
| Role rules in the MAIN process (no self sign-up, no forgot-password) | ✅ | `users.*` requires `users.manage`; Supervisor creation blocked on a pharmacy licence; no email/reset channels exist |
| Branded login page (logo backdrop, navy overlay/blur, card, show/hide, edition name, tagline, store name, version) | ✅ | `pages/LoginPage.tsx`; tests assert the store name, edition caption, version footer and the show/hide toggle |
| App icon `.ico` (16/32/48/64/128/256) + `.png` and matching `.png` | ✅ | `resources/build/icon.ico` (6 entries) + `icon-*.png`, generated from the logo by `npm run icons` |
| Sidebar by role and edition, store name in the header | ✅ | `availableNav` grouping/filters; tests cover pharmacy admin, supermarket admin, cashier |
| Audit log for logins, failures and user changes | ✅ | `auth.login`, `auth.login.failed`, `auth.account.locked`, `auth.logout`, `user.*`, `user.unlock` |

## DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| Complete setup → log in → add users → log in as each role → store name in header → restricted pages blocked (also via direct IPC) | ✅ | `tests/auth-lockout.test.ts`, `tests/setup-auth.test.ts`, `tests/guards.test.ts`, renderer tests |
| Finishing setup with an empty store name fails | ✅ | `VALIDATION`, nothing written, `setupRequired` still true |

## Verification run

- `npm run typecheck` — clean (node + web).
- `npm test` — 11 files, 86 tests passed.
- `npm run db:verify` — 145 checks, 0 failed.
- `npm run smoke` (against the harness on a fresh data dir) — 30/30 passed.
- `npm run build` — main 137 kB, preload 0.32 kB, renderer 916 kB.

---

# Phase 4 verification — licence control, expiry and anti-tampering

## Requirement checklist

| Requirement | Status | Evidence |
| --- | --- | --- |
| Branded "Activation Required" screen with logo, show/hide password, before setup and login | ✅ | `pages/ActivationPage.tsx`; renderer tests assert the heading, the toggle and that no edition branding appears |
| Nothing else works until the master password is entered | ✅ | `invoke.ts` blocks every `license !== false` channel while `!license.usable`; test "blocks every business channel until a licence exists" |
| Verify against a salted hash only | ✅ | scrypt hash in `src/license/vendor-secrets.json`; `npm run verify:secrets` scans 134 files and the build output |
| After 5 wrong attempts, delays of 30s, 1m, 5m… | ✅ | `license_attempts` + `DELAY_LADDER_SECONDS`; test walks 5 → 30s wait → success → 5 more → 60s |
| Every attempt logged without the typed value | ✅ | `license.master.verify*` audit rows store attempt number and delay only; test greps the audit `details` for the typed password |
| Edition + start/end date with 1/2/3-year quick-select, End after Start | ✅ | `components/LicenseSetupForm.tsx`; date maths unit tests; validation tests |
| Save edition + period in signed licence data, then continue to setup/login | ✅ | `activateLicense()` writes `starts_on`/`ends_on` + HMAC in one transaction; renderer tests click through both steps |
| Check on launch, every few minutes and at midnight | ✅ | `startLicenseWatch()` in `src/main/index.ts` (60s interval + midnight timer) plus a renderer poll and a guard on every IPC call |
| Ten-minute warning, sale can finish or be saved | ✅ | `LicenseBanners` warning + the POS basket persisted to `localStorage` and restored |
| Lock the whole app with "License Expired — Software Update Required" | ✅ | `pages/LicenseLockPage.tsx`; renderer test asserts no app shell remains |
| Admin banner 30 / 14 / 7 / 1 days before expiry | ✅ | `warning` in the status (thresholds) + `license-warning` banner; renderer tests |
| Renewal asks for the password, then a new range; may change the edition | ✅ | Lock screen step 2 → `license.activate`; edition change writes an `EDITION_CHANGE` history row |
| Renewal refuses an old range and requires a future end date | ✅ | `validatePeriod` + `periodAlreadyUsed`; tests for both refusals |
| Unlock only after a valid range; history kept in `license_state`/audit | ✅ | `license_history` (append-only) + `license.activate/renew/edition.change/unlock` audit rows |
| Renewal never asks for or changes store details | ✅ | Guard code touches only licence tables; test reads `settings.storeName` after renewal |
| Clock rollback detection with a signed last-seen stamp | ✅ | `last_seen_at` + `last_seen_hmac`; rollback test locks, refuses a wrong password and clears with the right one |
| HMAC over the licence data; modified/missing → lock + password | ✅ | `period_hmac` verified in `computeLicenseStatus`; tamper test edits `ends_on` and gets `TAMPERED` + `LICENSE_LOCKED` |
| Guard logic in the main process | ✅ | `src/license/guard.ts` is imported only by main-side modules; the renderer gets a status object |
| ASAR packaging + obfuscation/minification for the licence module | ✅ (partial) | `asar: true` + `compression: maximum`; `out/main/index.js` is a 165 kB minified bundle. Real obfuscation is documented as out of scope in `docs/DECISIONS.md` §30 |
| Protection limits documented | ✅ | `docs/DECISIONS.md` §30 "Realistic limits of this protection" |
| Locking never deletes, corrupts or encrypts business data | ✅ | No delete/encrypt path in the guard; tests read products, settings and users after expiry and renewal |
| Lock screen says "Your data is safe. Enter the update password to continue." | ✅ | `pages/LicenseLockPage.tsx`; asserted by a renderer test |

## DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| (1) A fresh install is blocked until the right password is entered | ✅ | `tests/license-guard.test.ts` — unlicensed state refuses setup, login and sales |
| (2) A wrong password never gets through | ✅ | Wrong password test incl. the delay ladder |
| (3) Edition + dates start the app with the correct modules | ✅ | Pharmacy/supermarket/both feature tests + `EDITION_RESTRICTED` on the wrong module |
| (4) An end date of today or earlier locks the app | ✅ | Exclusive end date; activation refuses `endsOn <= today`; time-travel test locks on the end date |
| (5) Renewal unlocks with all data and store details intact | ✅ | Expiry + renewal test; smoke "renewal with a new range keeps every record intact" |
| (6) Moving the clock backwards triggers the lock | ✅ | Clock rollback test and unlock path |
| (7) The password appears nowhere in plain text | ✅ | `npm run verify:secrets` (134 files incl. `out/`), plus the automated test that walks the repo |

## Verification run

- `npm run typecheck` — clean (node + web).
- `npm test` — 13 files, **106 tests** passed.
- `npm run db:verify` — **154 checks**, 0 failed (30 tables, now including
  `license_history`, `license_attempts`, `license_guard`).
- `npm run smoke` — **32/32** passed on a fresh data directory.
- `npm run build` — main 165 kB (minified), preload 0.64 kB, renderer 932 kB.
- `VENDOR_MASTER_PASSWORD=… npm run verify:secrets` — PASS.

---

# Phase 5 verification — product and inventory management

## Requirement checklist (both editions)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Admin adds, edits and imports products; everyone else views only | ✅ | `products.manage` is Administrator-only (`src/shared/permissions.ts`); `tests/products-inventory.test.ts` shows a cashier's `products.update` returning `FORBIDDEN`; the renderer hides Add/Edit/Import/Export unless `products.manage` |
| Name, brand, category, barcode/SKU, unit and pack size | ✅ | Products form + `products.brand/pack_size/pack_unit` (migration v5); API test asserts brand/pack survive a round trip |
| Automatic pack-to-unit conversion | ✅ | `packsToUnits()` / `unitsToPacks()` in `src/services/products.ts`; receiving 3 packs of 12 adds 36 units (test + smoke "pack-aware stock receipt"); the receive dialog offers packs *or* loose units |
| Cost, retail, wholesale price and wholesale minimum quantity | ✅ | Form fields, `wholesale_min_qty` column, validation (≥ 1), wholesale price shown with its "from N" threshold |
| Reorder level | ✅ | Existing column kept; the products table flags low/out-of-stock rows and the dashboard counts them |
| Only Admin sets/changes prices and cost | ✅ | `products.manage` + `prices.set` are Administrator-only; supervisors keep `prices.override` (POS-only, audited as `price_override_by`) |
| Every price/cost change logged with old and new values | ✅ | `updateProduct` diffs each money field and writes `product.update.price` with `{price, wholesalePrice, costPrice}` `{from,to}`; guarded by `tests/guards.test.ts` |
| Bulk CSV/Excel import with validation and an error report | ✅ | `src/services/imports.ts` (exceljs for `.xlsx`, own RFC-4180 reader for CSV) → `DRY_RUN` then `IMPORT`; report shows created/updated/skipped and per-row `{row, field, message}`; tests cover a bad row, a duplicate SKU row and a clean import |
| Export products | ✅ | `products.export` returns CSV (utf8) or XLSX (base64); `products.exportTemplate` hands back the exact headings; desktop writes them to `data/exports`, the browser downloads them |
| Search by name or barcode | ✅ | `products.list` search covers name, SKU, barcode, category, generic name, PLU and every extra barcode |
| Purchases / stock-in from suppliers | ✅ | `purchases.create` (receive immediately) plus `purchases.createOrder` → `receiveOrder` (GRN) for the supermarket module |
| Stock adjustments (damaged/lost/correction) with a mandatory reason, Admin only | ✅ | `adjustStock` rejects an empty reason (`VALIDATION`), writes `reason_type` into the ledger and audit; `stock.adjust` is Admin-only — a supervisor gets `FORBIDDEN` (test) |
| Cost prices hidden from non-Admin roles | ✅ | `invoke()` runs every response for a session without `products.manage` through `redactCostsDeep`; test asserts `costPrice === 0` while `price` is intact; the UI also hides the Cost column and stock value KPI |
| Low-stock alerts on the dashboard | ✅ | Dashboard KPIs + alert banner (already present) now backed by `stock.alerts` with the configurable expiry window |

## Pharmacy module

| Requirement | Status | Evidence |
| --- | --- | --- |
| Generic name, prescription-only flag | ✅ | Form fields; `prescriptions` feature strips the Rx flag on non-pharmacy licences |
| Batch and expiry tracking, FEFO selling, expired stock blocked | ✅ | Unchanged from phase 3 and still covered by `tests/pos-sales.test.ts` ("sells first-expiry-first-out and never sells expired stock") |
| Near-expiry alerts, default 90 days | ✅ | `settings.expiry_alert_days` (seeded 90) drives `stock.alerts`; a 20-day expiry appears in `expiring` (test) |

## Supermarket module

| Requirement | Status | Evidence |
| --- | --- | --- |
| Departments and sub-categories | ✅ | `mart.departments.*` pages plus `categories.parent_id` for a parent → child tree |
| Shelf/aisle location | ✅ | `products.shelf_location` field on the product form |
| Multiple barcodes per product | ✅ | Extra-barcodes editor in the product modal backed by `mart.barcodes.add/remove/list`; lookup searches all of them |
| Product variants (size/flavour) | ✅ | Variant table + add form in the product modal backed by `mart.variants.save/list` |
| Weighed items: PLU, price per kg, scale or manual weight | ✅ | `products.plu_code/price_per_kg/is_weighed`; POS opens a weigh dialog (typed kg + presets), stores grams, prints `1.500 kg` on the receipt (test asserts ₦1,800.00 for 1.5 kg at ₦1,200/kg) |
| Optional expiry for perishables with alerts | ✅ | `products.expiry_tracking` + `stock.alerts(trackedOnly)` so only opted-in products raise near-expiry alerts |
| Stock counts (stocktake) with a variance report | ✅ | `stocktake.create/save/post` + `StocktakePage`; posting writes one `ADJUSTMENT … reason_type = 'COUNT'` per line and stores variance qty/value (API test + live supermarket walk-through) |
| Supplier purchase orders and goods-received notes | ✅ | `purchases.createOrder` (DRAFT, no stock) → `purchases.receiveOrder` (stock + `GRN-000001`); cancelling a draft touches nothing (tests) |
| Bulk price-label printing (barcode labels) | ✅ | `labels.print` → A4 sheet of labels with an inline Code 128 SVG, copies per product, printable/saveable through `DocumentView` (test counts the label blocks and finds the barcode) |

## DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| Products can be imported | ✅ | Dry run → import → re-import (updates, no duplicates) in `tests/products-inventory.test.ts` and smoke "bulk import" |
| Stock can be received | ✅ | By unit, by pack (× pack size) and by weight (kg → grams); packs/weights tested and smoke-tested |
| Alerts visible for the active edition | ✅ | Pharmacy: expiring/expired batches. Supermarket: tracked perishables + low stock; the Inventory page has Low stock / Near expiry / Expired tabs |
| A non-Admin cannot edit prices or see costs | ✅ | `FORBIDDEN` on `products.update`, `costPrice === 0` for cashier *and* supervisor, and smoke "cost prices are hidden from non-admin roles" |

## Verification run

- `npm run typecheck` — clean (node + web).
- `VENDOR_MASTER_PASSWORD=... npm test` — 14 files, **122 tests passed**.
- `npm run db:verify` — **165 checks, 0 failed** (35 tables, every table written and read back, including `stock_counts` and `stock_count_items`).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (141 files scanned).
- `BASE_URL=... npm run smoke` (fresh data dir) — **36/36 passed**, including import, export/template, pack receipt, reasoned adjustment and cost masking.
- Live supermarket walk-through on the browser harness (licence SUPERMARKET, seeded demo): weighed sale ₦1,800.00 for 1.500 kg, 2 labels on the sheet with a barcode SVG, stocktake variance −4 posted, PO-000001 received as GRN-000001, CSV export of 6 products.
- `npm run build` — main 201.94 kB, preload 0.64 kB, renderer 996.54 kB + 30.18 kB CSS.

---

# Phase 6 verification — point of sale and printed documents

## Requirement checklist

### Sales (shared)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Fast search / barcode scan | ✅ | `products.list` search covers name, SKU, barcode and PLU; scanning a barcode (or pressing Enter on an exact code/PLU) adds the line and clears the box. Covered by `pos-sales` + the POS jsdom mount |
| Cart with quantity editing | ✅ | `+ / −` buttons, a per-line unit price (only when the role holds `prices.override`) and a per-line discount box |
| Retail / Wholesale toggle with automatic price tier | ✅ | `seg-toggle` in the till header; `priceCart()` applies `listPriceFor()` on the server, so the tier cannot be forced from the renderer. Test “sells wholesale on credit …” asserts ₦800 trade price vs ₦1,000 shelf price |
| Per-item and per-sale discounts capped for non-Admins | ✅ | `settings.max_discount_percent` (default 10) is enforced in `priceCart()` for anyone without `settings.manage`; test “caps manual discounts …” shows a cashier blocked at 15% and an administrator allowed |
| Optional customer | ✅ | Customer search attaches a directory record (and shows their credit limit/owing); the wholesale form also accepts a free-text name, phone and address |
| Wholesale customers may buy on credit with part payments | ✅ | `payments.method = 'CREDIT'`, `sales.balance_due`, credit limit check, `pos.credits.list`, `pos.credits.invoices`, `pos.credits.pay`; test “sells wholesale on credit, collects part payment …” |
| Cash / Transfer / POS / Credit, each enabled by the Admin | ✅ | `settings.payment_*` + `enabledPaymentMethods()`; a disabled method is rejected in `createSale` (test “splits payment …” then turns transfers off) and the till only renders enabled buttons |
| Split payments | ✅ | `payments[]`; each row stored in `payments`, test asserts two rows |
| Tendered amount and change | ✅ | `amount_paid` = cash collected, `change_due` computed; POS shows the change tile live; credit sales cannot give change (validation) |
| Hold and recall sales | ✅ | `held_sales` table + `pos.holds.save/list/get/cancel`; test “holds and recalls a basket without touching stock” |
| Block overselling | ✅ | `allocateStock()` runs inside the transaction before money is written; the smoke check “insufficient stock is refused and rolled back” still passes (and now reports stock before the payment error) |
| Deduct stock in one DB transaction | ✅ | `createSale` wraps quote → allocation → sale → lines → payments → loyalty → audit in `db.transaction` |
| Shortcuts F2 / F9 / F10 | ✅ | Global handler on the till page: F2 focus search, F9 complete sale, F10 reprint (DUPLICATE) |

### Pharmacy module

| Requirement | Status | Evidence |
| --- | --- | --- |
| Deduct stock by FEFO across batches | ✅ | Unchanged `allocateStock()` expiry ordering; the live walk-through took batch `PCM-2401` first and reduced stock 218 → 216 |
| Warn on prescription-only items | ✅ | POS shows the prescription field and the required hint; `createSale` refuses with `VALIDATION` unless a reference is given (existing test + live check) |

### Supermarket module

| Requirement | Status | Evidence |
| --- | --- | --- |
| Fast scan-and-go (auto add, repeat scan increments) | ✅ | `handleBarcode()` adds on Enter and a repeat scan increments the existing line |
| Weighed-item lines | ✅ | Weigh dialog (typed kg + presets), grams stored, `qty × price/kg ÷ 1000` everywhere; `/kg` printed |
| Promotions: percentage, BOGO, bundle, time-limited | ✅ | `priceCart()` picks the best active in-window promotion per line; tests cover PERCENT, BOGO (2 free on 4) and MULTIBUY (bundle price). Time windows honoured by `starts_at`/`ends_at` |
| Loyalty earn / redeem | ✅ | Points earned on the total actually paid, redemption capped to the bill, both written to `loyalty_transactions`; test and live run (82 points on ₦4,160.25 at 2 per ₦100) |
| Voids and price overrides need a Supervisor PIN | ✅ | `pos.approve` verifies the approver’s username/password and role, issues a single-use 5-minute token; test “issues a supervisor approval token …” including a refused self-approval and a refused reuse |
| Cash drawer open/close events | ✅ | Existing `mart.drawer.log` (NO_SALE / PAID_IN / PAID_OUT) plus the shift OPEN/CLOSE events; credit collections are attributed to the drawer that took the money (`payments.shift_id`) |
| Cashier shift open/close with opening float | ✅ | `mart.shifts.open/close`; `pos.config` reports the open shift and expected cash, and the till shows a shift banner with an inline “Open shift” control |
| Customer-facing totals display option | ✅ | `settings.customer_display` + the full-screen customer panel in the till (server-priced lines, discount, VAT, total, change) |

### Printing

| Requirement | Status | Evidence |
| --- | --- | --- |
| 80mm thermal, 58mm thermal, A4 receipt, A4 invoice | ✅ | `documents.ts` layouts with `@page size: 80mm/58mm auto` and A4; tests assert the page rules and the live run printed all four |
| Always with print preview | ✅ | `DocumentView` (iframe preview, print, save) opens on completion and from the sales list |
| Store name large, bold, centred at the top | ✅ | `storeHeader()` renders the name first; the test asserts the name appears before the first item |
| Logo above the name, greyscale on thermal | ✅ | `<img class="store-logo">` only when set; thermal CSS applies `filter: grayscale(100%)` |
| Address / phone(s) / email / licence / VAT only when filled | ✅ | `storeHeader()` filters empty fields; tests assert email + licence number appear once set |
| Sequential number, date/time, cashier, customer | ✅ | Header meta block on every layout |
| Items with qty, unit price, line total; discount; subtotal; VAT; total | ✅ | Line table with a discount column on A4 and inline discounts on thermal; totals block shows promotions, item discounts, sale discount, loyalty, VAT at its rate and the total |
| Payment method(s), amount paid, change, credit balance | ✅ | Payment block lists each row (split shows every method), then paid, change and balance due |
| Configurable footer + thank-you note | ✅ | `footerText()`; both settings print once each with a sensible default |
| “Powered by Infoflex Pharm/Mart” footer, Admin on/off, default on | ✅ | `settings.powered_by_footer` (seeded true) drives the small line; the company tagline never appears in the header |
| Snapshot store name/address/phone; reprint marked DUPLICATE and logged | ✅ | `sales.store_*` snapshots, `document_prints` log, `sales.print_count`; test “prints a thermal receipt …” and the live run |
| Settings edits affect new documents only | ✅ | Same test: rename → old reprint still shows the old name, the next sale shows the new one |
| Missing store name blocks printing with a Settings message | ✅ | `pos.print` throws `PRINT_BLOCKED` pointing at Settings → Store profile (test) |

### DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| A full retail sale completes | ✅ | Live: RCP-000004 with a promotion, 7.5% VAT, split cash/transfer tender and loyalty points |
| A full wholesale sale completes | ✅ | Live: INV-000002 at trade prices with 60% paid by transfer and 40% on account, then a part payment collected |
| Stock reduces correctly (FEFO in pharmacy) | ✅ | Pharmacy 218 → 216 on a batch with an expiry date; retail/wholesale stock assertions in tests |
| Promotions and loyalty compute correctly | ✅ | 10% promotion = ₦430, VAT ₦290.25, total ₦4,160.25, 82 points; BOGO/MULTIBUY unit tests |
| Printed/previewed receipt and invoice show the store name at the top | ✅ | Live: thermal 80mm, thermal 58mm, A4 receipt and A4 invoice all head with “Sunmart Supermarket” / “Grace Pharmacy” |
| Changing the store name changes new receipts but not old reprints | ✅ | Test + live run: renamed to “(Phase 6)”, reprint unchanged, next sale carries the new name |

## Verification run

- `npm run typecheck` — clean (node + web, strict, `noUnusedLocals`).
- `VENDOR_MASTER_PASSWORD=... npm test` — 15 files, **132 tests passed** (10 new phase-6 API tests).
- `npm run db:verify` — **178 checks, 0 failed** (37 tables, every table written and read back, including `held_sales` and `document_prints`).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (145 files scanned).
- `BASE_URL=... npm run smoke` (fresh data dir) — **41/41 passed**, including till config, a VAT quote that matches the sale, split payment, the print/DUPLICATE trail and hold/recall.
- Live walk-through on the browser harness (4180 supermarket / 4183 pharmacy) — **22/22 checks**: promotion+VAT+loyalty retail sale, thermal/A4 printing, hold/recall, credit invoice with part payment, store rename snapshot rule, pharmacy FEFO batch and 58mm receipt.
- `npm run build` — main 237.91 kB, preload 0.64 kB, renderer 1,045.50 kB + 32.33 kB CSS.

## What was not verified here

- A physical thermal printer, ESC/POS commands and the cash-drawer kick-out: the layouts print through Chromium’s dialog, so the operator picks the 80mm/58mm paper size once. The drawer log is financial only.
- The customer display is a full-screen panel on the same machine; a second physical monitor needs a second window (see DECISIONS §34).
- No Electron window, NSIS installer or wine in this sandbox — same limitation as every earlier phase.

---

# Phase 7 verification — returns, refunds and credit notes

## Requirement checklist

### Returns (shared)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Look the original sale up by receipt number | ✅ | `returns.lookup` accepts `receiptNo` (case-insensitive) or `saleId` and returns the sale, per-line `returnableQty`, credit per unit/kg, batch and its expiry, age, window and limit; test “opens a receipt by number …” plus the live runs on both editions |
| Full or partial returns per item | ✅ | Per-line quantity capped at `sold − already returned` (completed **and** pending), checked again inside the transaction; test “never returns more than was sold …” and the live over-return check |
| Never more than the quantity originally sold | ✅ | Second attempt at the same units returns `VALIDATION` “at most 0”, and the lookup then reports `returnableQty 0` / `returnableValue 0` |
| Reasons: wrong item, damaged, expired, changed mind, other | ✅ | `RETURN_REASONS` stored as `returns.reason_code` / `return_items.reason_code`; “other” requires a note; labels printed on the credit note |
| Types: refund, store credit, exchange | ✅ | `RETURN_TYPES`; store credit forces `refund_method = 'STORE_CREDIT'`, exchange requires the replacement note; test “marks store credit and exchange correctly” and live |
| Resellable goods return to stock (pharmacy: original batch) | ✅ | `receiveStock(..., batchNo from the sale line, type RETURN, refId return + batch_id)`; test asserts `AMX-EARLY` goes back to 2 and the movement is linked; live supermarket restock 27 → 28 |
| Non-resellable goods go to a write-off record | ✅ | `stock_writeoffs` row per line at `cost_price × qty`, `return_items.writeoff_id`, audit `return.writeoff`, register via `returns.writeoffs`; tests and live (2 lines, ₦1,000.00 at cost) |

### Policy (shared)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Configurable return window (default 7 days) | ✅ | `settings.return_window_days`, surfaced by lookup; test ages a sale 10 days and gets `withinWindow: false` |
| Administrator override of the window | ✅ | `pos.approve` purpose `RETURN_WINDOW` (needs `settings.manage`), single-use token consumed by `returns.create`, `window_override = 1`, `approved_via = 'PIN'`; test proves a supervisor is refused and an administrator is allowed |
| Returns above an Admin-set value need approval | ✅ | `settings.return_limit` (default ₦20,000); above it a cashier is queued as `PENDING`, or completes immediately with a `RETURN` token from a supervisor/administrator; tests cover both paths, live covers both paths |
| Password / PIN prompt at the desk | ✅ | Approvals modal on the returns page posts to `pos.approve` and submits straight away with the issued token; approver passwords are verified with scrypt and never stored |
| Pharmacy: expired or opened goods never back on the shelf | ✅ | `resellableFor()` forces a write-off for the *expired* reason, for `condition = OPENED` on pharmacy licences and for a batch past its expiry; test + live pharmacy run |
| Supermarket: loyalty and promotions reversed proportionally | ✅ | `promo_reversed`, `discount_reversed`, `loyalty_points_reversed`, `loyalty_value_reversed` use `returned_basis ÷ all_basis`; the loyalty ledger gets a negative row; test returns a third of a 10% promo (₦100 of ₦300) and 9 of 27 points |

### Documents and records

| Requirement | Status | Evidence |
| --- | --- | --- |
| Print a return / credit note | ✅ | `returns.print` returns HTML, logs `document_prints` (`kind = 'RETURN'`, `return_id`) and stamps every print after the first **DUPLICATE**; `returns.document` is preview-only |
| Same store-name header as receipts, from the sale's snapshot | ✅ | `returns.store_*` copied from the sale; test renames the shop and the credit note still shows the old name; live asserts the printed HTML contains the store name |
| Log everything | ✅ | Audit `return.create` / `return.request` / `return.complete` / `return.reject` / `return.print` / `return.reprint` / `return.writeoff` / `pos.approval`, all with the receipt number, lines, reason, type and reversals |
| DB transactions | ✅ | Lookup is read-only; creation + completion (stock, write-offs, loyalty, credit-note number) run inside `db.transaction`, so a failure leaves no half-return |
| Returns never delete a sale | ✅ | The return links by `sale_id`; the sale row is untouched, and voiding (the only way to reverse a sale) remains a separate audited action |

### DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| Over-return scenario tested and passing | ✅ | `tests/returns-phase7.test.ts` “never returns more than was sold, across several returns and pending ones” |
| Window scenario tested and passing | ✅ | “blocks returns outside the window until an administrator overrides it” (10-day-old sale, supervisor refused, admin token accepted) |
| Approval scenario tested and passing | ✅ | “asks a supervisor to approve returns above the limit, by PIN or by queue” (pending → approve, and immediate PIN completion) |
| Loyalty reversal scenario tested and passing | ✅ | “reverses promotions and loyalty points proportionally (supermarket)” — 27 → 18 → 0 points, promo ₦300 → ₦100 → ₦200 |
| Stock-effect scenario tested and passing | ✅ | “restocks resellable goods to their batch and writes off the rest (pharmacy)” — batch restock, write-off at cost, expired and opened rules |
| The credit note shows the store name | ✅ | “prints a credit note with the original store name …” and the live print on both editions |

## Verification run

- `npm run typecheck` — clean (node + web, strict, `noUnusedLocals`).
- `VENDOR_MASTER_PASSWORD=... npm test` — 16 files, **142 tests passed** (10 new phase-7 API tests; the weighed-return test now asserts `netTotal`).
- `npm run db:verify` — **190 checks, 0 failed** (38 tables, schema v7, including `stock_writeoffs`, the pending/approved return paths and the credit-note print trail).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (146 files scanned).
- `npm run db:schema` — regenerated `docs/SCHEMA.md` (38 tables).
- `BASE_URL=... npm run smoke` (fresh data dir) — **42/42 passed**, including the new “returns desk opens a receipt and writes off damaged goods” check.
- Live walk-through on the browser harness — **17/17 checks** (9 supermarket on :4180, 8 pharmacy on :4183): receipt lookup by number, partial restock, over-return refusal, costed write-off, credit note with the store name + DUPLICATE reprint, store credit and exchange, pending/PIN approvals, supervisor refused the window override, expired and opened pharmacy goods written off.
- `npm run build` — main 253.12 kB, preload 0.64 kB, renderer 1,064.83 kB + 32.33 kB CSS.

## What was not verified here

- The aged-receipt window override in a live run: there is no channel that ages a sale, so it is proven in the test suite (and the verifier) rather than through the harness.
- Loyalty/promotion reversal live: the supermarket promotion and loyalty screens reach `mart.*` channels that arrive in the supermarket phase, so this phase proves the reversal through service-level tests.
- A physical printer: the credit note prints through the same Chromium preview/dialog as receipts; no thermal hardware in the sandbox.

---

# Phase 8 verification — daily and monthly accounting, reports and exports

## Requirement checklist

### Daily summary (any date)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Total sales, transaction count | ✅ | `reports.daily` → `grossSales`, `salesCount`; test “builds a daily summary that matches the hand calculation” asserts ₦2,500.00 / 1 sale on the retail day and ₦4,500.00 on the credit day |
| Retail vs wholesale | ✅ | `retailCount/retailSales` and `wholesaleCount/wholesaleSales` from `sales.tier`; the ledger has one retail and one wholesale day |
| Payment-method breakdown | ✅ | `payments[]` grouped by method, biggest first — the test expects `CREDIT ₦2,500.00` then `TRANSFER ₦2,000.00`; the live pharmacy run showed `Bank transfer ₦9,900.00, Cash ₦7,320.00` |
| Discounts | ✅ | `discounts` = Σ `sales.discount` (₦100.00 in the ledger); shown as a tile and printed |
| Returns / refunds | ✅ | `returnsTotal` + `returnsCount` dated by `approved_at`; ₦960.00 in the ledger, VAT share reversed in the VAT test |
| Net sales | ✅ | `netSales = saleTotals − tax − (returns − returnsTax)` — ₦1,440.00 on the retail day, hand-checked |
| COGS | ✅ | Line cost (weighed: `cost × qty ÷ 1000`) minus resellable returns — ₦900.00 retail day, ₦3,000.00 credit day |
| Gross profit — **Admin only** | ✅ | `null` unless `session.role === 'ADMIN'`; the cashier test asserts `grossProfit === null` and that the printed page has no “gross profit” |
| Sales per user | ✅ | `users[]` with count/gross/net/returns; the cashier sees one row (their own), the admin sees both |
| Non-Admins see only their own figures | ✅ | `buildReportForSession` scopes to `session.userId` and locks the period to today; test “shows a cashier only their own figures and never profit” (₦800.00 of ₦2,400.00) |

### Monthly summary (any month)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Same figures as a day | ✅ | `MonthlySummary extends SummaryTotals`; the month test asserts gross ₦7,000.00, returns ₦960.00, net ₦5,940.00, COGS ₦3,900.00, profit ₦2,040.00 |
| Day-by-day table | ✅ | `days[]` always has 28–31 rows; day 1 (₦1,440.00) and day 2 (₦4,500.00) match the daily summaries, and a quiet day is zeros |
| Daily sales chart | ✅ | `chart.labels` / `chart.values` per day plus an HTML bar chart on the page; totals reconcile with `netSales` |
| Any month / year | ✅ | Month picker on the reports page (`<input type="month">`) and `reports.monthly({ month })`; live run on 2026-10 returned 31 days |

### End-of-day close

| Requirement | Status | Evidence |
| --- | --- | --- |
| Cashier enters counted cash | ✅ | Counted-cash field beside an opening-float field; `operations.day.close` takes kobo integers and validates them |
| Expected vs actual and the difference | ✅ | Expected = float + cash sales − cash refunds; the test closes with ₦2,590.00 against ₦2,600.00 expected and stores `variance = −1,000` kobo |
| Saves it | ✅ | One `day_closings` row per business date (unique), `closed_at`, `closed_by_name`, note, audited `day.close`; a second close returns `CONFLICT` |
| Supermarket: per shift with over/short | ✅ | `dayReconciliation` lists every shift with float, cash in, refunds, expected, counted, variance; live supermarket run: one shift, expected ₦14,600.00, counted ₦13,595.00, short ₦10.05 |
| Supermarket: per cashier with over/short | ✅ | `cashiers[]` built from the day's sales per user; live run showed Chidi Cashier ₦14,600.00 expected |
| A voided sale does not inflate the drawer | ✅ | Shift cash joins `sales.status = 'COMPLETED'`; the day-close test voids a cash sale inside the shift and the expected cash stays at ₦800.00 |
| Only supervisors/admins may close | ✅ | Permission `reports.view.all`; the test asserts a cashier gets `FORBIDDEN` |

### Other reports

| Report | Edition | Status | Evidence |
| --- | --- | --- | --- |
| Top sellers | shared | ✅ | Units, revenue, profit, ranked; test: Rice 5kg 7 units ₦6,500.00, profit ₦2,300.00 |
| Slow movers | shared | ✅ | Products with no or few sales in the period plus the stock value tied up (₦6,000.00 for the sleeping beans) |
| Stock valuation | shared | ✅ | Retail for everyone, cost only for the administrator (supervisor test asserts the column and the total are absent) |
| Low stock | shared | ✅ | At or below the reorder level, with the shortfall |
| Debtors / credit | shared | ✅ | `reports.view.all` only; test: Sunrise Stores, one invoice, ₦2,500.00 owing, ₦50,000.00 limit, cashier refused |
| Supplier purchases | shared | ✅ | One row per supplier with invoices, total and outstanding balance (₦5,500.00 owed when nothing was paid) |
| User performance | shared | ✅ | Per-user sales, average basket, cash taken, returns, voids — admin row: 2 sales, ₦6,900.00, ₦960.00 returned |
| Audit log | shared | ✅ | `audit.view` only; cashier refused with `FORBIDDEN` |
| Expiry and write-offs (pharmacy) | pharmacy | ✅ | Expiry windows and the costed write-off register; a pharmacy licence lists them and a supermarket licence refuses with `EDITION_RESTRICTED` |
| Sales by department (supermarket) | supermarket | ✅ | Department revenue after the promotion discount, cost and margin; test: Groceries 4 units, ₦3,600.00 |
| Promotion performance (supermarket) | supermarket | ✅ | Lines, units, revenue and the discount given per promotion (₦400.00 on “Beans 10% off”) |
| Loyalty (supermarket) | supermarket | ✅ | Points earned, redeemed and the balance per member (36 points on ₦3,600.00) |
| Stocktake variance (supermarket) | supermarket | ✅ | Counted vs system quantity with the value of the difference |
| Voids and overrides (supermarket) | supermarket | ✅ | Voided sales and every `pos.approve` grant with the approver; live run returned 2 rows |

### Printing and export

| Requirement | Status | Evidence |
| --- | --- | --- |
| Store name, address and period at the top | ✅ | Every report's HTML comes from `documents.ts` with the Settings store identity and the period as the subtitle; the test walks all 18 kinds and asks for the store name, address, title and period |
| Printable | ✅ | `reports.build` → HTML → `print.document` (Chromium dialog), with a preview modal on the page |
| Export to PDF | ✅ | `reports.pdf` renders the same HTML with `printToPDF` in an offscreen `BrowserWindow` (desktop only); the harness answers `UNAVAILABLE` with a readable message (asserted in the smoke run) |
| Export to Excel / CSV | ✅ | `reports.export` (CSV with BOM, store block, meta summary, `Total` row) and `reports.excel` (real `.xlsx` via `exceljs`, naira number formats, bold total row); both asserted in tests and the smoke run |
| Downloaded or saved sensibly | ✅ | `documents.saveExport` writes into `data/exports` on the desktop; the browser downloads. Filenames `daily_summary-2026-03-05.csv` / `sales_summary-2026-03-05.xlsx` |

### DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| Totals match hand calculations on seeded sample data | ✅ | `tests/reports-phase8.test.ts` writes its own ledger (₦2,500.00 retail with a ₦100.00 discount and a resellable rice return, ₦4,500.00 wholesale on credit) and asserts every total from the arithmetic worked out by hand in the test, including the VAT split |
| Printed and exported reports show the store name | ✅ | 18-kind print test, CSV test and Excel test all look for “Sunmart Test Store”; the live runs looked for “Grace Pharmacy” |

## Verification run

- `npm run typecheck` — clean (node + web, strict, `noUnusedLocals`).
- `VENDOR_MASTER_PASSWORD=... npm test` — 17 files, **154 tests passed** (12 new phase-8 API tests; the renderer suite gained the mocked report channels).
- `npm run db:verify` — **190 checks, 0 failed** (38 tables, schema v7 — no schema change in this phase).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (149 files scanned).
- `BASE_URL=... npm run smoke` (fresh data dir) — **48/48 passed**, including six new checks: daily summary, monthly table + chart, day reconciliation arithmetic, CSV with the store name and a total row, a real `.xlsx` workbook, and the `UNAVAILABLE` message for PDF in the browser harness.
- Live walk-throughs on the browser harness — **33 checks**: 14 on a pharmacy licence (daily summary, payment split, reconcile, CSV, Excel, PDF message, day close with a ₦0.50 shortfall, cashier scoping, `FORBIDDEN` on debtors, catalogue of 15 reports) and 19 on a supermarket licence (shift open/close, promotion + loyalty sale, cashier void request approved by the admin, daily totals and profit, shift and per-cashier reconciliation, day expected cash, department/promotion/loyalty/void reports, monthly summary, day close variance, Excel export).
- `npm run build` — main 295.14 kB, preload 0.64 kB, renderer 1,095.26 kB + 33.55 kB CSS.

## What was not verified here

- The Electron PDF path: `printToPDF` needs a real `BrowserWindow`, so the sandbox only proves the `UNAVAILABLE` fallback and the HTML that would be rendered. The desktop build wires `ctx.pdf` in `src/main/index.ts`.
- A physical printer and paper sizes: reports print through the same Chromium dialog as receipts.
- A month of real trading: the month table is proven with a seeded month (two trading days inside one calendar month) rather than 31 days of shop data.
- Concurrent closing from two machines: the SQLite file is single-user, so the unique `business_date` row is the only guard needed.

# Phase 9 — Settings, backup/restore and hardening

## Settings (Administrator only)

| Requirement | Status | Evidence |
| --- | --- | --- |
| Store name, address, phone, email, licence no., tax no., own logo, receipt footer, thank-you note, "Powered by Infoflex" toggle | ✅ | One `SettingsPayload`; the logo is a data URL, the footer/thank-you appear on every document; `settings.update` audit records which keys changed |
| Store name cannot be saved empty | ✅ | `updateSettings` → `VALIDATION` "Store name cannot be empty."; smoke and the live run both send `'   '` and are refused |
| **Live receipt preview** | ✅ | New `settings.preview` (`{draft}` → `{html, layout, settings, dirty}`) merges the unsaved draft over the saved settings, builds a sample sale and renders it through `buildSaleDocument`; the Settings page shows it in a sandboxed `iframe` and marks it "Unsaved changes". Test: typing "Bright Care Pharmacy" changes the HTML, the stored name is untouched, an empty name falls back to the saved one, VAT appears only when enabled, and `dirty` is `false` for an unchanged draft |
| Receipt paper size, VAT, currency, discount limit, return window, idle timeout | ✅ | `receiptLayout` (80 mm/A4), `vatEnabled`+`vatRate`, currency fixed NGN ₦ with 2dp, `maxDiscountPercent`, `returnWindowDays`, `idleTimeoutMinutes` (1–720) |
| Enabled payment methods | ✅ | `paymentCash/Transfer/Pos/Credit`; the till only offers what is on; credit also needs a wholesale customer |
| **Printer selection** | ✅ | `print.printers` (`listPrinters()` via an offscreen `BrowserWindow`) plus `printerName`/`silentPrint`/`labelPrinterName`; `print.document` passes `deviceName` and `silent` to Chromium. `UNAVAILABLE` (browser harness) and "no printers" both fall back to typing a name. `silent` is only sent when a printer is pinned |
| Pharmacy options | ✅ | `expiryAlertDays` (1–730, default 90) drives the dashboard count, `stock.alerts` and the expiry reports; reading it as a typed setting removed `getNumericSetting` |
| Supermarket options | ✅ | Loyalty (`loyaltyPointsPer100`, `loyaltyPointValue`, `loyaltyRedeemEnabled`), `approvalTtlMinutes` (1–60) and `supervisorSelfApproval` in `approvals.ts` (an Admin may approve themselves only when it is on; supervisors and cashiers never), scale layout and label printer |
| Scale barcodes at the till | ✅ | `parseScaleBarcode` + `products.scan`; test: `20002500250` → PLU `00025`, 250 g, a trailing check digit accepted, wrong prefix/letters/zero weight/wrong length refused, a second layout works; the POS adds the grams and prints "Scale label: … added" |
| Licence status read-only | ✅ | Settings → Edition & licence: edition, customer, period, expiry, `VALID`/… badge and `daysRemaining`, with no edit path (the Licence page is the only place that activates) |

## Backup and restore

| Requirement | Status | Evidence |
| --- | --- | --- |
| Automatic daily local backup | ✅ | `runDailyBackup` on desktop start/shutdown (and in the harness): one snapshot per 24 h, skipped when the newest auto/shutdown file is fresh and on a `NONE` licence; test takes one, gets `null` on the second call, and `null` on an unlicensed harness |
| Manual backup to a chosen folder or USB | ✅ | Also on the desktop File menu ("Back up to a folder…", Ctrl+Shift+B). `backup.create {label, folder}` writes the snapshot straight to the folder (`did the operator's stick really take it?`), `backup.chooseFolder` opens the Windows folder dialog, `backup.listFolder` lists what is there, `backup.copy` pushes an older file out; external files are capped at 2 GB and symlinks are refused |
| Restore with confirmation | ✅ | `backup.restore {path, confirm}` refuses unless `confirm === basename(path)` (`VALIDATION`); the UI disables the button until the typed name matches; a safety copy `pre-restore_<dbfile>_<ts>.db` is always written first and can be restored to undo |
| Warn if no backup in 7 days | ✅ | `backupStatus.stale` (`warnAfterDays: 7`); the Backup page shows a warning banner and the dashboard shows one for Administrators; smoke checks the fresh case |
| **A restore never overwrites or bypasses the licence state** | ✅ | `restoreBackup` captures `license_state`, `license_guard`, `license_history`, `license_attempts`, swaps the file, then re-inserts the captured rows in one transaction; test restores a **supermarket's** backup into a pharmacy install and asserts edition, expiry and the history count survive, the products do change, the backup's own licence is only recorded in the audit trail, and the safety copy exists |
| Two files in the same second | ✅ | Found live: second-precision names made `VACUUM INTO` fail with "output file already exists". `timestamp()` now has milliseconds and `uniquePath` never overwrites; test creates two backups and two restores in a row |

## Security review

| Area | Status | Evidence |
| --- | --- | --- |
| IPC permission checks | ✅ | Every channel declares a `permission`; `invoke` resolves the session first and denies with `FORBIDDEN`. New channels: `products.scan` (`products.view`), `print.printers`/`settings.preview` (`settings.manage`), the whole `backup.*` family (`settings.manage`) — the preview is refused to a cashier in a test |
| SQL injection | ✅ | All queries are prepared statements with bound parameters; the only interpolated identifiers are the table/column names in the licence capture (from a constant list) and `VACUUM INTO ?` |
| Input validation | ✅ | Typed validation for every settings field (ranges, digits, enums), backup paths (`absolute`, `.db`, exists, not a symlink, ≤ 2 GB, `PRAGMA integrity_check`, must contain the four core tables), scale digits and the typed restore confirmation |
| Payload limits | ✅ | `invoke` refuses any payload over 4 MB with `VALIDATION` before touching a service; test sends a 4.5 MB string |
| No sensitive data in logs or the audit trail | ✅ | `redactDetails` replaces any value whose key matches `pass|password|pin|token|secret|hash|authorization|license_code|activation_code` with `[redacted]`; `settings.update` records changed keys rather than a logo data URL; the master password never enters an audit entry (test dumps the whole trail); `verify:secrets` scans 144 files |

## DONE WHEN

| Criterion | Status | Evidence |
| --- | --- | --- |
| Edit the store name and see it on the next receipt preview | ✅ | Live run: preview with "Grace Pharmacy Ikeja" contains the name and leaves the stored name alone → save → the next preview (empty draft) shows the saved name; empty name refused |
| Back up, wipe the database, restore, find all data intact | ✅ | Live run (35 checks): backup to a stand-in USB folder, then work done afterwards (a new product and a wrong store name) is replaced by the backup's 6 products, 6 sales and the right store name; a mistyped confirmation is refused with the database untouched; the safety copy is restored to prove the undo path |
| The licence state is unaffected | ✅ | Live run compares edition, state, expiry and history before/after the restore — all identical; the API reports the kept licence and the audit entry records the file's own licence |

## Verification run

- `npm run typecheck` — clean (node + web, strict, `noUnusedLocals`).
- `VENDOR_MASTER_PASSWORD=... npm test` — 18 files, **169 tests passed** (12 new phase-9 API/service tests, 3 new renderer tests, plus the updated restore contract in the reports/backup suite).
- `npm run db:verify` — **190 checks, 0 failed** (38 tables, schema v7 — no schema change in this phase).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (144 files scanned).
- `BASE_URL=... npm run smoke` (fresh data dir) — **53/53 passed**, including five new checks: backup status freshness/seven-day window, the refused mistyped confirmation, the plain `UNAVAILABLE` printer message, the live preview that saves nothing, and a scale barcode that scans with its weight.
- Live walk-through on the browser harness — **35 checks**: preview draft/saved/empty-name, printer fallback, saving pharmacy and supermarket options, scale scan, backup to a chosen folder, freshness, changes after the backup, refused confirmation, restore with the licence kept, safety copy, undo restore, and a missing file refused.
- `npm run build` — main 308.24 kB, preload 0.64 kB, renderer 1,115.29 kB + 33.55 kB CSS.

## What was not verified here

- **Real Windows printers.** `listPrinters()` and `webContents.print({deviceName, silent})` need Windows and a driver; the sandbox proves the `UNAVAILABLE` fallback, the pinned-name plumbing and the plain-English messages.
- **A real USB stick or network share.** The chosen-folder path is exercised against a temporary directory on the same disk; a write-protected or unplugged stick produces Windows errors that the handler turns into `VALIDATION`/`CONFLICT` messages, not silent success.
- **The Electron folder/file dialogs.** `dialog.showOpenDialog` only exists in the desktop build; in the browser the page falls back to typing a path (asserted by the renderer tests).
- **A literal "delete infoflex.db and restore".** A restore deliberately keeps the licence of the machine it runs on, so a database deleted *including its licence tables* comes back as an unlicensed install until the vendor re-issues — that is the "never bypass the licence" rule working as designed. The live run therefore simulates the disaster by changing data after the backup.
- **Time travel for the seven-day warning.** The staleness clock is `Date.now()`; the threshold and the fresh case are asserted, and the older-than-seven-days case is covered by unit logic rather than by moving the machine clock.

# Phase 10 — Polish and testing

## Pass/fail by edition

Every row below was run twice: once on a PHARMACY licence and once on a
SUPERMARKET licence, on fresh databases. "E2E" is `npm run e2e` (real HTTP
bridge, own data directory and port per edition); "test" is the vitest suite
(`tests/e2e-editions.test.ts`, `tests/phase10-units.test.ts`).

| Journey | PHARMACY | SUPERMARKET | Evidence |
| --- | --- | --- | --- |
| Activation with the edition | **PASS** | **PASS** | E2E + test: `license.activate` → `VALID`, edition echoed, product name `Infoflex Pharm` / `Infoflex Mart`, module flags correct |
| First-run setup: admin + store name | **PASS** | **PASS** | E2E: `setup.complete` then `setupRequired: false`; the store name appears on every document |
| Empty store name rejected | **PASS** | **PASS** | `VALIDATION` "Store name cannot be empty." in the API and in the E2E run; the setup screen disables the button and shows the same sentence |
| Second setup refused | **PASS** | **PASS** | `CONFLICT` when setup runs twice |
| Login: Admin | **PASS** | **PASS** | E2E; wrong password → `UNAUTHENTICATED` |
| Login: Cashier (+ forced password change) | **PASS** | **PASS** | E2E: temp password flagged, business calls refused until changed, then allowed; cashier cannot add users |
| Login: Supervisor | **n/a** (role not offered) | **PASS** | test: `users.create SUPERVISOR` on a pharmacy licence → `EDITION_RESTRICTED`; on a supermarket licence the supervisor signs in and can approve but not administer |
| A sale to a printed receipt showing the store name | **PASS** | **PASS** | 2 × ₦1,350.00 = ₦2,700.00; receipt contains store name, address and receipt number; second print stamped DUPLICATE |
| A return with a credit note | **PASS** | **PASS** | ₦1,350.00 refund, credit note shows the store name and its own number |
| Reports | **PASS** | **PASS** | Daily summary: gross ₦2,700.00, returns ₦1,350.00, net ₦1,350.00, store name in the HTML |
| The expiry lock | **PASS** | **PASS** | test with the injected clock: 31 days later `EXPIRED`, business channels `LICENSE_EXPIRED`, `license.status` still answers |
| Renewal | **PASS** | **PASS** | test + smoke: new period → `VALID`, old data intact, both periods in `license.history` |
| The other edition's module is off | **PASS** | **PASS** | `pharmacy.expiryWatch` on a supermarket licence → `EDITION_RESTRICTED` (and the reverse) |
| Demo dataset loads and removes | **PASS** | **PASS** | 30 pharmacy products / 35 batches; 60 supermarket products, 2 departments, 8 weighed items, 3 promotions, 3 customers, 3 loyalty members; removal takes exactly the seeded rows out |
| Store rename keeps old receipts | **PASS** | **PASS** | E2E: the renamed shop's old receipt still prints the old name, and the preview follows the new one |

Nothing in the table is a "partial" or an "n/a because it failed": the only n/a
is the Supervisor role, which a pharmacy licence does not offer by design.

## Polish

| Requirement | Status | Evidence |
| --- | --- | --- |
| Navy/gold/off-white styling applied consistently | ✅ | Every screen renders through the shared `Card`/`PageHead`/`Button`/`DataTable`/`Badge`/`Alert` components; the renderer test mounts all 25 pages and asserts no error alert appears |
| Friendly validation messages | ✅ | Every service throws a sentence, not a code: "Store name cannot be empty.", "That folder does not exist. Plug the drive in and choose it again.", "You can return at most 2 of Paracetamol (1 already returned)." The renderer shows them in a toast or an inline alert |
| Confirmation dialogs for destructive actions | ✅ | Shared `ConfirmDialog`: post a stock count, cancel a purchase order, deactivate a product, load/remove demo data, void a sale (with reason), restore a backup (type the file name). `window.confirm` is gone from the codebase |
| Loading states | ✅ | `Loading` component plus "Loading…" in tables and KPIs while a fetch is in flight (`DashboardPage`, `InventoryPage`, `AuditPage`, `ProductsPage`, …) |
| Empty states | ✅ | `EmptyState` inside every `DataTable` with a sentence per screen ("No backups found yet. Take one now.") |

## Optional demo data

| Requirement | Status | Evidence |
| --- | --- | --- |
| ~30 pharmacy products with batches | ✅ | 30 products across 8 categories, 35 batches, second batches for FEFO, near-expiry stock and one expired batch |
| ~60 supermarket products incl. weighed items, promotions, 2 departments | ✅ | 60 products in Groceries and Household, 8 weighed items with PLU 00101–00108 and prices per kg, 3 promotions (PERCENT/BOGO/MULTIBUY) that the pricing engine actually applies |
| Sample users | ✅ | `demo.cashier` and (supermarket/BOTH) `demo.supervisor`, password `Demo1234`, forced to change at first sign-in |
| Admin can load **and remove** | ✅ | `demo.load` / `demo.remove` / `demo.status`, `settings.manage` only; removal keeps anything the shop has used and reports it; tested (including a sold demo product being kept) |
| Does not disturb real data | ✅ | Removal only touches ids in the `demo_data` register; the seed never creates a sale |

## Unit tests requested in this phase

| Area | Test | Result |
| --- | --- | --- |
| Retail vs wholesale pricing | `phase10-units` — receipts stay at shelf price; invoices drop to the trade price only at the wholesale minimum; the sale stores what it charged | ✅ |
| FEFO deduction | earliest-expiring batch sells first (4 from EARLY, 2 from LATE); an expired batch alone → `INSUFFICIENT_STOCK` | ✅ |
| Promotions maths | 10% off ₦3,000 → ₦300; BOGO 4 → 2 free; multi-buy 5 for ₦4,000 → ₦1,000 off; two units do not trigger the bundle; offers never stack | ✅ |
| Loyalty maths | ₦10,000 at 2 pts/₦100 → 200 pts; 50 pts at ₦50 → ₦2,500 off; re-earns 150 → balance 300 | ✅ |
| Return limits | a ₦30,000 receipt over the ₦20,000 cashier ceiling is queued, a cashier cannot approve it, an admin can; out-of-window returns need `APPROVAL_REQUIRED` | ✅ |
| Daily/monthly totals | void excluded, refund reduces takings, gross/returns/net agree between the daily and monthly reports | ✅ |
| Licence date range and edition flags | expiry locks trading, renewal unlocks, history keeps both periods; module flags per edition | ✅ |
| Store-name snapshot on sales and reprints | old receipt and credit note keep the old name after a rename; address/phone snapshotted too; a blank name cannot be saved | ✅ |

## Verification run

- `npm run typecheck` — clean (node + web, strict, `noUnusedLocals`).
- `VENDOR_MASTER_PASSWORD=... npm test` — **20 files, 191 tests passed** (15 phase-10 unit tests, 5 edition E2E tests, 2 new renderer tests, and the licence-guard suite updated for the shared clock).
- `npm run db:verify` — **194 checks, 0 failed** (39 tables, schema v8 — `demo_data`).
- `VENDOR_MASTER_PASSWORD=... npm run verify:secrets` — PASS (155 files scanned).
- `VENDOR_MASTER_PASSWORD=... npm run e2e` — **32/32** (16 checks × 2 editions), fresh database per edition, table printed by the script.
- `BASE_URL=... npm run smoke` (fresh data dir) — **54/54**, including demo data load/remove.
- `npm run build` — main 325.15 kB, preload 0.64 kB, renderer 1,125.29 kB + 33.69 kB CSS.
- Browser harness left running with the pharmacy demo catalogue loaded for a live look.

## Bugs found and fixed

| Bug | How it showed up | Fix |
| --- | --- | --- |
| Sessions stamped and compared `Date.now()` while the licence guard used the injected clock | The E2E expiry journey locked the app with "the system clock has moved backwards" mid-request | `session.ts` uses `ctx.now()` for the idle timeout, the licence re-read and new sessions |
| Time travel did not end a session | Follow-on from the fix: a month of idleness now signs out, as the 15-minute idle rule requires | Licence tests sign in again after jumping the clock |
| Demo prices per kilogram were in naira, not kobo | The BOTH-edition test sold 1.5 kg of rice for ₦21.00 | `pricePerKg` values ×100 (₦800–₦3,200/kg) |
| Two backups or restores in the same second collided (`VACUUM INTO` refuses to overwrite) | Found while testing the restore path in phase 9 | Millisecond timestamps + `uniquePath` never overwrites |
| The `e2e` script left its harness processes running, so the next run reused an old database | Second run showed a renamed store on a "fresh" install | The script starts each harness in its own process group and kills the group |

## What was not verified here

- **A real Electron window.** The journeys drive the same main-process handlers through the HTTP bridge; the window, its menus and the OS dialogs need Windows. The renderer is covered by the jsdom page tests (all 25 screens mount).
- **The expiry lock over real HTTP.** `npm run e2e` uses the real clock, so it cannot jump a month; the lock and renewal are exercised in `tests/e2e-editions.test.ts` with the injected clock, which is the same code path.
- **A physical scale, printer or barcode scanner.** Barcodes are tested as strings; the printer list and silent printing degrade with plain messages (phase 9).
- **Two editions installed side by side on one PC.** Each edition is a separate install with its own data folder; there is no shared-database mode to test.

---

# Phase 11 — Package and document

## What was built

| Deliverable | Where | Notes |
| --- | --- | --- |
| Installer gate page | `resources/build/installer.nsh` | custom NSIS page in front of every other page; cannot be skipped, five attempts then exit, `/S` refused, fails closed |
| Gate verifier | `resources/build/gate.ps1` | PBKDF2 recomputation inside the installer, candidate passed by environment variable (never argv) |
| Gate minting | `scripts/make-installer-gate.ts` (`npm run installer:gate`) | reads `VENDOR_MASTER_PASSWORD`, cross-checks `vendor-secrets.json`, writes salt + digests to a git-ignored header |
| Gate consistency check | `npm run installer:gate:check` | re-derives the digest and reports whether the header on disk matches this password |
| Packaging config | `electron-builder.yml` | NSIS x64, icon, desktop + Start Menu shortcuts, per-user install, EULA, `deleteAppDataOnUninstall: false`, `npmRebuild: false`, gate include |
| Portable / copied-folder proof | `scripts/verify-portable.ts` (`npm run verify:portable`) | 10 checks |
| Plaintext scan | `scripts/verify-secrets.ts` (`npm run verify:secrets`) | now scans the installer and the unpacked build too, in UTF-8 and UTF-16LE, chunked, no size cap |
| README | `README.md` | installer, activation procedure, edition selection, renewal, user guides, troubleshooting |
| User guides | `docs/USER-GUIDE-PHARMACY.md`, `docs/USER-GUIDE-MART.md` | administrator + cashier, one per edition, no passwords anywhere |
| Figure pipeline | `scripts/capture-guide-screens.ts`, `docs/screenshots/README.md` | optional Playwright capture of the real UI |
| Operations | `docs/OPERATIONS.md` | installer password page, gate behaviour table, native-module note |
| Decisions | `docs/DECISIONS.md §52-§56` | gate design, packaging choices, activation boundary, screenshots, Windows-only build step |
| Report | `docs/FINAL-REPORT.md` | works / tested / limitations / improvements |

## Verification run

| Check | Result |
| --- | --- |
| `npm run typecheck` | ✅ clean (node + web, strict) |
| `VENDOR_MASTER_PASSWORD=… npm test` | ✅ **21 files, 197 tests passed** (6 new installer-gate tests) |
| `npm run db:verify` | ✅ **194 checks, 0 failed** (39 tables, schema v8) |
| `npm run build` | ✅ main 325.15 kB, preload 0.64 kB, renderer 1,125.29 kB + 33.69 kB CSS |
| `npm run icons` | ✅ `icon.ico` (16/32/48/64/128/256, 58,360 bytes), renderer logo + login background |
| `VENDOR_MASTER_PASSWORD=… npm run installer:gate` | ✅ header minted (614 bytes, salt + two PBKDF2 digests, no plaintext) |
| `VENDOR_MASTER_PASSWORD=… npm run installer:gate:check` | ✅ PASS with the right password, refuses a wrong one before minting |
| `VENDOR_MASTER_PASSWORD=… npm run verify:secrets` | ✅ PASS — 160 files, source + `resources/build` + (when present) `release/` |
| `VENDOR_MASTER_PASSWORD=… npm run verify:portable` | ✅ **10/10** |
| `VENDOR_MASTER_PASSWORD=… npm run e2e` | ✅ **32/32** (16 checks × 2 editions) |
| `BASE_URL=… npm run smoke` | ✅ **54/54** |
| `VENDOR_MASTER_PASSWORD=… npm run dist:win` | ❌ **blocked in this sandbox** — see below |

## Clean-profile checklist (installer → first launch)

| # | Item | Status here |
| --- | --- | --- |
| 1 | Installer blocks without the password | ⚠️ implemented and unit-checked; the `.exe` cannot be built in this sandbox |
| 2 | Five wrong attempts close the installer | ⚠️ same |
| 3 | App then asks for activation on first launch | ✅ (fresh data dir in `verify:portable`, `e2e`, smoke) |
| 4 | Edition + date-range selection works | ✅ (`e2e` × 2 editions; `tests/e2e-editions.test.ts` for expiry) |
| 5 | First-run setup asks for admin account and store name | ✅ (`e2e`, smoke, `tests/setup-auth.test.ts`) |
| 6 | Correct modules per edition | ✅ (`e2e` — the other edition's channels are refused) |
| 7 | Login page shows the logo background | ✅ (`login-bg.jpg` built into `out/renderer/assets`, CSS reference, asset present) |
| 8 | Icon in taskbar and shortcuts | ⚠️ icon file exists and is wired in `electron-builder.yml`; visible only in a real install |
| 9 | Printed receipt shows the setup-time store name | ✅ (`e2e` — receipt + credit note + reprint snapshot after a rename) |
| 10 | Master password nowhere in source, installer or unpacked build | ✅ for source and installer inputs; the packaged artifact does not exist here, so `release/` could not be scanned |

## Bugs found and fixed in this phase

| Bug | How it showed up | Fix |
| --- | --- | --- |
| `@electron/rebuild` cannot cross-build `better-sqlite3` from Linux for Windows | `dist:win` died with "node-gyp does not support cross-compiling native modules from source" | `npmRebuild: false` in `electron-builder.yml`; v13 ships Node-API prebuilds for every platform and the same file loads in Node and Electron |
| `.gitignore` ignored the installer sources | `resources/build/installer.nsh` and `gate.ps1` would have been silently left out of a commit (the minted header is the thing that must stay out) | narrowed the ignore rules; `gate.ps1`/`installer.nsh` are tracked, `resources/build/generated/` is ignored |
| `verify:secrets` skipped `release/` and could not read big files | the packaged installer and asar would never have been scanned | chunked scan, 8 MB window, UTF-8 **and** UTF-16LE (Unicode NSIS stores literals as UTF-16), `release/` included |
| Guide capture script broke the typecheck | `tsc` cannot resolve an optional `playwright` import | dynamic import by runtime-computed module name, typed locally |

## What could not be produced here

`npx electron-builder --win nsis --x64` fails in this sandbox before NSIS ever
runs, because electron-builder downloads the Electron runtime, `winCodeSign` and
NSIS from GitHub **release assets** on first use and that host is not reachable
from this environment:

```
• packaging  platform=win32 arch=x64 electron=45.1.0 appOutDir=release/win-unpacked
• downloaded label=electron progress=100%
⨯ Client network socket disconnected before secure TLS connection was established
```

(`unable to verify the first certificate` without the sandbox CA, the disconnect
above with it; `NODE_TLS_REJECT_UNAUTHORIZED=0` does not help because the socket
is dropped after TLS. No NSIS compiler is available either: `apt` cannot fetch
`nsis`, and the npm packages that ship one ship the Windows binary.)

Consequence: **no `Infoflex-Setup.exe` exists in this delivery**, and the NSIS
script has therefore never been compiled. Everything the installer needs is in
the repository and reviewed; the `.exe` must be produced with
`VENDOR_MASTER_PASSWORD=… npm run dist:win` on Windows (or Linux with wine).
`docs/FINAL-REPORT.md` says the same thing in the delivery summary.
