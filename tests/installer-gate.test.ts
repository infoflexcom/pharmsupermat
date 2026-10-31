import { describe, expect, it } from 'vitest';
import { pbkdf2Sync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GATE_ITERATIONS,
  mintGate,
  renderGateModule,
  verifyVendorPassword
} from '../scripts/make-installer-gate';
import { requireMasterPassword } from './helpers';

const ROOT = join(__dirname, '..');
const installerNsh = readFileSync(join(ROOT, 'resources/build/installer.nsh'), 'utf8');
const gatePs1 = readFileSync(join(ROOT, 'resources/build/gate.ps1'), 'utf8');
const vendorSecrets = JSON.parse(
  readFileSync(join(ROOT, 'src/license/vendor-secrets.json'), 'utf8')
) as { passwordHash: string };

describe('installer password gate', () => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

  it('mints PBKDF2 digests with both hash flavours and no plaintext', () => {
    const password = 'gate-test-password-not-the-real-one';
    const gate = mintGate(password, salt, 1000);

    expect(gate.salt).toBe(salt.toString('hex'));
    expect(gate.iterations).toBe(1000);
    expect(gate.sha256).toBe(pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex'));
    expect(gate.sha1).toBe(pbkdf2Sync(password, salt, 1000, 32, 'sha1').toString('hex'));
    expect(gate.sha256).toHaveLength(64);
    expect(gate.sha1).toHaveLength(64);

    const nsh = renderGateModule(gate);
    expect(nsh).toContain(`!define GATE_SALT '${salt.toString('hex')}'`);
    expect(nsh).toContain(`!define GATE_ITERATIONS '1000'`);
    expect(nsh).toContain(`!define GATE_HASH_SHA256 '${gate.sha256}'`);
    expect(nsh).toContain(`!define GATE_HASH_SHA1 '${gate.sha1}'`);
    expect(nsh).not.toContain(password);
    expect(nsh.toLowerCase()).not.toContain(password.toLowerCase());
  });

  it('defaults to a slow iteration count', () => {
    expect(GATE_ITERATIONS).toBeGreaterThanOrEqual(100_000);
  });

  it('recognises the real vendor password hash and rejects others', () => {
    const master = requireMasterPassword();
    expect(verifyVendorPassword(master, vendorSecrets.passwordHash)).toBe(true);
    expect(verifyVendorPassword(`${master}x`, vendorSecrets.passwordHash)).toBe(false);
    expect(verifyVendorPassword(master, 'not-a-hash')).toBe(false);
  });

  it('ships an NSIS page that cannot be skipped', () => {
    // The page is registered ahead of every other page…
    expect(installerNsh).toMatch(/!macro customWelcomePage\s+Page custom GatePageCreate GatePageLeave/);
    // …refuses silent installs, which would otherwise bypass the page…
    expect(installerNsh).toContain('${If} ${Silent}');
    // …aborts the wizard while the password is wrong, and quits after five.
    expect(installerNsh).toContain('!define /ifndef GATE_MAX_ATTEMPTS 5');
    expect(installerNsh).toMatch(/IntOp \$GateAttempts \$GateAttempts \+ 1/);
    expect(installerNsh).toContain('GATE_MAX_ATTEMPTS} times');
    // Fail closed: a broken verifier blocks the install instead of allowing it.
    expect(installerNsh).toContain('GATE_ERROR');
    // The candidate is handed over by environment variable, not argv.
    expect(installerNsh).toContain('SetEnvironmentVariable(t "INFOFLEX_GATE_PASSWORD"');
    expect(installerNsh).not.toMatch(/gate\.ps1".*-Password/);
  });

  it('ships a verifier with no secret in it', () => {
    expect(gatePs1).toContain("INFOFLEX_GATE_PASSWORD");
    expect(gatePs1).toContain('Rfc2898DeriveBytes');
    expect(gatePs1).toContain('GATE_OK');
    expect(gatePs1).toContain('GATE_DENIED');
    expect(gatePs1).not.toMatch(/[0-9a-f]{64}/i); // no digest baked in
    const master = requireMasterPassword();
    expect(gatePs1).not.toContain(master);
    expect(installerNsh).not.toContain(master);
  });

  it('keeps the minted header out of version control', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toContain('/resources/build/generated/');
    expect(gitignore).not.toContain('gate.ps1');
    expect(gitignore).not.toContain('installer.nsh');
  });
});
