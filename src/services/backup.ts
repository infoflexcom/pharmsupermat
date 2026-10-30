import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import Sqlite from 'better-sqlite3';
import type { Database } from '../db';
import { AppError, validation } from '../shared/errors';

export interface BackupInfo {
  name: string;
  path: string;
  size: number;
  createdAt: string;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

/** Consistent online snapshot using SQLite's VACUUM INTO. */
export function createBackup(db: Database, backupsDir: string, label?: string): BackupInfo {
  mkdirSync(backupsDir, { recursive: true });
  const safeLabel = label ? `_${label.replace(/[^a-zA-Z0-9_-]/g, '')}` : '';
  const name = `infoflex-backup_${timestamp()}${safeLabel}.db`;
  const target = join(backupsDir, name);
  db.handle.prepare('VACUUM INTO ?').run(target);
  const stat = statSync(target);
  return { name, path: target, size: stat.size, createdAt: new Date().toISOString() };
}

export function listBackups(backupsDir: string): BackupInfo[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir)
    .filter((f) => f.toLowerCase().endsWith('.db'))
    .map((name) => {
      const path = join(backupsDir, name);
      const stat = statSync(path);
      return { name, path, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function validateBackupFile(path: string): { tables: number } {
  if (!existsSync(path)) throw validation('That backup file does not exist.');
  let handle: Sqlite.Database | null = null;
  try {
    handle = new Sqlite(path, { readonly: true, fileMustExist: true });
    const integrity = handle.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`integrity check returned ${String(integrity)}`);
    const tables = handle
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('sales','products','users','settings')")
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

/**
 * Restores a backup: the live database is closed, the current file is kept
 * alongside the backups, then the backup is copied into place and re-opened.
 */
export function restoreBackup(
  db: Database,
  backupsDir: string,
  backupPath: string
): { restoredFrom: string; safetyCopy: string } {
  const dbPath = db.filename;
  if (dbPath === ':memory:') throw new AppError('CONFLICT', 'In-memory databases cannot be restored.');
  if (!backupPath.toLowerCase().endsWith('.db')) throw validation('Choose a .db backup file.');
  validateBackupFile(backupPath);
  mkdirSync(backupsDir, { recursive: true });
  const safetyCopy = join(backupsDir, `pre-restore_${basename(dbPath)}_${timestamp()}.db`);

  db.handle.prepare('VACUUM INTO ?').run(safetyCopy);
  db.close();
  // Remove WAL/SHM sidecars so the restored file is authoritative.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) unlinkSync(sidecar);
  }
  renameSync(backupPath, `${backupPath}.restoring`);
  copyFileSync(`${backupPath}.restoring`, dbPath);
  renameSync(`${backupPath}.restoring`, backupPath);
  db.open();
  return { restoredFrom: backupPath, safetyCopy };
}
