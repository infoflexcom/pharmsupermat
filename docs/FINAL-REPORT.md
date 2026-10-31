# Infoflex Pharm / Infoflex Mart — final delivery report

**Version 1.0.0** · branch `arena/9283fca5-pharmsupermat` · 31 October 2026

One offline Windows till for pharmacies and supermarkets. The edition
(PHARMACY, SUPERMARKET or BOTH) is chosen by a signed licence at activation, so
a single installer serves all three shops.

---

## 1. What works

### The till

- **Point of sale** — search, barcode scan, weighed items via PLU or scale
  barcode, cart quantities, discounts, four payment methods, change due, held
  sales, instant receipt. **F2** search · **F9** pay · **F10** print.
- **Money** — integer kobo internally, `₦1,234.56` everywhere it is shown or
  printed. Wholesale prices apply only to wholesale customers at or above the
  wholesale minimum; a receipt is always a retail document.
- **Stock** — receiving by pack, unit or weight, FEFO batch selling, expired
  stock never sold, adjustments with a mandatory reason (administrator only),
  a movement ledger for every item, purchase orders and goods-received notes,
  stocktake with a variance report.
- **Sales records** — nothing is ever deleted. Voids reverse stock and money
  with an approval trail; returns produce credit notes with an optional
  restocking step and a cashier limit + window that a supervisor can override.
- **Documents** — receipt, invoice, credit note and every report carry the shop's
  own name and address **as captured at the time**. A reprint after a rename
  still shows the old name; the "Powered by Infoflex" line can be switched off
  by the administrator and never replaces the shop's name. Printing is blocked,
  with a pointer to Settings, when the store name is missing.
- **Reports** — daily summary, monthly, stock valuation, expiry, department,
  promotion, cashier breakdown, audit trail; printable and exportable.
- **Editions** — feature flags are enforced in the **main process**: a channel
  for a module the licence does not enable is not mounted, and the sidebar only
  offers what is mounted. The window title, login screen and installer text all
  name the active edition.
- **Roles** — Administrator, Supervisor, Cashier. Only the administrator adds
  users, sets prices, adds goods, adjusts stock, or sees cost prices and gross
  profit. Discounts for other roles are capped by an administrator-set maximum.
  Permissions are checked on direct IPC calls, not just hidden in the UI.
- **Licensing** — Ed25519-signed codes verified offline, edition + validity
  period, renewal without data loss, expiry that locks trading but not data,
  tamper and clock-rollback detection, throttled master-password attempts.
- **Backups** — automatic daily backup into `%APPDATA%\Infoflex\backups\`,
  "Backup now", typed-confirmation restore, and uninstalling never touches data.
- **Offline by construction** — no network call anywhere in the app, no
  telemetry, no update check.

### Packaging and documentation

- One electron-builder NSIS configuration for all editions: brand icon, desktop
  and Start Menu shortcuts, uninstaller, per-user install, EULA page.
- **Installer password gate** — a "Vendor authorisation" page before every other
  page. The password is verified by recomputing a **PBKDF2 digest** (150,000
  iterations, random 16-byte salt, SHA-256 with a SHA-1 fallback for old .NET
  runtimes). No plaintext is in the NSIS script, the PowerShell verifier or the
  compiled installer. Five wrong attempts close the installer, `/S` silent
  installs are refused, and a broken verifier fails **closed**.
- **Activation is the real boundary** — a copied folder, an extracted installer
  or a restored backup still lands on the activation screen.
- `README.md`, `docs/OPERATIONS.md`, two user guides (pharmacy and supermarket,
  administrator + cashier, no passwords), `docs/SCHEMA.md` (39 tables, schema v8),
  `docs/DECISIONS.md` (§1–§56) and `docs/CHECKLIST.md` (phase by phase, with
  pass/fail tables).

---

## 2. What was tested

Everything below was run in this environment; the numbers are from the last run.

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean, strict, node + web |
| `VENDOR_MASTER_PASSWORD=… npm test` | **21 files, 197 tests passed** |
| `npm run db:verify` | **194 checks, 0 failed** — every table written and read back |
| `npm run e2e` | **32/32** — 16 journeys × 2 editions, fresh database each time |
| `npm run smoke` | **54/54** against a running instance |
| `npm run verify:portable` | **10/10** (copied folder, moved folder, wiped data) |
| `npm run verify:secrets` | PASS — 160 files, installer inputs included, UTF-8 and UTF-16LE |
| `npm run installer:gate` / `:check` | minted, and re-derived correctly; a wrong password is refused before minting |
| `npm run build` | main 325.15 kB, preload 0.64 kB, renderer 1,125.29 kB + 33.69 kB CSS |
| `npm run icons` | multi-size `.ico` (16–256) plus renderer logo and login background |

The unit and E2E suites cover: activation per edition, first-run setup (including
refusals), Admin/Supervisor/Cashier permissions, temporary passwords and lockout,
a sale to a printed receipt showing the store name, duplicate reprints, returns
with credit notes, voids, stock adjustment rules, weighed goods, wholesale
pricing, promotions, loyalty, reports, backups and typed restores, licence
expiry → lock → renewal, clock rollback, and the edition gate on IPC channels.

---

## 3. Known limitations

1. **The Windows installer was not built here.** `electron-builder` downloads the
   Electron runtime, `winCodeSign` and NSIS from GitHub release assets, and that
   host is unreachable from this sandbox (TLS socket dropped after
   `unable to verify the first certificate`); there is no NSIS compiler either.
   So `release/` is empty, the NSIS script has never been compiled, and the
   installer gate has been reviewed and unit-tested but not executed. Build it
   with `VENDOR_MASTER_PASSWORD=… npm run dist:win` on Windows (or Linux + wine).
   The same reason means the taskbar icon, the shortcuts and the per-user install
   path are configured but unseen.
2. **No real Electron window was driven.** Journeys run through the same
   `invoke()` entry point the IPC layer uses, and all 25 screens mount in jsdom,
   but window chrome, native menus and OS print dialogs need Windows.
3. **Guide screenshots were not captured here.** No display and no browser could
   be installed in this environment (the bundled Chromium needs a newer NSS than
   any obtainable one). `npm run shots:guide` renders them from the real UI in a
   few minutes on any machine with a browser; every figure in the guides carries
   a caption describing the screen meanwhile.
4. **Hardware is emulated.** Barcodes are strings, the scale barcode is parsed
   but no scale is read, printing goes through Electron's offscreen window and
   degrades to plain messages without a printer.
5. **The installer gate is a speed bump, not a lock.** Anyone holding the
   installer can extract the application files and will still be blocked by
   activation, but the gate's own digest is on their disk and is offline-guessable
   at the cost of 150,000 PBKDF2 iterations per guess.
6. **Single machine, single database.** No multi-till sync, no cloud backup. The
   licence integrity is bound to the machine fingerprint, so moving a data folder
   to another PC needs a re-activation by the vendor (by design).
7. **Windows PowerShell is required** by the installer gate. It is present on
   every supported Windows; if a policy blocks it, the installer refuses to run.

---

## 4. Suggested improvements

- **Build the installer on a Windows runner** (or a Linux box with wine) and add
  the gate's behaviour to the checklist: right password, wrong password ×5,
  Cancel, `/S`. Everything else in the release checklist is already automated.
- **Code-sign the installer and the executable.** Unsigned, an NSIS installer
  looks like unknown software to SmartScreen; signing is the single biggest
  improvement to the customer's first five minutes.
- **Capture the guide figures in CI** with `npm run shots:guide` on a runner that
  has Chromium, so the images never drift from the UI.
- **Batch-expiry alerts on startup** for the pharmacy edition (the data is
  already there; a dashboard banner would be enough).
- **Split the renderer bundle** (1.1 MB) with route-level code splitting — it is
  a local app so the cost is only first-launch time.
- **A "second till" mode**: a documented export/import of the day's sales for
  shops that eventually run two counters, plus a real synchronisation story if
  more than two ever need to share stock.
- **Fiscal receipt numbering** for shops that need to show receipts to a tax
  authority — the counters are already sequential and gapless per year.
- **Replace the PowerShell verifier with a compiled helper** (Go/Rust, ~2 MB) if
  the installer ever has to run where PowerShell is locked down; the hash and
  the comparison logic stay exactly the same.

---

## 5. Where things are

| What | Where |
| --- | --- |
| Installer configuration | `electron-builder.yml` |
| Installer gate | `resources/build/installer.nsh`, `resources/build/gate.ps1`, `scripts/make-installer-gate.ts` |
| Vendor keys and licence issuing | `scripts/gen-vendor-secrets.ts`, `scripts/make-license.ts` |
| Verification scripts | `scripts/{e2e,smoke,verify-db,verify-secrets,verify-portable}.ts` |
| Documentation | `README.md`, `docs/OPERATIONS.md`, `docs/DECISIONS.md`, `docs/CHECKLIST.md`, `docs/SCHEMA.md`, `docs/EULA.txt` |
| User guides | `docs/USER-GUIDE-PHARMACY.md`, `docs/USER-GUIDE-MART.md` |
| Data | `%APPDATA%\Infoflex\data\infoflex.db`, backups next to it |
