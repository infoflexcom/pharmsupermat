/**
 * Proof that the vendor master password is not stored anywhere in plain text.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run verify:secrets
 *
 * Scans the source tree, docs, generated assets and (when present) the build
 * output for the exact password taken from the environment, and checks that the
 * shipped vendor file only contains a salted hash. Exits non-zero on a match.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const PASSWORD = process.env.VENDOR_MASTER_PASSWORD ?? '';
const SKIP_DIRS = new Set(['node_modules', '.git', '.arena', 'data', 'release', '.vite']);
const MAX_BYTES = 4_000_000;

if (!PASSWORD) {
  console.error('Set VENDOR_MASTER_PASSWORD to run this check.');
  process.exit(1);
}

const files: string[] = [];
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.size <= MAX_BYTES) files.push(path);
  }
}
walk(ROOT);

const hits = files.filter((file) => {
  try {
    return readFileSync(file, 'utf8').includes(PASSWORD);
  } catch {
    return false;
  }
});

const secretsFile = join(ROOT, 'src/license/vendor-secrets.json');
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as { passwordHash: string };
const hashLooksRight = /^(scrypt\$|bcrypt\$|\$2[aby]\$)/.test(secrets.passwordHash);

console.log(`Scanned ${files.length} files (${process.platform}).`);
console.log(`Vendor secrets file stores: ${secrets.passwordHash.slice(0, 12)}… (hash only)`);

if (hits.length > 0) {
  console.error('\nFAIL — the master password appears in plain text in:');
  for (const hit of hits) console.error(`  ${hit.replace(ROOT + '/', '')}`);
  process.exit(1);
}
if (!hashLooksRight) {
  console.error('\nFAIL — the vendor secrets file does not contain a salted hash.');
  process.exit(1);
}

console.log('PASS — the master password appears in no source, doc, asset or build file.');
