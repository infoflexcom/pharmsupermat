/**
 * End-to-end run against fresh installations, one per edition.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run e2e
 *
 * It starts the real harness server twice (its own data directory and port for
 * each edition), drives the same HTTP bridge the UI uses, and prints a
 * pass/fail table per edition. The licence clock is real here, so the
 * expiry-lock journey lives in tests/e2e-editions.test.ts, which can travel in
 * time.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = process.env.VENDOR_MASTER_PASSWORD ?? '';
type Edition = 'PHARMACY' | 'SUPERMARKET';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

class Client {
  private token: string | null = null;
  constructor(private readonly base: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  async call<T>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await fetch(`${this.base}/api/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, payload: { ...payload, token: this.token } })
    });
    const body = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string; message: string } };
    if (!body.ok) throw new Error(`[${body.error.code}] ${body.error.message}`);
    return body.data;
  }

  async expectError(channel: string, payload: Record<string, unknown>, code: string): Promise<void> {
    try {
      await this.call(channel, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes(`[${code}]`)) throw new Error(`expected ${code}, got ${message}`);
      return;
    }
    throw new Error(`expected ${code}, the call succeeded`);
  }
}

async function waitForServer(base: string, deadline = Date.now() + 60_000): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${base} did not start`);
}

async function runEdition(edition: Edition, port: number): Promise<{ checks: Check[]; child: ChildProcess; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), `infoflex-e2e-${edition.toLowerCase()}-`));
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'harness/server.ts'], {
    env: { ...process.env, PORT: String(port), INFOFLEX_DATA_DIR: dir },
    stdio: 'ignore',
    // Its own process group, so the whole tree (npx → tsx → node) can be
    // stopped at the end. A survivor would keep the port and its old database.
    detached: true
  });
  const base = `http://localhost:${port}`;
  await waitForServer(base);

  const api = new Client(base);
  const checks: Check[] = [];
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      checks.push({ name, pass: true });
    } catch (error) {
      checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const storeName = edition === 'SUPERMARKET' ? 'Sunmart Lekki' : 'Grace Pharmacy Ikeja';

  await check('activates the licence for this edition', async () => {
    const status = await api.call<{ edition: string; state: string; usable: boolean }>('license.activate', {
      masterPassword: MASTER,
      edition,
      customerName: 'Infoflex E2E Customer',
      expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString()
    });
    if (status.edition !== edition) throw new Error(`edition ${status.edition}`);
    if (!status.usable) throw new Error(`state ${status.state}`);
  });

  await check('shows the edition’s product name and modules', async () => {
    const state = await api.call<{ features: { productName: string; pharmacy: boolean; supermarket: boolean } }>(
      'app.state'
    );
    const expected = edition === 'SUPERMARKET' ? 'Infoflex Mart' : 'Infoflex Pharm';
    if (state.features.productName !== expected) throw new Error(`product name ${state.features.productName}`);
    if (state.features.pharmacy !== (edition === 'PHARMACY')) throw new Error('pharmacy flag');
    if (state.features.supermarket !== (edition === 'SUPERMARKET')) throw new Error('supermarket flag');
  });

  await check('refuses a nameless first-run setup', async () => {
    await api.expectError(
      'setup.complete',
      {
        storeName: '   ',
        storeAddress: '12 Allen Avenue',
        storePhone: '0803 000 0000',
        adminUsername: 'admin',
        adminFullName: 'Ada Admin',
        adminPassword: 'adminpass123'
      },
      'VALIDATION'
    );
  });

  await check('completes setup with the store name', async () => {
    const setup = await api.call<{ setupRequired: boolean }>('setup.complete', {
      storeName,
      storeAddress: '12 Allen Avenue, Ikeja, Lagos',
      storePhone: '0803 000 0000',
      adminUsername: 'admin',
      adminFullName: 'Ada Admin',
      adminPassword: 'adminpass123'
    });
    if (setup.setupRequired) throw new Error('setup still required');
  });

  await check('signs in the administrator and lists the roles', async () => {
    const session = await api.call<{ token: string; role: string; mustChangePassword: boolean }>('auth.login', {
      username: 'admin',
      password: 'adminpass123'
    });
    api.setToken(session.token);
    if (session.role !== 'ADMIN') throw new Error(`role ${session.role}`);
    if (session.mustChangePassword) throw new Error('admin forced to change password');
  });

  await check('creates a cashier and forces a password change', async () => {
    await api.call('users.create', {
      username: 'cashier1',
      fullName: 'Grace Cashier',
      role: 'CASHIER',
      password: 'cashierpass1'
    });
    const first = await api.call<{ token: string; mustChangePassword: boolean }>('auth.login', {
      username: 'cashier1',
      password: 'cashierpass1'
    });
    if (!first.mustChangePassword) throw new Error('temp password was not flagged');
    // The change is made as the cashier, not as the administrator.
    api.setToken(first.token);
    await api.call('auth.changePassword', { newPassword: 'cashierpass2' });
    const again = await api.call<{ token: string; mustChangePassword: boolean }>('auth.login', {
      username: 'cashier1',
      password: 'cashierpass2'
    });
    if (again.mustChangePassword) throw new Error('password change did not stick');
    const admin = await api.call<{ token: string }>('auth.login', { username: 'admin', password: 'adminpass123' });
    api.setToken(admin.token);
  });

  await check('refuses a bad password', async () => {
    await api.expectError('auth.login', { username: 'admin', password: 'wrong-password' }, 'UNAUTHENTICATED');
  });

  const productName = edition === 'SUPERMARKET' ? 'Golden Penny Semovita 1kg' : 'Paracetamol 500mg (100)';
  await check('adds a product', async () => {
    await api.call('products.create', {
      name: productName,
      category: edition === 'SUPERMARKET' ? 'Flour & Grains' : 'Analgesics',
      unit: edition === 'SUPERMARKET' ? 'bag' : 'pack',
      costPrice: 95_000,
      price: 135_000,
      reorderLevel: 5,
      openingStock: 40,
      openingBatchNo: 'E2E-1',
      openingExpiry: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10)
    });
  });

  let receiptNo = '';
  await check('sells two units', async () => {
    const sale = await api.call<{ receiptNo: string; total: number; storeName: string; id: number }>('sales.create', {
      docType: 'RECEIPT',
      lines: [{ productId: 1, qty: 2 }],
      paymentMethod: 'CASH',
      amountPaid: 500_000
    });
    receiptNo = sale.receiptNo;
    if (sale.total !== 270_000) throw new Error(`total ${sale.total}`);
    if (sale.storeName !== storeName) throw new Error(`snapshot name ${sale.storeName}`);
  });

  await check('prints a receipt with the store name', async () => {
    const sales = await api.call<{ id: number; receiptNo: string }[]>('sales.list', {});
    const sale = sales.find((row) => row.receiptNo === receiptNo)!;
    const doc = await api.call<{ html: string }>('sales.document', { id: sale.id });
    if (!doc.html.includes(storeName)) throw new Error('store name missing from the receipt');
    if (!doc.html.includes('12 Allen Avenue')) throw new Error('store address missing');
    if (!doc.html.includes(receiptNo)) throw new Error('receipt number missing');
  });

  await check('marks a reprint as DUPLICATE', async () => {
    const sales = await api.call<{ id: number; receiptNo: string }[]>('sales.list', {});
    const sale = sales.find((row) => row.receiptNo === receiptNo)!;
    await api.call('pos.print', { id: sale.id });
    const second = await api.call<{ duplicate: boolean; html: string }>('pos.print', { id: sale.id });
    if (!second.duplicate) throw new Error('second print was not a duplicate');
    if (!second.html.includes(storeName)) throw new Error('reprint lost the store name');
  });

  await check('returns one unit with a credit note', async () => {
    const sales = await api.call<{ id: number; receiptNo: string; items: { id: number }[] }[]>('sales.list', {});
    const sale = sales.find((row) => row.receiptNo === receiptNo)!;
    const detail = await api.call<{ items: { id: number }[] }>('sales.get', { id: sale.id });
    const ret = await api.call<{ value: { id: number; creditNoteNo: string; total: number } }>('returns.create', {
      saleId: sale.id,
      lines: [{ saleItemId: detail.items[0].id, qty: 1 }],
      reason: 'Customer changed mind'
    });
    if (ret.value.total !== 135_000) throw new Error(`refund ${ret.value.total}`);
    const note = await api.call<{ html: string }>('returns.document', { id: ret.value.id });
    if (!note.html.includes(storeName)) throw new Error('credit note lost the store name');
    if (!note.html.includes(ret.value.creditNoteNo)) throw new Error('credit note number missing');
  });

  await check('reports the day’s takings', async () => {
    const report = await api.call<{ html: string; totals: { gross: number; returns: number } }>('reports.build', {
      kind: 'DAILY_SUMMARY',
      from: new Date().toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10)
    });
    if (report.totals.gross !== 270_000) throw new Error(`gross ${report.totals.gross}`);
    if (report.totals.returns !== 135_000) throw new Error(`returns ${report.totals.returns}`);
    if (!report.html.includes(storeName)) throw new Error('report lost the store name');
  });

  await check('keeps the other edition’s module switched off', async () => {
    if (edition === 'SUPERMARKET') await api.expectError('pharmacy.expiryWatch', {}, 'EDITION_RESTRICTED');
    else await api.expectError('mart.departments.list', {}, 'EDITION_RESTRICTED');
  });

  await check('loads and removes its demo catalogue', async () => {
    const loaded = await api.call<{ products: number; loaded: boolean }>('demo.load', {});
    const expected = edition === 'SUPERMARKET' ? 60 : 30;
    if (loaded.products !== expected) throw new Error(`${loaded.products} demo products`);
    const removed = await api.call<{ removed: number; kept: string[] }>('demo.remove', {});
    if (removed.removed < expected) throw new Error(`only ${removed.removed} removed`);
    if (removed.kept.length > 0) throw new Error(`kept ${removed.kept.join(', ')}`);
  });

  await check('renames the shop and keeps the old receipt’s name', async () => {
    await api.call('settings.update', { storeName: `${storeName} (renamed)` });
    const sales = await api.call<{ id: number; receiptNo: string }[]>('sales.list', {});
    const sale = sales.find((row) => row.receiptNo === receiptNo)!;
    const doc = await api.call<{ html: string }>('sales.document', { id: sale.id });
    if (!doc.html.includes(storeName)) throw new Error('old receipt changed after the rename');
    if (doc.html.includes('(renamed)')) throw new Error('old receipt picked up the new name');
    const preview = await api.call<{ html: string }>('settings.preview', { draft: {} });
    if (!preview.html.includes('(renamed)')) throw new Error('preview did not follow the new name');
  });

  return { checks, child, dir };
}

function printTable(results: Record<Edition, Check[]>): void {
  const names = results.PHARMACY.map((check) => check.name);
  const width = Math.max(...names.map((name) => name.length), 12) + 2;
  console.log('\nEnd-to-end by edition\n');
  console.log(`  ${'Check'.padEnd(width)} ${'PHARMACY'.padEnd(10)} SUPERMARKET`);
  console.log(`  ${'-'.repeat(width + 22)}`);
  for (const name of names) {
    const pharmacy = results.PHARMACY.find((check) => check.name === name);
    const supermarket = results.SUPERMARKET.find((check) => check.name === name);
    const cell = (check?: Check) => (check?.pass ? 'PASS' : 'FAIL').padEnd(10);
    console.log(`  ${name.padEnd(width)} ${cell(pharmacy)} ${cell(supermarket)}`);
  }
  for (const edition of ['PHARMACY', 'SUPERMARKET'] as Edition[]) {
    for (const check of results[edition]) {
      if (!check.pass) console.log(`\n  ${edition} × ${check.name} — ${check.detail ?? 'failed'}`);
    }
  }
}

async function main(): Promise<void> {
  if (!MASTER) {
    console.error('Set VENDOR_MASTER_PASSWORD in the environment: npm run e2e');
    process.exit(1);
  }
  const pharmacy = await runEdition('PHARMACY', 4181);
  const supermarket = await runEdition('SUPERMARKET', 4182);
  printTable({ PHARMACY: pharmacy.checks, SUPERMARKET: supermarket.checks });

  for (const run of [pharmacy, supermarket]) {
    try {
      if (run.child.pid) process.kill(-run.child.pid, 'SIGTERM');
    } catch {
      run.child.kill();
    }
    rmSync(run.dir, { recursive: true, force: true });
  }
  // Give the servers a moment to release their ports before the next run.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const failures = [...pharmacy.checks, ...supermarket.checks].filter((check) => !check.pass);
  console.log(`\n  ${pharmacy.checks.length + supermarket.checks.length - failures.length} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
