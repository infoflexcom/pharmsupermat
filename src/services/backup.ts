/**
 * Local backups.
 *
 * A backup is a consistent SQLite snapshot (`VACUUM INTO`), so it is a single
 * portable file that can sit in the app's data folder, on a flash drive or on a
 * network share the operator chooses. Nothing is uploaded anywhere.
 *
 * Two rules shape this module:
 *  1. A restore never touches the licence. The licence tables are captured from
 *     the live database, the backup is put in place, and the captured rows are
 *     written back — so restoring an old file can neither roll the licence back
 *     nor import one from another machine.
 *  2. A restore is always reversible: the current database is snapshotted first
 *     and kept beside the backups as `pre-restore_…`.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import Sqlite from 'better-sqlite3';
import type { Database } from '../db';
import type { BackupInfo, BackupStatus } from '../shared/types';
import { AppError, validation } from '../shared/errors';
import { audit } from './audit';
import { getLicenseStatus } from '../license/license';

/** Days without a backup before the app warns the operator. */
export const BACKUP_WARN_DAYS = 7;

/** The licence lives outside the data being restored. */
const LICENSE_TABLES = ['license_state', 'license_guard', 'license_history', 'license_attempts'] as const;

/** Refuse anything bigger than this as a backup file (a shop database is MBs). */
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

interface Actor {
  userId: number;
  username: string;
}

/** Millisecond precision: two backups (or two restores) in one second must not collide. */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
}

/** Never overwrite a file that is already there — VACUUM INTO refuses to. */
function uniquePath(folder: string, name: string): string {
  const base = name.replace(/\.db$/i, '');
  let candidate = join(folder, name);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(folder, `${base}-${counter}.db`);
    counter += 1;
  }
  return candidate;
}

/** `infoflex-backup_2026-03-05_14-22-01_manual.db` → `manual`. */
function labelFromName(name: string): string {
  const match = /_([a-z-]+)\.db$/i.exec(name);
  return match ? match[1] : 'backup';
}

function describe(path: string, options: { external?: boolean } = {}): BackupInfo {
  const stat = statSync(path);
  const name = basename(path);
  return {
    name,
    path,
    size: stat.size,
    createdAt: stat.mtime.toISOString(),
    label: labelFromName(name),
    external: options.external ?? false
  };
}

/** A consistent snapshot, written straight into `folder`. */
function snapshot(db: Database, folder: string, label: string, internal: boolean): BackupInfo {
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'manual';
  const name = `infoflex-backup_${timestamp()}_${safeLabel}.db`;
  const target = uniquePath(folder, name);
  db.handle.prepare('VACUUM INTO ?').run(target);
  return describe(target, { external: !internal });
}

/**
 * Creates a backup in the app's own backups folder. Pass `folder` to write it
 * somewhere else instead (a USB stick, a second disk) — the file is the same.
 */
export function createBackup(
  db: Database,
  backupsDir: string,
  label = 'manual',
  options: { folder?: string } = {}
): BackupInfo {
  const folder = options.folder ? resolve(options.folder) : backupsDir;
  if (options.folder) {
    if (!isAbsolute(options.folder)) throw validation('Choose an absolute folder for the backup.');
    if (!existsSync(folder) || !lstatSync(folder).isDirectory()) {
      throw validation('That folder does not exist. Plug the drive in and choose it again.');
    }
    if (folder === dirname(resolve(db.filename))) {
      throw validation('Choose a folder other than the one the live database sits in.');
    }
  }
  try {
    mkdirSync(folder, { recursive: true });
    return snapshot(db, folder, label, !options.folder);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'CONFLICT',
      `The backup could not be written to ${folder}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function listBackups(backupsDir: string): BackupInfo[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.toLowerCase().endsWith('.db'))
    .map((name) => describe(join(backupsDir, name)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Newest backups first, for an external folder the operator picked. */
export function listBackupsIn(folder: string): BackupInfo[] {
  const target = resolve(folder);
  if (!existsSync(target) || !lstatSync(target).isDirectory()) {
    throw validation('That folder cannot be read.');
  }
  return readdirSync(target)
    .filter((f) => f.toLowerCase().endsWith('.db'))
    .map((name) => describe(join(target, name), { external: true }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** True when the folder can actually be written to (a dead USB stick cannot). */
function isWritableFolder(folder: string): boolean {
  const probe = join(folder, `.infoflex-write-test-${Date.now()}`);
  try {
    mkdirSync(probe, { recursive: true });
    rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Copies one of this app's backups to a folder the operator chooses. */
export function copyBackupTo(info: BackupInfo, folder: string): BackupInfo {
  const target = resolve(folder);
  if (!existsSync(target) || !lstatSync(target).isDirectory()) {
    throw validation('That folder does not exist. Plug the drive in and choose it again.');
  }
  if (!isWritableFolder(target)) throw validation('That folder cannot be written to.');
  const destination = join(target, info.name);
  if (resolve(destination) === resolve(info.path)) return info;
  try {
    copyFileSync(info.path, destination);
  } catch (error) {
    throw new AppError(
      'CONFLICT',
      `The backup could not be copied: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return describe(destination, { external: true });
}

export function validateBackupFile(path: string): { tables: number } {
  if (!path || typeof path !== 'string') throw validation('Choose a backup file.');
  if (!path.toLowerCase().endsWith('.db')) throw validation('Choose a .db backup file.');
  if (!existsSync(path)) throw validation('That backup file does not exist.');
  const stat = lstatSync(path);
  // A symlink could point at the live database or somewhere unexpected.
  if (stat.isSymbolicLink()) throw validation('Choose the backup file itself, not a shortcut.');
  if (!stat.isFile()) throw validation('That is not a file.');
  if (stat.size === 0) throw validation('That backup file is empty.');
  if (stat.size > MAX_BACKUP_BYTES) throw validation('That file is far too large to be a shop backup.');

  let handle: Sqlite.Database | null = null;
  try {
    handle = new Sqlite(path, { readonly: true, fileMustExist: true });
    const integrity = handle.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity check returned ${String(integrity)}`);
    const tables = handle
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('sales','products','users','settings')"
      )
      .get() as { n: number };
    if (tables.n < 4) throw new Error('this file is not an Infoflex database');
    return { tables: tables.n };
  } catch (error) {
    throw validation(
      `That file cannot be used as a backup: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    handle?.close();
  }
}

/* ------------------------------------------------------------------ */
/* Licence preservation                                                */
/* ------------------------------------------------------------------ */

type TableRows = { table: string; columns: string[]; rows: Record<string, unknown>[] };

function captureLicense(db: Database): TableRows[] {
  return LICENSE_TABLES.map((table) => {
    try {
      const rows = db.handle.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      return { table, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows };
    } catch {
      return { table, columns: [], rows: [] };
    }
  }).filter((entry) => entry.rows.length > 0);
}

function restoreLicenseRows(db: Database, captured: TableRows[]): void {
  db.transaction(() => {
    for (const entry of captured) {
      if (entry.columns.length === 0 || entry.rows.length === 0) continue;
      db.handle.prepare(`DELETE FROM ${entry.table}`).run();
      const placeholders = entry.columns.map(() => '?').join(', ');
      const insert = db.handle.prepare(
        `INSERT INTO ${entry.table} (${entry.columns.join(', ')}) VALUES (${placeholders})`
      );
      for (const row of entry.rows) insert.run(...entry.columns.map((column) => row[column] as never));
    }
  });
}

/* ------------------------------------------------------------------ */
/* Restore                                                             */
/* ------------------------------------------------------------------ */

export interface RestoreResult {
  restoredFrom: string;
  safetyCopy: string;
  /** The licence that was kept, described for the person who restored. */
  license: { state: string; edition: string | null; expiresAt: string | null };
  /** Whatever the backup itself carried, for the audit trail. */
  backupLicense: { state: string; edition: string | null } | null;
}

/**
 * Restores a backup file over the live database.
 *
 * Order matters: validate the file, snapshot the current database, capture the
 * licence rows, swap the file in, re-open (which runs migrations), then write
 * the captured licence back. A backup from another shop therefore brings its
 * products and sales but never its licence.
 */
export function restoreBackup(
  db: Database,
  backupsDir: string,
  backupPath: string,
  actor?: Actor
): RestoreResult {
  const dbPath = db.filename;
  if (dbPath === ':memory:') throw new AppError('CONFLICT', 'In-memory databases cannot be restored.');
  const source = resolve(backupPath);
  validateBackupFile(source);
  mkdirSync(backupsDir, { recursive: true });

  // "Restore even when the licence is broken" is deliberate: the safety copy
  // below is what protects the operator, so no licence state blocks a restore.
  const captured = captureLicense(db);
  const safetyCopy = uniquePath(backupsDir, `pre-restore_${basename(dbPath)}_${timestamp()}.db`);
  db.handle.prepare('VACUUM INTO ?').run(safetyCopy);

  db.close();
  // Remove WAL/SHM sidecars so the restored file is authoritative.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }

  const staging = `${source}.restoring`;
  copyFileSync(source, staging);
  try {
    renameSync(staging, dbPath);
  } catch (error) {
    // Windows refuses a rename across volumes; fall back to a copy.
    try {
      copyFileSync(staging, dbPath);
      unlinkSync(staging);
    } catch (inner) {
      if (existsSync(staging)) unlinkSync(staging);
      throw new AppError(
        'CONFLICT',
        `The backup could not be put in place: ${inner instanceof Error ? inner.message : String(inner)}`
      );
    }
    void error;
  }

  db.open();

  // What did the file itself carry? Read it before the capture is written back.
  let backupLicense: RestoreResult['backupLicense'] = null;
  try {
    const after = getLicenseStatus(db);
    backupLicense = { state: after.state, edition: after.edition };
  } catch {
    backupLicense = null;
  }
  restoreLicenseRows(db, captured);
  const license = getLicenseStatus(db);

  if (actor) {
    audit(db, {
      action: 'backup.restore',
      entity: 'backup',
      entityId: basename(source),
      userId: actor.userId,
      username: actor.username,
      severity: 'SECURITY',
      details: {
        restoredFrom: source,
        safetyCopy,
        keptLicense: { state: license.state, edition: license.edition, expiresAt: license.expiresAt },
        backupLicense
      }
    });
  }

  return {
    restoredFrom: source,
    safetyCopy,
    license: { state: license.state, edition: license.edition, expiresAt: license.expiresAt },
    backupLicense
  };
}

/* ------------------------------------------------------------------ */
/* Automatic daily backup + status                                     */
/* ------------------------------------------------------------------ */

/**
 * The daily safety net: one snapshot per 24 hours, taken when the app starts (or
 * closes). It is skipped on an unlicensed install so a fresh machine does not
 * collect empty files.
 */
export function runDailyBackup(db: Database, backupsDir: string, now = new Date()): BackupInfo | null {
  mkdirSync(backupsDir, { recursive: true });
  const latest = listBackups(backupsDir).find((backup) => backup.label === 'auto' || backup.label === 'shutdown');
  const fresh = latest && now.getTime() - Date.parse(latest.createdAt) < 24 * 60 * 60 * 1000;
  if (fresh) return null;
  if (getLicenseStatus(db).state === 'NONE') return null;
  const info = createBackup(db, backupsDir, 'auto');
  audit(db, {
    action: 'backup.create',
    entity: 'backup',
    entityId: info.name,
    username: 'system',
    details: { automatic: true }
  });
  return info;
}

export function backupStatus(backupsDir: string, automatic = true): BackupStatus {
  const backups = listBackups(backupsDir);
  const latest = backups[0] ?? null;
  const daysSince = latest
    ? Math.max(0, Math.floor((Date.now() - Date.parse(latest.createdAt)) / 86_400_000))
    : null;
  return {
    count: backups.length,
    lastAt: latest?.createdAt ?? null,
    daysSince,
    stale: daysSince === null || daysSince >= BACKUP_WARN_DAYS,
    warnAfterDays: BACKUP_WARN_DAYS,
    automatic,
    backupsDir
  };
}

/** ISO timestamp of the last backup, or null. Used for the warning badge. */
export function lastBackupAt(backupsDir: string): string | null {
  return listBackups(backupsDir)[0]?.createdAt ?? null;
}

