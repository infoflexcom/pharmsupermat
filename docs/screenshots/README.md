# Guide figures

The user guides name one figure per screen. The images are produced from the
**real** application UI — not mock-ups — by rendering the browser harness, which
serves exactly the same React renderer and the same main-process API as the
Electron window.

```bash
npm i -D playwright && npx playwright install chromium
npm run dev:web                       # in one terminal: http://127.0.0.1:4173
VENDOR_MASTER_PASSWORD='...' INFOFLEX_EDITION=PHARMACY   npm run shots:guide
VENDOR_MASTER_PASSWORD='...' INFOFLEX_EDITION=SUPERMARKET npm run shots:guide
```

| File | Screen | Appears in |
| --- | --- | --- |
| `pharmacy-00-login.png` / `mart-00-login.png` | login page over the logo background, store name above the fields | both guides, §1 |
| `<edition>-01-dashboard.png` | dashboard: today's takings, low stock, licence status | both, §2 |
| `<edition>-02-pos.png` | point of sale with a cart, discount box and the pay button | both, §3 |
| `<edition>-03-products.png` | product list (cost prices visible to an administrator only) | both, §4 |
| `<edition>-04-inventory.png` | live stock with the movement ledger | both, §5 |
| `<edition>-05-stock.png` | stock receiving and adjustment forms | both, §5 |
| `<edition>-06-reports.png` | daily and monthly report with the store name in the header | both, §6 |
| `<edition>-07-users.png` | user list, roles and password resets | both, §7 |
| `<edition>-08-settings.png` | store name, receipt footer, "Powered by" switch | both, §8 |
| `<edition>-09-backup.png` | backup and typed-confirmation restore | both, §9 |
| `pharmacy-10-batches.png` | batches and expiry (pharmacy only) | pharmacy §5 |
| `mart-10-stocktake.png` | stocktake with the variance report (mart only) | mart §5 |
| `mart-10-departments.png` | departments and shelf locations (mart only) | mart §4 |

Until the script has been run, each figure's caption in the guide describes what
is on screen, so the guides can be followed without the images. Nothing in the
guides depends on the images being present, and no guide — image or text —
contains the master password.
