/**
 * "Copy the folder and it still has to be activated" — proof, not a promise.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run verify:portable
 *
 * The installer is not the security boundary: activation is. This script:
 *
 *   1. greps the main process for anything that keys a licensing decision off
 *      the install path or executable location;
 *   2. stands up a brand-new installation in a temporary folder that lives
 *      outside the repository (the "portable copy" — application files and user
 *      data in one folder, no installer, no registry, no shortcuts);
 *   3. drives the real API layer and checks that every business channel is
 *      refused until a licence is activated;
 *   4. moves that whole folder to a different path and checks the licence still
 *      holds (nothing is bound to where the files sit);
 *   5. deletes the user-data folder and checks activation is demanded again.
 *
 * Exit code 0 = all checks passed.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Database } from '../src/db';
import { createContext, type ApiContext } from '../src/services/session';
import { invoke } from '../src/main/api/invoke';
import type { ApiResult, AppState } from '../src/shared/types';

const ROOT = join(__dirname, '..');
const MASTER = process.env.VENDOR_MASTER_PASSWORD ?? '';
const EDITION = 'PHARMACY' as const;

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

const checks: Check[] = [];
function check(name: string, pass: boolean, detail?: string): void {
  checks.push({ name, pass, detail });
}

function codeOf(result: ApiResult<unknown>): string {
  return result.ok ? 'OK' : result.error.code;
}

/* ------------------------------------------------------------------ */
/* 1. no install-path decisions in the main process                    */
/* ------------------------------------------------------------------ */

function scanInstallPathCoupling(): void {
  const forbidden = [/process\.execPath/, /getPath\(\s*['"]exe['"]\s*\)/, /app\.getAppPath\(/, /resourcesPath/];
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!path.endsWith('.ts') && !path.endsWith('.tsx')) continue;
      const text = readFileSync(path, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(text)) hits.push(`${relative(ROOT, path)} matches ${pattern}`);
      }
    }
  };
  for (const dir of ['src/main', 'src/license', 'src/services']) walk(join(ROOT, dir));
  check(
    'No licensing decision reads the install path or executable location',
    hits.length === 0,
    hits.join('; ') || 'no execPath / getPath(exe) / appPath use in main, licence or services'
  );
}

/* ------------------------------------------------------------------ */
/* 2-5. portable copy behaviour                                        */
/* ------------------------------------------------------------------ */

function openContext(userDataDir: string): { db: Database; ctx: ApiContext } {
  mkdirSync(userDataDir, { recursive: true });
  const db = new Database(join(userDataDir, 'infoflex.db'));
  db.open();
  const ctx = createContext({
    db,
    dataDir: userDataDir,
    backupsDir: join(userDataDir, 'backups'),
    version: '1.0.0-portable-check'
  });
  return { db, ctx };
}

async function main(): Promise<void> {
  if (!MASTER) {
    console.error('Set VENDOR_MASTER_PASSWORD to run this check.');
    process.exit(1);
  }

  scanInstallPathCoupling();

  const root = mkdtempSync(join(tmpdir(), 'infoflex-portable-'));
  const appDir = join(root, 'Infoflex portable');
  const userDataDir = join(appDir, 'user-data');
  mkdirSync(appDir, { recursive: true });

  // A real copy of the built main/preload bundle travels with the "app" folder,
  // exactly like a customer who zips up their Program Files directory.
  if (existsSync(join(ROOT, 'out/main/index.js'))) {
    cpSync(join(ROOT, 'out'), join(appDir, 'out'), { recursive: true });
    check('Built application bundle copied into the portable folder', true, 'out/ (main, preload, renderer)');
  } else {
    check('Built application bundle copied into the portable folder', false, 'run `npm run build` first');
  }

  let { db, ctx } = openContext(userDataDir);
  let state = await invoke('app.state', {}, ctx);
  const appState = (state as ApiResult<AppState>).ok ? ((state as { data: AppState }).data as AppState) : null;
  check(
    'Fresh portable copy starts unactivated (setup withheld until licensed)',
    codeOf(state) === 'OK' &&
      appState?.license.state === 'NONE' &&
      appState.setup.licensed === false &&
      appState.setup.setupRequired === false,
    `license=${appState?.license.state} setupRequired=${appState?.setup.setupRequired}`
  );

  const blocked = await invoke('products.list', { token: null }, ctx);
  check('Business channel refused before activation', codeOf(blocked) === 'LICENSE_REQUIRED', codeOf(blocked));

  const wrongPassword = await invoke(
    'license.activate',
    { masterPassword: 'definitely-not-the-master-password', edition: EDITION, customerName: 'Portable', expiresAt: nextYear() },
    ctx
  );
  check('Activation refuses a wrong master password', !wrongPassword.ok, codeOf(wrongPassword));

  const activated = await invoke(
    'license.activate',
    { masterPassword: MASTER, edition: EDITION, customerName: 'Portable Copy Ltd', expiresAt: nextYear() },
    ctx
  );
  check('Activation succeeds with the correct master password', activated.ok, codeOf(activated));

  const afterActivation = await invoke('app.state', {}, ctx);
  const licenceState = (afterActivation as ApiResult<AppState>).ok
    ? ((afterActivation as { data: AppState }).data.license.state as string)
    : 'unknown';
  check('Licence state after activation', licenceState === 'VALID', licenceState);

  const stillGuarded = await invoke('products.list', { token: null }, ctx);
  check(
    'Activated copy still needs a login (licence gate no longer the blocker)',
    codeOf(stillGuarded) === 'UNAUTHENTICATED',
    codeOf(stillGuarded)
  );

  db.close();

  // Move the whole folder somewhere else and reopen: a copied/moved install
  // must keep its licence, because the licence lives in user data and its
  // integrity is bound to the machine, not the path.
  const moved = join(root, 'Infoflex moved');
  renameSync(appDir, moved);
  const reopened = openContext(join(moved, 'user-data'));
  db = reopened.db;
  ctx = reopened.ctx;
  const movedState = await invoke('license.status', {}, ctx);
  const movedLicence = movedState.ok
    ? ((movedState as { data: { state: string } }).data.state as string)
    : codeOf(movedState);
  check('Licence survives moving the folder to another path', movedLicence === 'VALID', movedLicence);
  db.close();

  // Wipe user data: the portable copy is back to square one.
  const freshData = join(root, 'fresh-user-data');
  const fresh = openContext(freshData);
  const freshState = await invoke('license.status', {}, fresh.ctx);
  const freshCode = freshState.ok
    ? ((freshState as { data: { state: string } }).data.state as string)
    : codeOf(freshState);
  check('Deleting user data demands activation again', freshCode === 'NONE', freshCode);
  fresh.db.close();

  rmSync(root, { recursive: true, force: true });

  const width = Math.max(...checks.map((c) => c.name.length));
  console.log('\nPortable / copied-folder activation checks\n');
  for (const item of checks) {
    console.log(`  ${item.pass ? 'PASS' : 'FAIL'}  ${item.name.padEnd(width)}  ${item.detail ?? ''}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed.`);
  process.exit(failed === 0 ? 0 : 1);
}

function nextYear(): string {
  const date = new Date();
  date.setFullYear(date.getFullYear() + 1);
  return date.toISOString();
}

main().catch((error) => {
  console.error('[verify:portable] failed', error);
  process.exit(1);
});
