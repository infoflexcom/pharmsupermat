# Design decisions

Every decision below was made without blocking on questions. Where the brief was
silent, the choice is documented here with its consequences.

---

## 1. Money is stored and computed as integer kobo

`1 naira = 100 kobo`. Every price, discount, total, credit and report value is an
integer number of kobo in the database and in the API. Conversion happens only
at the UI/print boundary (`formatMoney`, `parseMoneyInput` in
`src/shared/money.ts`).

*Why:* floating point cents drift and money must never drift. Rounding is
explicit and only on input.

*Consequence:* any new endpoint must speak kobo. The column names carry no
suffix, so the type (`Money = number` in kobo) is documented in
`src/shared/types.ts`.

## 2. One SQLite database, append-only migrations

`PRAGMA user_version` tracks the schema; migrations live in an array in
`src/db/migrations.ts` and are applied inside a transaction on start-up.
WAL mode + `foreign_keys = ON` + a 5s busy timeout.

*Why:* a single file is easy to back up (VACUUM INTO), copy to a flash drive and
restore, which is what an offline Nigerian retail shop actually does.

## 3. Batches are the single stock model (both editions)

Stock always lives in `product_batches` (the table was `stock_batches` before
schema v2). The supermarket edition receives stock
into a single `DEFAULT` batch with no expiry; the pharmacy edition captures
batch number and expiry and sells first-expiry-first-out. Expired batches are
excluded from allocation and never sold.

*Why:* one stock engine, one ledger, no double accounting. The edition only
changes what is captured and shown, not how stock is decremented.

*Consequence:* supermarket users never see batch fields; pharmacy users get
FEFO for free, with expired stock refused with a clear message.

## 4. Licensing: signed payload + hashed master password + sealed vendor key

- The vendor master password is stored only as `scrypt$N$r$p$salt$hash`
  (`src/license/vendor-secrets.json`).
- The Ed25519 signing key is stored **sealed** with AES-256-GCM under a key
  derived from the same password (separate salt). It only exists in memory, and
  only after the password is verified.
- Licences are `IFX1.<payload>.<signature>` — the exact signed bytes are what
  gets stored, so verification never re-serialises and can never disagree with
  the issuer.
- The public key ships in the app (`vendor-public-key.ts`); the private key is
  only recoverable with the master password.

*Why:* the brief requires the master password at install/activate and renew,
"never stored in plain text", and offline operation. A symmetric secret embedded
in the binary would be extractable and would let anyone mint licences; a sealed
private key means possessing the password is the gate, which is the real
security boundary anyway.

*Accepted risk:* someone holding both the installer **and** the master password
can issue licences. That is the intended vendor capability. Offline brute force
against the scrypt hash (N=32768, r=8, p=1) is deliberately expensive.

*Reproduce key material:* `VENDOR_MASTER_PASSWORD='...' npm run vendor:keys`.

## 5. The master password gates activation, not the NSIS installer

The installer is a standard NSIS package branded "Infoflex"; the first launch
shows an activation screen that cannot be skipped and requires the vendor master
password (plus an edition/expiry, or a signed activation code). Nothing can be
sold, printed or configured before that. "Required to install/activate" is
therefore enforced at the point where an installation can actually do anything.

*Why:* an NSIS custom page would need the hash-checking logic duplicated in
installer script (another place to leak or drift), and the edition is chosen at
activation by design. A single installer for all editions avoids shipping the
wrong branded build.

## 6. Activation paths: signed code (preferred) or in-app vendor issue

- **Signed code** — vendor runs `npm run vendor:license` offline, sends the
  customer `IFX1...`. Verifiable with the embedded public key alone.
- **In-app vendor issue** — enter master password, choose edition/customer/
  expiry, the app signs locally with the unsealed key.

Both require the password; both are audited. Renewal uses the same screen and
accepts a new code or new vendor details.

## 7. Sessions live in the main process; permissions are re-derived per call

Login returns an opaque random token. The token maps to a session held in the
main process (`src/main/api/context.ts`), never in the renderer's trust. On
**every** invocation the main process re-reads the user row, the role and the
licence edition, and recomputes permissions.

*Why:* disabling a user or downgrading a supervisor takes effect immediately
rather than at next sign-in, and the renderer cannot escalate by sending a
different role. Denied calls are written to the audit log as security events.

## 8. Every channel is declared once, with its guards

`src/main/api/registry.ts` is the single table of IPC channels:
`{ channel, permission?, feature?, auth?, license? }`. The Electron IPC handler
and the browser dev harness both call the same `invoke()` function, so there is
no second path that skips the guards. Features (`pharmacy`, `supermarket`,
`wholesale`, `prescriptions`) are checked against the licence-derived flags in
the main process, e.g. `inventory.expiryWatch` returns `EDITION_RESTRICTED` on a
supermarket licence regardless of what the UI shows.

## 9. Supervisor exists only on supermarket licences; "Both" gets both

`ROLE` is stored for all editions but `permissionsForRole('SUPERVISOR', edition)`
returns `[]` unless the edition is `SUPERMARKET` or `BOTH`, and user creation
rejects the role otherwise. This follows the brief ("Supermarket edition adds
Supervisor") without adding a new role concept for pharmacies, where the
administrator approves.

## 10. Cashier return limits and the approval queue

Settings hold `returnLimit` (kobo, default ₦20,000) and `returnWindowDays`
(default 7). A cashier's return that is within both completes immediately and
gets a credit-note number. Anything larger or older is created as `PENDING`
(no stock movement, no credit-note number) and needs `returns.approve`.
Rejecting a pending return never moves stock.

## 11. Voids never delete; stock is reversed, not lost

`sales.void` sets status `VOIDED` with reason, who and when; a cashier can only
*request* a void; an approver (admin, or supermarket supervisor) applies it. The
original line items, prices, cost and store snapshot are untouched, and stock is
returned to the exact batch it came from. The receipt reprint clearly shows the
sale as voided.

## 12. Store details are snapshotted onto every document

`sales`, `returns` store `store_name`, `store_address`, `store_phone` at
creation. Receipts, invoices, credit notes and reports always print the
snapshot, never the live settings — so renaming the store never rewrites
history. A test asserts exactly this.

## 13. Printing is HTML → system print dialog

The main process renders the document HTML in a hidden, sandboxed window and
calls `webContents.print()`. The same HTML is shown in the in-app preview and
can be exported (`documents.saveHtml`) as a fallback when no printer is attached.
No cloud service, no PDF library.

## 14. Browser dev harness shares the real API layer

`harness/server.ts` serves the renderer with Vite and exposes
`POST /api/invoke`, which calls the identical `invoke()`. It exists so the app
can be reviewed in a browser, exercised by `npm run smoke`, and verified in a
headless environment where Electron has no display. It is **not** included in
the installer (`electron-builder.yml` ships only `out/`, `resources/` and
`package.json`).

## 15. No Node in the renderer

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a strict CSP
in `index.html`, and a preload that exposes exactly two functions. Navigation
away from the app is blocked in `web-contents-created`.

## 16. Login throttle and password policy

Five failed logins per username (per database) block that username for 60
seconds. Passwords need 6+ characters; administrators set a temporary password
and the user is forced to change it before anything else is allowed. The last
active administrator cannot be disabled or demoted.

## 17. Tax/VAT is out of scope for this phase

`sales.tax` exists and is always `0`; there is no VAT configuration. Adding an
inclusive/exclusive VAT mode later needs a column migration and print updates,
not a redesign. Discounts (amount, kobo) are supported now.

## 18. Product deletion is deactivation

Products are never hard-deleted (they are referenced by sale items). Deactivate
instead; inactive products are hidden from POS and marked in the catalogue.

## 19. Wholesale is available in both editions

The brief lists wholesale invoices among customer-facing documents and only ties
pharmacy/supermarket behaviour to stock and approvals. Both editions get a
Wholesale screen (wholesale price per product, invoice numbering `INV-`).

## 20. Reports are scoped by permission, not by UI

Cashiers (`reports.view.own`) get their own sales for **today** only — the main
process ignores any date range they send and filters by their user id. The audit
report additionally requires `audit.view`.

## 21. Backups: automatic daily + on shutdown, restore is deliberate

A backup is taken once per 24 hours at start-up and again on quit (only when a
licence is active). Restore validates the file (`PRAGMA integrity_check` plus a
table check), saves a `pre-restore_…` safety copy, closes and re-opens the
database and invalidates all sessions.

## 22. Icons and logos are generated from one vector master

`scripts/make-icons.ts` draws the "IF" monogram (navy/gold, tagline type) and
emits `logo-source.png`, `resources/icon.png`, `resources/resources/build/icon.png`, a multi-size
`resources/resources/build/icon.ico` and the in-app logo. Replace the SVG in that script — or drop in
official artwork as `logo-source.png` and adapt the script — then `npm run icons`.
The login screen uses the logo as a full-screen background under a soft navy
overlay, centred so it reads correctly on wide screens.

## 23. Dev sample data lives only in the harness database

`npm run smoke` leaves a demo store ("Grace Pharmacy"), products, a couple of
sales and a cashier account in `./data/` so the browser preview can be explored
immediately (`admin` / `adminpass123`). `npm run reset:data` wipes it, which is
the true first-run experience. Packaged installs always start at activation.

## 24. Repo tooling choices

- **electron-vite** for main/preload/renderer builds (one config, fast HMR).
- **vitest** for API/integration tests (real SQLite in a temp dir, real
  `invoke()`), plus two jsdom suites that mount the React app to prove the
  activation → setup → login → dashboard routing works and that every screen
  (POS, products, inventory, returns, reports, users, settings, backup, audit,
  licence) renders without throwing.
- **No ORM**: hand-written SQL with prepared statements keeps the money
  transactions explicit and the binary small.
- **Native module builds**: `postinstall` tries to rebuild better-sqlite3 for
  Electron but never fails installation; use `npm run rebuild:node` for tests or
  `npm run rebuild:electron` for the desktop app.

## 25. Known limitations after phase 1

- The Windows NSIS installer must be built on Windows (or Linux with wine);
  the sandbox used for this phase has no wine, so only the config and the
  electron-vite build were validated here.
- The desktop window could not be launched in the sandbox (no display server,
  no GTK). All main-process logic, the HTTP bridge and the React tree are
  verified by tests and the harness.
- Printing requires an installed printer on the target machine; the preview and
  HTML export are always available.

## 26. Phase 2: project structure and the database layer

**Folder structure.** The business logic moved out of `src/main/` so that the
Electron main process contains wiring only:

| Folder | Contents |
| --- | --- |
| `src/db/` | SQLite wrapper, migrations, schema manifest, typed repositories |
| `src/services/` | All business logic (products, stock, sales, returns, directory, purchases, operations, marketing, barcodes, reports, users, backup, documents, session) |
| `src/license/` | Licence verification, activation-code format, sealed vendor key material |
| `src/editions/` | Pharmacy and supermarket modules: tables they own + their IPC channels |
| `src/main/api/` | The single dispatcher (`invoke`), the guard registry and shared argument helpers |

*Why:* services are transport-agnostic — the Electron IPC bridge, the browser
harness and the verifier script all call the same functions, so no guard or
transaction can be bypassed by using a different transport.

**Table renames (schema v2).** `stock_batches → product_batches`,
`stock_moves → stock_movements`, `license → license_state`,
`products.rx_required → products.requires_prescription`. The migration does the
renames with `ALTER TABLE … RENAME` (SQLite ≥ 3.25), so an existing installation
keeps its stock, licence and sales; nothing is dropped or recreated.

**Typed repositories instead of an ORM.** `src/db/repositories/index.ts` binds
one `Table<T>` per table: `all / findById / findOne / count / insert / update /
remove`, with the writable column list declared next to the row type. Unknown
columns throw instead of being silently interpolated into SQL. Repositories
deliberately do **not** implement business rules: sales, stock moves, approvals
and audit writes live in `src/services/*` where they are wrapped in one
`IMMEDIATE` transaction.

*Why:* the ORM-free approach keeps the money/stock transaction explicit and the
packaged binary small, while the generic `Table<T>` removes the boilerplate of
20+ hand-written DAOs.

**Schema manifest + generated documentation.** `src/db/schema.ts` lists every
table with its owning edition and a one-line description.
`docs/SCHEMA.md` is generated from the migrated database (`npm run db:schema`),
so the columns in the docs are the columns SQLite created.
`npm run db:verify` writes and reads a record in every table on a throw-away
database and fails the build if a table is missing from the manifest or a
repository declares a column the schema does not have.

**Seeded `roles` table.** The three built-in roles now exist as rows (with the
permission list in `permissions` JSON) purely for reporting/future custom
roles; the enforced mapping is still `src/shared/permissions.ts`, checked in the
main process on every call.

**Edition modules are mounted at runtime.** `handlerMapFor(features)` in
`src/main/api/registry.ts` builds the live channel table from the core handlers
plus the modules the licence enables. A channel that exists but belongs to a
module you were not sold returns `EDITION_RESTRICTED` before any handler code
runs — pharmacy channels are unreachable on a supermarket licence and vice
versa. Product fields that belong to the other edition (`generic_name` vs
`plu_code`, `price_per_kg`, …) are stripped on the way in, so they cannot be
stored either.

**Payments get their own table.** A sale records what was kept on the sale
(`sales.total`), while `payments` records each tendered amount per method, so a
split sale (cash + transfer) reconciles correctly per shift and per day. Split
payments must add up to the amount tendered, enforced in `createSale`.

**Money and dates.** Everything stays integer kobo (`₦1,500.00` = `150000`), no
REAL/FLOAT column exists anywhere in the schema (asserted by a test). Timestamps
are ISO-8601 UTC, business dates are `YYYY-MM-DD`; date ranges are UTC days.

**Day closings and shifts.** One `day_closings` row per business date; closing
a day twice is a `CONFLICT` (there is no silent re-close). A cashier shift can
only be closed by the cashier who opened it, and every drawer open/no-sale/paid
in/paid out/close is a `cash_drawer_events` row plus an audit entry.

**Supermarket-only stock keeping.** The supermarket edition still uses the
single `DEFAULT` batch; `product_batches` remains the one stock engine so a
shop that buys the combined edition keeps one ledger.

## 27. Known limitations after phase 2

- The new tables are exposed through the IPC bridge and covered by tests, but
  the renderer still shows the phase-1 screens (POS, products, inventory,
  returns, reports, users, settings, backup, audit, licence). Dedicated screens
  for suppliers/purchases, day closing, promotions/price rules, loyalty, shifts
  and variants are the natural next step — the data layer and guards are in
  place behind them.
- The Windows NSIS installer still has to be built on Windows (see §25).

## 28. Phase 3 — first-run setup, accounts and the front door

**One setup screen, one transaction.** `setup.complete` writes the administrator
account and the store profile inside a single `db.transaction()` — a bad
password, a blank store name or a rejected logo rolls both halves back, so a
half-configured installation is impossible. Setup is only offered after licence
activation (`setup.status.licensed`) and only while `users` is empty; the call
returns `CONFLICT` once an administrator exists. The store-name label comes from
the licence edition (`Pharmacy name` / `Supermarket name` / `Business name`) and
is echoed to the renderer as `SetupStatus.storeNameLabel`.

**Passwords.** bcrypt (cost 10, overridable with `INFOFLEX_BCRYPT_ROUNDS`,
clamped 8–14). The rules are ≥8 characters, ≤200 bytes, at least one letter and
one digit, no leading/trailing spaces. Legacy `scrypt$…` hashes from phase 1/2
still verify and are transparently upgraded to bcrypt on the next successful
sign-in (`passwordNeedsRehash` + `password_algo` column).

**Lockout lives in the database, not in memory.** Five consecutive failures set
`locked_until = 9999-12-31…` and `locked_reason = 'failed_sign_ins'` on the
account, so restarting the app does not grant five more guesses. A locked
account is refused with `FORBIDDEN` even when the password is correct. Only an
administrator (`users.manage`) can clear it via `users.unlock`, which resets the
counter and writes a `user.unlock` audit entry. Unknown usernames return the
same `Incorrect username or password.` message as a wrong password and are
audited as `auth.login.failed` with `reason: 'unknown_username'`.

**Idle sign-out is enforced twice.** The main process stamps `lastSeen` on every
authenticated call and drops a session after `idleTimeoutMinutes` (default 15,
configurable 1–720 in Settings). The renderer runs the same timer (checking every
5 s against mouse/keyboard/touch/scroll activity) and calls `auth.logout`, so the
UI returns to the login card instead of showing a dead shell. Neither layer is
trusted on its own.

**Roles.** Admin, Supervisor (supermarket only — creating one on a pharmacy
licence is `EDITION_RESTRICTED`) and Cashier. Supervisors approve voids, refunds
and price overrides but cannot create users, set prices, add goods or change
settings. New accounts always start with `must_change_password = 1`; the main
process rejects every other channel until `auth.changePassword` succeeds. There
is no self sign-up, no public user list and no password-reset-by-email path.

**Branding on the login page.** `src/renderer/src/assets/login-bg.jpg` is the
blurred navy logo backdrop, cropped from `logo-source.png`; the renderer never
loads a file from disk at runtime, so the packaged app has no missing-asset path.
The customer's store name is shown in small type under the card only once setup
is complete, and the footer prints the app version from `app.state`.

**Store logo on documents.** The logo is stored as a `data:image/...;base64,`
URL (≤200 KB, validated on the way in *and* again in `documents.ts` before it is
embedded). `storeHeader()` renders it above the store name on receipts, invoices,
credit notes and reports. The same header is used everywhere, so a printed
document always matches the shop's own branding.

**Sidebar grouping and tone aliases.** Navigation is grouped Sales / Catalogue /
Stock / Administration, filtered by permission *and* licence feature in one place
(`availableNav`), while the main process keeps the authoritative gate. `Badge`
(`ok|warn|danger|neutral|gold`) and `Alert` (`info|success|warn|error`) keep their
own vocabularies; `ui.tsx` maps the aliases so a page can pass either spelling
and neither component silently loses its colour.

## 29. Known limitations after phase 3

- `ActivationPage`, `DashboardPage`, `PosPage`, `ProductsPage`, `InventoryPage`,
  `ReturnsPage`, `ReportsPage`, `SalesPage`, `AuditPage`, `BackupPage` and
  `LicensePage` are still the phase-1 screens; they work against the same typed
  IPC layer but have not been visually re-skinned to the phase-3 design.
- The Windows NSIS installer still has to be built on Windows (see §25).

## 30. Phase 4 — licence control, expiry and anti-tampering

**Two signing layers, one record.** The vendor tool can still issue an
Ed25519-signed activation code (`IFX1.payload.signature`, verified with a public
key compiled into the app). On top of that, every install stores its active
period in `license_state` signed with an **HMAC-SHA256** whose key is derived
(HKDF) from a random per-install secret in `license_guard` *plus* a machine
fingerprint (hostname, platform, arch, CPU model). Editing the row, copying just
the row to another PC, or deleting the secret breaks the HMAC and locks the app.

**The end date is exclusive.** A period runs from `starts_on` up to, but not
including, `ends_on`; the app locks at 00:00 on the end date. This is what makes
"an end date of today or earlier locks the app" true without a one-day grace
period, and the activation screen says so under the field. The renderer, the
guard and the tests all use `src/shared/license-dates.ts`, so no side can compute
a different day.

**States.** `NONE` (never activated), `VALID`, `EXPIRING` (≤30 days left),
`EXPIRED`, `NOT_STARTED` (restored licence whose start is in the future),
`TAMPERED` (HMAC mismatch), `CLOCK_ROLLBACK`. Only `VALID`/`EXPIRING` set
`usable: true`. The invoke guard checks `usable` **before** the edition-module
check and before sessions, so an expired or tampered install cannot reach a
business handler even with a valid token — the UI lock screen is a courtesy, not
the enforcement.

**Rate limiting is stored, not timed in memory.** `license_attempts` records the
outcome of every master-password attempt; five wrong ones start a delay ladder of
30s, 1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 24h, measured from the **last** wrong
attempt, so restarting the app does not clear it. A correct password resets the
counter. Only the outcome and the attempt number are written to the audit log —
never the typed value.

**Clock rollback.** Every guard pass stamps `last_seen_at` (throttled to once a
minute) with its own HMAC. If the current time is more than two minutes earlier
than that stamp, the row is marked `lock_reason = 'CLOCK_ROLLBACK'`, audited, and
the app locks until the vendor enters the master password (`license.unlock`).
Two minutes of tolerance leaves room for NTP corrections.

**Renewal keeps history.** `license_history` is append-only: every activation,
renewal, edition change and unlock is a row with the signed period. Renewal
refuses an end date that is not in the future and refuses to replay a period
that already ended; re-signing the *currently running* signed period is allowed
(an edition change mid-term, or repairing a tampered row), because that period
was already issued by the vendor. Renewal never touches the store profile,
users, sales or any other business table.

**Locking never destroys data.** There is no encryption-at-rest keyed on the
licence and no delete path in the guard: expiry hides the UI and refuses IPC
calls. The lock screen says so, because that is the customer's first question.

### Realistic limits of this protection

Everything below is protected against a *casual* local attacker, and nothing
here is DRM-grade:

- **HMAC, not a signature.** The key is derived inside the app, so someone who
  reverse-engineers the minified main bundle (or the ASAR archive) can recompute
  a valid HMAC for any dates. The Ed25519 activation-code path removes that
  option for the code-based flow, but the app still needs to verify with a public
  key it ships, and a patched binary can skip the check entirely.
- **The clock is the customer's.** Rollback detection catches a backwards jump,
  but a patient attacker can keep the clock frozen inside the paid period, edit
  the SQLite file's `last_seen_at` (which fails the HMAC) — or patch the guard.
  There is no online time source because the app must work offline.
- **Machine fingerprinting is a tamper signal, not a licence lock.** Restoring a
  backup onto a new PC (different hostname/CPU) breaks the HMAC and requires the
  master password, which is a deliberate trade-off: it stops copy-the-database,
  but it does mean a legitimate hardware change needs a vendor visit.
- **ASAR and minification are speed bumps.** `asar: true`, `compression: maximum`
  and an esbuild-minified main bundle hide logic and comments; they do not stop
  a determined attacker with a debugger. Real protection against determined
  piracy would need hardware binding plus an online activation authority, which
  contradicts the offline requirement.
- **What the protection *is* good for:** a shop assistant cannot extend the
  licence, the licence cannot be silently edited with DB Browser, a copied
  database does not work on another till, and every attempt is in the audit log.

## 31. Known limitations after phase 4

- The licence guard is minified but not obfuscated beyond esbuild's mangling; see
  the limits above.
- The Windows NSIS installer still has to be built on Windows (see §25).
- The smoke test seeds demo data and is not idempotent: it must run against a
  fresh `INFOFLEX_DATA_DIR`, and a second activation must use a new period.

## 32. Phase 5 — products, packs and inventory control

- **Stock is stored in one base unit; packs are a presentation layer.** A product
  keeps `pack_size` (units per pack) and `pack_unit` (carton/crate/bale). Every
  stock figure, sale line and ledger row is in base units, so the same product
  can be received as cartons and sold as singles. `packsToUnits()` and
  `unitsToPacks()` are the only conversions, and receiving with `packs` resolves
  through the product's own pack size inside the main process — the renderer
  never does the arithmetic.
- **Weighed goods use integer grams.** `sale_items.qty` is an INTEGER, and money
  is integer kobo, so a kilogram price times a weight in grams is the only way to
  keep both exact: `line_total = round(qty_g × price_per_kg / 1000)`. Receiving
  "2.5 kg" stores 2500; the POS basket stores grams; receipts print
  `1.500 kg` because `sale_items.is_weighed` travels with the sale. This avoids
  floating-point naira and the rounding drift that comes with it.
- **Prices and costs are audited field by field.** `updateProduct` diffs every
  money column (cost, retail, wholesale) and writes `product.update.price` with
  `{ costPrice: {from,to}, price: {from,to}, wholesalePrice: {from,to} }`. If no
  money moved the plain `product.update` row is written instead, so searching the
  audit log for price changes is noise-free.
- **Cost masking happens in `invoke()`, not in the renderer.** Any response to a
  session without `products.manage` (i.e. everyone but the administrator) is run
  through `redactCostsDeep`, which zeroes `costPrice`, `cost_price`, `costValue`,
  `profit` and `margin` at any depth. A custom client cannot opt out, and the
  products API still returns selling prices.
- **Excel library choice: `exceljs`.** It writes and reads `.xlsx` without native
  code (important for the offline, single-installer goal) and produces base64 we
  can hand to the renderer or write straight into `data/exports`. CSV is parsed
  by a small RFC-4180 reader of our own so a plain CSV never depends on the
  workbook library. Import is deliberately two-step: `DRY_RUN` returns
  `{validRows, created, updated, skipped, errors[], preview[]}`, and `IMPORT`
  re-runs the same validation inside a transaction. Rows are matched to existing
  products by SKU, then barcode, then exact name; unchanged rows are reported as
  skipped rather than rewritten, so a re-import does not spam the audit log.
- **Stocktake posts movements, never blind overwrites.** A count snapshots the
  system quantity per product/batch, stores what was counted, and on posting
  writes one `ADJUSTMENT` movement with `reason_type = 'COUNT'` per line. The
  variance report is the same numbers before and after posting, and a posted
  count cannot be posted twice (`CONFLICT`).
- **Purchase orders and GRNs share the purchases table.** `status = DRAFT` means
  an order that has not touched stock; receiving it posts stock, writes
  `grn_no`/`received_at` and flips the row to `RECEIVED` in one transaction.
  Ordering needs `prices.set` (it fixes the buying price) while receiving only
  needs `stock.receive`, so a supervisor can receive goods without seeing costs.
- **Price labels are HTML + inline SVG.** `code128Svg()` builds Code 128-B
  rectangles with no external fonts or images, and `buildPriceLabels()` renders
  an A4 sheet (3 × label grid, copies per product) that prints through the same
  `print.document` path as receipts. Nothing leaves the machine.
- **Edition gating stays in the main process.** `stocktake.*`, `labels.print` and
  `purchases.*Order` carry `feature: 'supermarket'`; a pharmacy licence gets
  `EDITION_RESTRICTED` even if the renderer calls them directly. Stocktake and
  adjustments both require `stock.adjust`, which only the administrator holds.
- **Alerts follow the edition, not a hard-coded window.** `stock.alerts` reads
  `settings.expiry_alert_days` (seeded at 90) and, on a supermarket licence, only
  considers products that opted into `expiry_tracking`. Expired batches are
  returned separately so the UI can shout about them and still keep the normal
  near-expiry list clean.
- **Sub-categories reuse the categories table.** `categories.parent_id` gives a
  department → sub-category tree without a second table; products already carry
  `category_id`, so a product can sit anywhere in that tree while the free-text
  `category` column stays available for quick entry.

## 33. Known limitations after phase 5

- Excel import reads the first sheet only, and images/formulas in the sheet are
  flattened to their displayed value.
- A stocktake covers the whole active catalogue (one row per product/batch);
  counting a subset of the shop is not yet supported.
- Weighed items are sold from a single batch pool — the FEFO batch split still
  works, but a scale integration (serial/USB) is out of scope, so the weight is
  typed or chosen from presets.
- Price labels print on A4 sheets; dedicated label-printer templates (50 × 30 mm
  rolls) would need a per-printer page size in Settings.
- Import matching by exact name can merge two products that share a name across
  different SKUs if the sheet leaves SKU and barcode blank — the dry run preview
  shows this before anything is written.
