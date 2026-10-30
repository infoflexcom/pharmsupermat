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
`src/main/core/db.ts` and are applied inside a transaction on start-up.
WAL mode + `foreign_keys = ON` + a 5s busy timeout.

*Why:* a single file is easy to back up (VACUUM INTO), copy to a flash drive and
restore, which is what an offline Nigerian retail shop actually does.

## 3. Batches are the single stock model (both editions)

Stock always lives in `stock_batches`. The supermarket edition receives stock
into a single `DEFAULT` batch with no expiry; the pharmacy edition captures
batch number and expiry and sells first-expiry-first-out. Expired batches are
excluded from allocation and never sold.

*Why:* one stock engine, one ledger, no double accounting. The edition only
changes what is captured and shown, not how stock is decremented.

*Consequence:* supermarket users never see batch fields; pharmacy users get
FEFO for free, with expired stock refused with a clear message.

## 4. Licensing: signed payload + hashed master password + sealed vendor key

- The vendor master password is stored only as `scrypt$N$r$p$salt$hash`
  (`src/main/core/vendor-secrets.json`).
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

## 25. Known limitations for this phase

- The Windows NSIS installer must be built on Windows (or Linux with wine);
  the sandbox used for this phase has no wine, so only the config and the
  electron-vite build were validated here.
- The desktop window could not be launched in the sandbox (no display server,
  no GTK). All main-process logic, the HTTP bridge and the React tree are
  verified by tests and the harness.
- Printing requires an installed printer on the target machine; the preview and
  HTML export are always available.
