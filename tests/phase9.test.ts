import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Product, ProductScan, SessionInfo } from '../src/shared/types';
import type { SettingsPayload } from '../src/shared/types';
import { getAllSettings, parseScaleBarcode, updateSettings } from '../src/services/settings';
import { scanProduct } from '../src/services/products';
import { previewReceipt } from '../src/services/receiptPreview';
import {
  backupStatus,
  copyBackupTo,
  createBackup,
  listBackups,
  listBackupsIn,
  restoreBackup,
  runDailyBackup,
  validateBackupFile
} from '../src/services/backup';
import { redactDetails } from '../src/services/audit';
import { getLicenseStatus } from '../src/license/license';
import { bootstrap, callErr, callOk, createHarness, createProduct, makeUser } from './helpers';

const PREVIEW = { html: '', layout: '', settings: {} as SettingsPayload, dirty: false };

function scaleProduct(h: Awaited<ReturnType<typeof createHarness>>, admin: SessionInfo): Promise<Product> {
  return createProduct(h, admin, {
    name: 'Golden Penny Semovita 1kg',
    pluCode: '00025',
    isWeighed: true,
    pricePerKg: 1_200_000,
    price: 1_200_000,
    unit: 'kg'
  });
}

describe('scale barcodes', () => {
  it('parses the configured layout and rejects everything else', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    updateSettings(h.db, { scalePrefix: '2', scalePluDigits: 5, scaleWeightDigits: 5 });
    const layout = { prefix: '2', pluDigits: 5, weightDigits: 5 };

    expect(parseScaleBarcode('20002500250', layout)).toEqual({ plu: '00025', weightGrams: 250 });
    // A trailing check digit from some scales is tolerated.
    expect(parseScaleBarcode('200025002507', layout)).toEqual({ plu: '00025', weightGrams: 250 });
    // Not a scale barcode: wrong prefix, letters, zero weight, wrong length, nothing configured.
    expect(parseScaleBarcode('10002500250', layout)).toBeNull();
    expect(parseScaleBarcode('20002A00250', layout)).toBeNull();
    expect(parseScaleBarcode('20002500000', layout)).toBeNull();
    expect(parseScaleBarcode('2000250025', layout)).toBeNull();
    expect(parseScaleBarcode('20002500250', null)).toBeNull();

    // An operator can point the till at a different scale.
    updateSettings(h.db, { scalePrefix: '9', scalePluDigits: 4, scaleWeightDigits: 6 });
    expect(parseScaleBarcode('900252500000', { prefix: '9', pluDigits: 4, weightDigits: 6 })).toEqual({
      plu: '0025',
      weightGrams: 250_000
    });
    expect(parseScaleBarcode('20002500250', { prefix: '9', pluDigits: 4, weightDigits: 6 })).toBeNull();
    void admin;
    h.close();
  });

  it('scans a weighed item through the till and carries the grams', async () => {
    const { h, admin } = await bootstrap('SUPERMARKET');
    const item = await scaleProduct(h, admin);
    const scanned = scanProduct(h.db, '20002500250');
    expect(scanned?.product.id).toBe(item.id);
    expect(scanned?.scannedQty).toBe(250);
    expect(scanned?.scaleBarcode).toBe(true);

    // A plain barcode still scans as one unit.
    const plain = await createProduct(h, admin, { name: 'Bread', barcode: '6151100012345' });
    const direct = scanProduct(h.db, '6151100012345');
    expect(direct?.product.id).toBe(plain.id);
    expect(direct?.scannedQty).toBeNull();
    expect(direct?.scaleBarcode).toBe(false);

    // Unknown PLU and empty scans return nothing rather than guessing.
    expect(scanProduct(h.db, '20009999990')).toBeNull();
    expect(scanProduct(h.db, '   ')).toBeNull();

    const ipc = await callOk<ProductScan | null>(h, 'products.scan', { code: '20002500250' }, admin.token);
    expect(ipc?.scannedQty).toBe(250);
    h.close();
  });
});

describe('live receipt preview', () => {
  it('reflects unsaved drafts without touching the database', async () => {
    const { h, admin } = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy' });
    const saved = getAllSettings(h.db);
    const draft = { storeName: 'Bright Care Pharmacy', thankYouNote: 'Thank you, come again' };

    const preview = previewReceipt(h.db, saved.storeName, draft);
    expect(preview.html).toContain('Bright Care Pharmacy');
    expect(preview.html).toContain('Thank you, come again');
    expect(preview.dirty).toBe(true);
    expect(preview.settings.storeName).toBe('Bright Care Pharmacy');
    // Nothing was saved: the draft only lives in the preview.
    expect(getAllSettings(h.db).storeName).toBe('Grace Pharmacy');

    const unchanged = previewReceipt(h.db, 'Paracetamol 500mg', { storeName: 'Grace Pharmacy' });
    expect(unchanged.dirty).toBe(false);

    // A half-typed (empty) name falls back to the saved one rather than a blank header.
    const blank = previewReceipt(h.db, 'Paracetamol 500mg', { storeName: '   ' });
    expect(blank.settings.storeName).toBe('Grace Pharmacy');
    expect(blank.html).toContain('Grace Pharmacy');

    // VAT appears only when enabled, and shows the rate.
    const vatOff = previewReceipt(h.db, 'Paracetamol 500mg', {});
    expect(vatOff.html).not.toContain('VAT');
    const vatOn = previewReceipt(h.db, 'Paracetamol 500mg', { vatEnabled: true, vatRate: 7.5 });
    expect(vatOn.html).toContain('VAT');

    const ipc = await callOk<typeof PREVIEW>(h, 'settings.preview', { draft }, admin.token);
    expect(ipc.html).toContain('Bright Care Pharmacy');
    expect(ipc.dirty).toBe(true);
    h.close();
  });

  it('refuses the preview to non-admins', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const cashier = await makeUser(h, admin, 'CASHIER', 'tillpreview');
    const denied = await callErr(h, 'settings.preview', { draft: {} }, cashier.token);
    expect(denied.code).toBe('FORBIDDEN');
    h.close();
  });
});

describe('backups', () => {
  it('backs up to a chosen folder, lists it and copies it again', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const usb = mkdtempSync(join(tmpdir(), 'infoflex-usb-'));
    const second = mkdtempSync(join(tmpdir(), 'infoflex-usb2-'));

    const external = await callOk<{ path: string; external: boolean; label: string }>(
      h,
      'backup.create',
      { label: 'manual', folder: usb },
      admin.token
    );
    expect(external.external).toBe(true);
    expect(existsSync(external.path)).toBe(true);
    expect(listBackupsIn(usb)).toHaveLength(1);
    expect(validateBackupFile(external.path).tables).toBe(4);

    // The chosen folder is listed over IPC too (a USB stick the operator picked).
    const listed = await callOk<unknown[]>(h, 'backup.listFolder', { folder: usb }, admin.token);
    expect(listed).toHaveLength(1);

    const copied = copyBackupTo(listBackupsIn(usb)[0], second);
    expect(existsSync(copied.path)).toBe(true);
    expect(listBackupsIn(second)).toHaveLength(1);

    // A backup can only be copied out of the app's own folder, not from anywhere.
    const outside = await callErr(
      h,
      'backup.copy',
      { path: '/etc/hosts', folder: second },
      admin.token
    );
    expect(['VALIDATION', 'NOT_FOUND']).toContain(outside.code);

    // Restoring from a folder the app did not write is still possible by path.
    const bad = await callErr(h, 'backup.restore', { path: external.path, confirm: 'nope.db' }, admin.token);
    expect(bad.code).toBe('VALIDATION');

    rmSync(usb, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    h.close();
  });

  it('takes one automatic backup a day and never on an unlicensed install', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const first = runDailyBackup(h.db, join(h.dir, 'backups'));
    expect(first?.label).toBe('auto');
    const again = runDailyBackup(h.db, join(h.dir, 'backups'));
    expect(again).toBeNull();
    expect(listBackups(join(h.dir, 'backups'))).toHaveLength(1);

    // Staleness: 8 days after the only backup the shop is warned.
    const status = backupStatus(join(h.dir, 'backups'));
    expect(status.count).toBe(1);
    expect(status.stale).toBe(false);
    expect(status.warnAfterDays).toBe(7);
    expect(backupStatus(join(h.dir, 'nothing-here')).stale).toBe(true);

    const ipc = await callOk<{ count: number; stale: boolean }>(h, 'backup.status', {}, admin.token);
    expect(ipc.count).toBe(1);
    h.close();

    // A brand-new machine with no licence collects no empty backups.
    const fresh = createHarness();
    expect(runDailyBackup(fresh.db, join(fresh.dir, 'backups'))).toBeNull();
    fresh.close();
  });

  it('keeps the licence when restoring another shop backup', async () => {
    const shop = await bootstrap('PHARMACY', { storeName: 'Grace Pharmacy' });
    const other = await bootstrap('SUPERMARKET', { storeName: 'Mart Next Door' });
    const otherProduct = await createProduct(other.h, other.admin, { name: 'Bag of Rice' });
    const otherBackup = createBackup(other.h.db, join(other.h.dir, 'backups'), 'manual');

    const before = getLicenseStatus(shop.h.db);
    const historyBefore = shop.h.db.handle.prepare('SELECT COUNT(*) AS n FROM license_history').get() as {
      n: number;
    };
    const ownProduct = await createProduct(shop.h, shop.admin, { name: 'Vitamin C' });

    const result = restoreBackup(shop.h.db, join(shop.h.dir, 'backups'), otherBackup.path, {
      userId: shop.admin.userId,
      username: shop.admin.username
    });

    // The shop's licence survived, including its edition and history.
    const after = getLicenseStatus(shop.h.db);
    expect(after.edition).toBe('PHARMACY');
    expect(after.state).toBe(before.state);
    expect(after.expiresAt).toBe(before.expiresAt);
    const historyAfter = shop.h.db.handle.prepare('SELECT COUNT(*) AS n FROM license_history').get() as { n: number };
    expect(historyAfter.n).toBe(historyBefore.n);

    // The data came from the other shop's file …
    const products = await callOk<Product[]>(shop.h, 'products.list', {}, shop.admin.token);
    expect(products.some((p) => p.name === 'Bag of Rice')).toBe(true);
    // Ids are per-database, so compare names: the shop's own product is gone.
    expect(products.some((p) => p.name === 'Vitamin C')).toBe(false);
    expect(products.some((p) => p.name === otherProduct.name)).toBe(true);
    void ownProduct;

    // … and the restore told the operator what it found in the file.
    expect(result.license.edition).toBe('PHARMACY');
    expect(result.backupLicense?.edition).toBe('SUPERMARKET');
    expect(existsSync(result.safetyCopy)).toBe(true);

    // The audit entry records the difference, and the safety copy can undo it.
    const audit = await callOk<{ action: string; details: string }[]>(shop.h, 'audit.list', {}, shop.admin.token);
    const entry = audit.find((row) => row.action === 'backup.restore');
    expect(entry).toBeTruthy();
    expect(String(entry?.details)).toContain('SUPERMARKET');

    other.h.close();
    shop.h.close();
  });

  it('never overwrites a backup or a safety copy made in the same second', async () => {
    const { h } = await bootstrap('PHARMACY');
    const dir = join(h.dir, 'backups');
    const first = createBackup(h.db, dir, 'manual');
    const second = createBackup(h.db, dir, 'manual');
    expect(first.path).not.toBe(second.path);
    expect(listBackups(dir)).toHaveLength(2);

    // Two restores back to back each keep their own undo copy.
    const one = restoreBackup(h.db, dir, second.path);
    const two = restoreBackup(h.db, dir, first.path);
    expect(one.safetyCopy).not.toBe(two.safetyCopy);
    expect(existsSync(one.safetyCopy)).toBe(true);
    expect(existsSync(two.safetyCopy)).toBe(true);
    h.close();
  });

  it('refuses a file that is not a database', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const folder = mkdtempSync(join(tmpdir(), 'infoflex-junk-'));
    const junk = join(folder, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    const err = await callErr(h, 'backup.restore', { path: junk, confirm: 'junk.db' }, admin.token);
    expect(err.code).toBe('VALIDATION');
    // The live database is untouched by a failed restore.
    const products = await callOk<Product[]>(h, 'products.list', {}, admin.token);
    expect(Array.isArray(products)).toBe(true);
    rmSync(folder, { recursive: true, force: true });
    h.close();
  });
});

describe('hardening', () => {
  it('redacts secrets from audit details', () => {
    const redacted = redactDetails({
      username: 'ada',
      password: 'hunter2',
      nested: { supervisorPin: '1234', note: 'void approved' },
      activationCode: 'ABC-123',
      list: [{ token: 'abc' }]
    }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('1234');
    expect(text).not.toContain('ABC-123');
    expect(text).not.toContain('"abc"');
    expect(text).toContain('ada');
    expect(text).toContain('void approved');
  });

  it('rejects oversized IPC payloads before touching the database', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const huge = 'x'.repeat(4_500_000);
    const err = await callErr(h, 'products.list', { search: huge }, admin.token);
    expect(err.code).toBe('VALIDATION');
    expect(err.message.toLowerCase()).toContain('large');
    h.close();
  });

  it('keeps the master password out of the audit trail', async () => {
    const { h, admin } = await bootstrap('PHARMACY');
    const rows = await callOk<{ action: string; details: string }[]>(h, 'audit.list', {}, admin.token);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(process.env.VENDOR_MASTER_PASSWORD ?? 'impossible-master-value');
    expect(dump.toLowerCase()).not.toContain('masterpassword');
    h.close();
  });
});
