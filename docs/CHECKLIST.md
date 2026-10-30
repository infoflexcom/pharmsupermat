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
