/**
 * Installer password gate — build-time minting.
 *
 *   VENDOR_MASTER_PASSWORD='...' npm run installer:gate
 *   VENDOR_MASTER_PASSWORD='...' npm run installer:gate -- --check
 *
 * Writes resources/build/generated/gate.nsh, the *only* thing the NSIS script
 * knows about the master password:
 *
 *   !define GATE_SALT         random 16-byte hex salt (fresh on every run)
 *   !define GATE_ITERATIONS   PBKDF2 iteration count
 *   !define GATE_HASH_SHA256  PBKDF2-HMAC-SHA256(password, salt, N), hex
 *   !define GATE_HASH_SHA1    PBKDF2-HMAC-SHA1(password, salt, N), hex
 *
 * Two digests are minted because the in-installer verifier falls back to the
 * SHA-1 flavour of PBKDF2 on Windows builds whose .NET runtime predates the
 * hash-algorithm overload (see resources/build/gate.ps1).
 *
 * The generated file is git-ignored and contains no plaintext. The password is
 * read from the environment, checked against the salted scrypt hash in
 * src/license/vendor-secrets.json (so a typo cannot produce an installer whose
 * gate disagrees with the app), and never written anywhere.
 */
import { pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const GATE_ITERATIONS = 150_000;
export const GATE_SALT_BYTES = 16;

const ROOT = join(__dirname, '..');
const OUT_DIR = join(ROOT, 'resources/build/generated');
const OUT_FILE = join(OUT_DIR, 'gate.nsh');

/** True when `password` matches the `scrypt$N$r$p$salt$hash` string in the vendor secrets. */
export function verifyVendorPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * 1024 * 1024
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function mintGate(password: string, salt: Buffer, iterations = GATE_ITERATIONS) {
  return {
    salt: salt.toString('hex'),
    iterations,
    sha256: pbkdf2Sync(password, salt, iterations, 32, 'sha256').toString('hex'),
    sha1: pbkdf2Sync(password, salt, iterations, 32, 'sha1').toString('hex')
  };
}

export function renderGateModule(gate: ReturnType<typeof mintGate>): string {
  return [
    '; ---------------------------------------------------------------------------',
    '; GENERATED FILE — do not edit, do not commit.',
    ';',
    '; Minted by scripts/make-installer-gate.ts from VENDOR_MASTER_PASSWORD.',
    '; Contains a salt and PBKDF2 digests only: no plaintext password.',
    '; ---------------------------------------------------------------------------',
    '',
    `!define GATE_SALT '${gate.salt}'`,
    `!define GATE_ITERATIONS '${gate.iterations}'`,
    `!define GATE_HASH_SHA256 '${gate.sha256}'`,
    `!define GATE_HASH_SHA1 '${gate.sha1}'`,
    ''
  ].join('\n');
}

function readStoredVendorHash(): string | null {
  try {
    const secrets = JSON.parse(readFileSync(join(ROOT, 'src/license/vendor-secrets.json'), 'utf8')) as {
      passwordHash?: string;
    };
    return secrets.passwordHash ?? null;
  } catch {
    return null;
  }
}

function main(): void {
  const checkOnly = process.argv.includes('--check');
  const password = process.env.VENDOR_MASTER_PASSWORD ?? '';
  const stored = readStoredVendorHash();

  if (!password) {
    console.error('Set VENDOR_MASTER_PASSWORD before running this script.');
    process.exit(1);
  }

  if (stored && !verifyVendorPassword(password, stored)) {
    console.error('VENDOR_MASTER_PASSWORD does not match src/license/vendor-secrets.json.');
    console.error('The installer gate would disagree with the app — refusing to continue.');
    process.exit(1);
  }

  if (checkOnly) {
    let existing: string;
    try {
      existing = readFileSync(OUT_FILE, 'utf8');
    } catch {
      console.error('No resources/build/generated/gate.nsh — run `npm run installer:gate` first.');
      process.exit(1);
    }
    const saltMatch = /!define GATE_SALT '([0-9a-f]+)'/.exec(existing);
    const iterMatch = /!define GATE_ITERATIONS '(\d+)'/.exec(existing);
    const sha256Match = /!define GATE_HASH_SHA256 '([0-9a-f]+)'/.exec(existing);
    const sha1Match = /!define GATE_HASH_SHA1 '([0-9a-f]+)'/.exec(existing);

    if (!saltMatch || !iterMatch || !sha256Match || !sha1Match) {
      console.error('gate.nsh is malformed — regenerate it.');
      process.exit(1);
    }

    const minted = mintGate(
      password,
      Buffer.from(saltMatch[1], 'hex'),
      Number(iterMatch[1])
    );
    const ok = minted.sha256 === sha256Match[1] && minted.sha1 === sha1Match[1];
    console.log(ok ? 'PASS — gate.nsh matches VENDOR_MASTER_PASSWORD.' : 'FAIL — gate.nsh was minted from a different password.');
    process.exit(ok ? 0 : 1);
  }

  const gate = mintGate(password, randomBytes(GATE_SALT_BYTES));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, renderGateModule(gate), { mode: 0o600 });

  console.log('Installer gate minted.');
  console.log(`  file        -> resources/build/generated/gate.nsh (git-ignored)`);
  console.log(`  kdf         -> PBKDF2-HMAC-SHA256 / SHA1, ${gate.iterations.toLocaleString()} iterations`);
  console.log(`  digest      -> ${gate.sha256.slice(0, 12)}… (no plaintext anywhere)`);
  if (!stored) {
    console.warn('  warning     -> src/license/vendor-secrets.json was not readable; password not cross-checked.');
  }
}

if (require.main === module) main();
