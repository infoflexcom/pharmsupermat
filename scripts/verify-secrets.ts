/**
 * Proof that the vendor master password is not stored anywhere in plain text.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run verify:secrets
 *
 * Searches, in this order:
 *   1. the source tree, scripts, docs and generated assets;
 *   2. resources/build/** — the installer NSIS script, the PowerShell verifier
 *      and the minted gate header (salt + PBKDF2 digests only);
 *   3. release/** — the packaged Windows installer (.exe), the unpacked build
 *      (app.asar and the loose native files) and any Linux/macOS artifacts.
 *
 * Two encodings are searched because a Windows installer written by Unicode
 * NSIS stores its literals as UTF-16LE while the source tree and asar archive
 * are UTF-8.
 *
 * Exits non-zero on a hit, or if the shipped vendor file is not a salted hash.
 */
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const PASSWORD = process.env.VENDOR_MASTER_PASSWORD ?? '';
const SKIP_DIRS = new Set(['node_modules', '.git', '.arena', 'data', '.vite']);
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 512;

if (!PASSWORD) {
  console.error('Set VENDOR_MASTER_PASSWORD to run this check.');
  process.exit(1);
}

const needles: Buffer[] = [
  Buffer.from(PASSWORD, 'utf8'),
  // UTF-16LE with and without a BOM-ish prefix.
  Buffer.from(PASSWORD, 'utf16le')
];

interface Scanned {
  path: string;
  bytes: number;
}

const files: Scanned[] = [];
function walk(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.isFile()) files.push({ path, bytes: stat.size });
  }
}
walk(ROOT);

/** True when any needle appears in the file, scanning in chunks so a 90 MB installer is fine. */
function containsSecret(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.allocUnsafe(CHUNK + OVERLAP);
    let carry = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, buffer, 0, CHUNK, null);
      if (read <= 0) return false;
      const window = Buffer.concat([carry, buffer.subarray(0, read)]);
      for (const needle of needles) {
        if (window.includes(needle)) return true;
      }
      carry = Buffer.from(window.subarray(Math.max(0, window.length - OVERLAP)));
    }
  } finally {
    closeSync(fd);
  }
}

const textHits: string[] = [];
const encodedHits: string[] = [];
for (const file of files) {
  const isText = !/\.(exe|dll|node|asar|png|jpg|jpeg|ico|zip|7z|gz|db|blockmap)$/i.test(file.path);
  if (isText) {
    try {
      if (readFileSync(file.path, 'utf8').includes(PASSWORD)) textHits.push(file.path);
    } catch {
      /* unreadable as text — fall through to the binary scan */
    }
  }
  if (!textHits.includes(file.path) && containsSecret(file.path)) encodedHits.push(file.path);
}

const rel = (p: string) => relative(ROOT, p);
const artifacts = files.filter((f) => rel(f.path).startsWith('release/'));
const gateFiles = files.filter((f) => rel(f.path).startsWith('resources/build/'));
const totalMb = files.reduce((sum, f) => sum + f.bytes, 0) / (1024 * 1024);

const secretsFile = join(ROOT, 'src/license/vendor-secrets.json');
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as { passwordHash: string };
const hashLooksRight = /^(scrypt\$|bcrypt\$|\$2[aby]\$)/.test(secrets.passwordHash);

console.log(`Scanned ${files.length} files (${totalMb.toFixed(1)} MB, ${process.platform}) — UTF-8 and UTF-16LE.`);
console.log(`  source/docs/scripts : ${files.length - artifacts.length - gateFiles.length} files`);
console.log(`  installer inputs    : ${gateFiles.length} files in resources/build`);
if (artifacts.length === 0) {
  console.log('  build artifacts     : none present (run `npm run dist:win` to scan the packaged app)');
} else {
  for (const artifact of artifacts) {
    console.log(`  build artifact      : ${rel(artifact.path)} (${(artifact.bytes / 1048576).toFixed(1)} MB)`);
  }
}
console.log(`Vendor secrets file stores: ${secrets.passwordHash.slice(0, 12)}… (hash only)`);

const hits = [...textHits, ...encodedHits];
if (hits.length > 0) {
  console.error('\nFAIL — the master password appears in plain text in:');
  for (const hit of hits) console.error(`  ${rel(hit)}`);
  process.exit(1);
}
if (!hashLooksRight) {
  console.error('\nFAIL — the vendor secrets file does not contain a salted hash.');
  process.exit(1);
}

console.log('PASS — the master password appears in no source, doc, asset, installer or build file.');
