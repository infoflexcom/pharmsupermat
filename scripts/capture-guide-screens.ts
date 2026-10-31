/**
 * Guide screenshots.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   VENDOR_MASTER_PASSWORD='...' npm run shots:guide
 *
 * Renders the real UI in a real browser (the browser harness serves exactly the
 * same renderer and main-process API as the Electron window), signs in as the
 * administrator and writes one PNG per screen into docs/screenshots/.
 *
 * The guides reference these file names, so a figure appears as soon as the
 * script has been run on a machine with a browser. It is optional tooling: the
 * packaged app never uses it, and `npm test` does not need it.
 *
 * Two data sets are produced when both editions are available:
 *   pharmacy-*.png   (edition PHARMACY)
 *   mart-*.png       (edition SUPERMARKET)
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'docs/screenshots');
const BASE = process.env.INFOFLEX_HARNESS ?? 'http://127.0.0.1:4173';
const ADMIN_PASSWORD = process.env.INFOFLEX_ADMIN_PASSWORD ?? 'Demo1234';
const ADMIN_USER = process.env.INFOFLEX_ADMIN_USER ?? 'admin';

const SHOTS: Array<{ file: string; nav?: string; wait?: number }> = [
  { file: '00-login', wait: 1200 },
  { file: '01-dashboard', nav: 'Dashboard', wait: 1200 },
  { file: '02-pos', nav: 'Point of Sale', wait: 1200 },
  { file: '03-products', nav: 'Products', wait: 1200 },
  { file: '04-inventory', nav: 'Inventory', wait: 1200 },
  { file: '05-stock', nav: 'Stock & Purchases', wait: 1200 },
  { file: '06-reports', nav: 'Reports', wait: 1500 },
  { file: '07-users', nav: 'Users', wait: 1000 },
  { file: '08-settings', nav: 'Settings', wait: 1200 },
  { file: '09-backup', nav: 'Backup & Restore', wait: 1000 }
];

const EDITION_SHOTS: Array<{ file: string; nav: string }> = [
  { file: '10-batches', nav: 'Batches & Expiry' },
  { file: '10-stocktake', nav: 'Stocktake' },
  { file: '10-departments', nav: 'Departments' }
];

/* Playwright is optional tooling, never a dependency: the module name is built
   at runtime so neither the type checker nor a bundled build needs it. */
type Chromium = { launch: (options?: Record<string, unknown>) => Promise<any> };

async function loadPlaywright(): Promise<Chromium | null> {
  const name = ['play', 'wright'].join('');
  try {
    const module = (await import(/* @vite-ignore */ name)) as { chromium: Chromium };
    return module.chromium;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const chromium = await loadPlaywright();
  if (!chromium) {
    console.error(
      'Playwright is not installed. Run:\n' +
        '  npm i -D playwright && npx playwright install chromium\n' +
        'then start the UI with `npm run dev:web` and run this script again.'
    );
    process.exit(1);
  }

  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, '00-login.png'), fullPage: true });

  const edition = process.env.INFOFLEX_EDITION === 'SUPERMARKET' ? 'mart' : 'pharmacy';

  // Sign in.
  const user = page.getByLabel(/user|username|e-?mail/i).first();
  const pass = page.getByLabel(/password/i).first();
  await user.fill(ADMIN_USER);
  await pass.fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: /sign in|log in|login/i }).first().click();
  await page.waitForTimeout(2000);

  const write = async (file: string) => page.screenshot({ path: join(OUT, file), fullPage: true });

  for (const shot of SHOTS.slice(1)) {
    if (!shot.nav) continue;
    const button = page.getByRole('button', { name: shot.nav, exact: true }).first();
    if ((await button.count()) === 0) continue;
    await button.click();
    await page.waitForTimeout(shot.wait ?? 1000);
    await write(`${edition}-${shot.file}.png`);
  }

  for (const shot of EDITION_SHOTS) {
    const button = page.getByRole('button', { name: shot.nav, exact: true }).first();
    if ((await button.count()) === 0) continue;
    await button.click();
    await page.waitForTimeout(1200);
    await write(`${edition}-${shot.file}.png`);
  }

  await browser.close();
  console.log(`Screenshots written to ${OUT}`);
  console.log('Rename/re-run with INFOFLEX_EDITION=SUPERMARKET to capture the mart set.');
}

main().catch((error) => {
  console.error('[shots:guide] failed', error);
  process.exit(1);
});
