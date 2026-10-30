/**
 * Generates docs/SCHEMA.md from the real migrations plus src/db/schema.ts.
 *
 *   npm run db:schema
 *
 * Keeps the documentation honest: the columns printed here are the ones SQLite
 * created when the migrations ran, not a hand-written copy.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Database } from '../src/db';
import { EDITION_COLUMNS, PHARMACY_TABLES, SUPERMARKET_TABLES, TABLES } from '../src/db/schema';
import { MIGRATIONS } from '../src/db/migrations';

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'infoflex-schema-'));
  const db = new Database(join(dir, 'schema.db'));
  const out: string[] = [];

  try {
    db.open();
    const version = db.handle.pragma('user_version', { simple: true }) as number;

    out.push('# Database schema');
    out.push('');
    out.push(
      'Infoflex keeps everything in one SQLite file inside the OS application-data folder, so the app ' +
        'works fully offline:'
    );
    out.push('');
    out.push('| OS | Path |');
    out.push('| --- | --- |');
    out.push('| Windows | `%APPDATA%\\Infoflex\\data\\infoflex.db` |');
    out.push('| macOS | `~/Library/Application Support/Infoflex/data/infoflex.db` |');
    out.push('| Linux | `~/.config/Infoflex/data/infoflex.db` |');
    out.push('');
    out.push(
      'Set `INFOFLEX_DATA_DIR` to override the folder (the browser preview and the smoke test do this).'
    );
    out.push('');
    out.push(`Schema version: **${version}** (\`PRAGMA user_version\`), migrations: ${MIGRATIONS.map((m) => `v${m.version} ${m.name}`).join(', ')}.`);
    out.push('');
    out.push('## Rules that apply to every table');
    out.push('');
    out.push('- **Money is integer kobo.** ₦1,500.00 is stored as `150000`. Formatting happens at the edge (`src/shared/money.ts`).');
    out.push('- **Timestamps are ISO-8601 UTC strings** (`2026-10-30T12:00:00.000Z`); business dates are `YYYY-MM-DD`.');
    out.push('- **Sales, sale items and payments are never deleted.** A mistake is voided (`sales.status = \'VOIDED\'`, `voided_by`, `voided_at`, audit entry).');
    out.push('- **Money and stock changes run in one `IMMEDIATE` transaction** (`Database.transaction`), so a failed payment can never leave stock short.');
    out.push('- **Receipt numbers are sequential and unique** (`counters` → `RCP-000001`), likewise invoices (`INV-`), credit notes (`CN-`), purchase numbers (`PUR-`) and product codes (`SKU-`).');
    out.push('- **Every table below is reachable through a typed repository** in `src/db/repositories/`.');
    out.push('');
    out.push('## Tables by edition');
    out.push('');
    out.push(`- **Shared (all editions):** ${TABLES.filter((t) => t.owner === 'shared').map((t) => `\`${t.name}\``).join(', ')}`);
    out.push(`- **Pharmacy module:** ${PHARMACY_TABLES.map((t) => `\`${t}\``).join(', ')}`);
    out.push(`- **Supermarket module:** ${SUPERMARKET_TABLES.map((t) => `\`${t}\``).join(', ')}`);
    out.push('');
    out.push(
      'Edition tables are created by the migration (a shop that later upgrades from pharmacy to ' +
        'pharmacy+supermarket keeps its data), but the main process only mounts a module\'s IPC channels ' +
        'when the signed licence enables it — see `handlerMapFor()` in `src/main/api/registry.ts`.'
    );
    out.push('');

    const byName = new Map(TABLES.map((t) => [t.name, t]));
    for (const owner of ['shared', 'pharmacy', 'supermarket'] as const) {
      out.push(`## ${owner === 'shared' ? 'Shared' : owner === 'pharmacy' ? 'Pharmacy module' : 'Supermarket module'} tables`);
      out.push('');
      for (const spec of TABLES.filter((t) => t.owner === owner)) {
        const columns = db.handle.prepare(`PRAGMA table_info(${spec.name})`).all() as ColumnInfo[];
        const indexes = (
          db.handle
            .prepare(
              `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name`
            )
            .all(spec.name) as { name: string; sql: string | null }[]
        )
          .filter((index) => index.sql)
          .map((index) => `\`${index.name}\``);

        out.push(`### \`${spec.name}\``);
        out.push('');
        out.push(spec.description);
        out.push('');
        out.push('| Column | Type | Null | Default | Key |');
        out.push('| --- | --- | --- | --- | --- |');
        for (const column of columns) {
          const key = column.pk ? 'PK' : '';
          out.push(
            `| \`${column.name}\` | ${column.type || '—'} | ${column.notnull ? 'NOT NULL' : 'yes'} | ${
              column.dflt_value === null ? '—' : `\`${column.dflt_value}\``
            } | ${key} |`
          );
        }
        if (indexes.length) {
          out.push('');
          out.push(`Indexes: ${indexes.join(', ')}`);
        }
        out.push('');
      }
    }

    out.push('## Edition-specific columns');
    out.push('');
    out.push('These columns live on shared tables but only carry data in the edition that owns them.');
    out.push('');
    out.push('| Table | Column | Owner | Notes |');
    out.push('| --- | --- | --- | --- |');
    for (const column of EDITION_COLUMNS) {
      out.push(`| \`${column.table}\` | \`${column.column}\` | ${column.owner} | ${column.note} |`);
    }
    out.push('');
    out.push('## Migrations');
    out.push('');
    out.push('`src/db/migrations.ts` holds an append-only list. On startup `migrate()` reads `PRAGMA user_version`,');
    out.push('applies every newer migration inside a transaction (rollback on error) and bumps the version.');
    out.push('');
    out.push('| Version | Name |');
    out.push('| --- | --- |');
    for (const migration of MIGRATIONS) out.push(`| ${migration.version} | ${migration.name} |`);
    out.push('');
    out.push('To add a migration: append a `{ version, name, sql }` entry, add any new table/column to');
    out.push('`src/db/schema.ts`, run `npm run db:verify` (writes and reads a row in every table, checks the');
    out.push('manifest against the database) and `npm run db:schema` to refresh this page.');
    out.push('');
    out.push('### Counting rows');
    out.push('');
    out.push('```sql');
    out.push('-- what a shop actually has');
    out.push("SELECT 'sales', COUNT(*) FROM sales UNION ALL SELECT 'products', COUNT(*) FROM products;");
    out.push('```');
    out.push('');
    out.push(`_${byName.size} tables documented; generated ${new Date().toISOString()} by scripts/gen-schema-doc.ts._`);
    out.push('');

    const target = join(process.cwd(), 'docs', 'SCHEMA.md');
    writeFileSync(target, out.join('\n'), 'utf8');
    console.log(`Wrote ${target} (${byName.size} tables, ${out.length} lines).`);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

main();
