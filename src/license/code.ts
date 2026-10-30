import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import type { Edition, LicensePayload } from '../shared/types';
import { isValidEdition } from '../shared/editions';

/**
 * Licence codes are signed offline by the vendor and verified inside the app
 * with an Ed25519 public key. Format:
 *
 *   IFX1.<base64url(canonical json payload)>.<base64url(ed25519 signature)>
 *
 * The payload is signed exactly as encoded (no re-serialisation), so the
 * verification path can never disagree with the issuing path.
 */

export const LICENSE_CODE_PREFIX = 'IFX1';

export function canonicalPayload(payload: LicensePayload): Buffer {
  // Stable key order — the signed bytes are what gets embedded in the code.
  const ordered = {
    v: payload.v,
    licenseId: payload.licenseId,
    edition: payload.edition,
    customerName: payload.customerName,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    note: payload.note ?? ''
  };
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str: string): Buffer {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

export function encodeLicenseCode(payload: LicensePayload, signature: Buffer): string {
  return `${LICENSE_CODE_PREFIX}.${b64url(canonicalPayload(payload))}.${b64url(signature)}`;
}

export interface DecodedLicenseCode {
  payload: LicensePayload;
  signature: Buffer;
  signedBytes: Buffer;
}

export function decodeLicenseCode(code: string): DecodedLicenseCode {
  const trimmed = code.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_CODE_PREFIX) {
    throw new Error('This is not a valid Infoflex licence code.');
  }
  const signedBytes = fromB64url(parts[1]);
  let payload: LicensePayload;
  try {
    payload = JSON.parse(signedBytes.toString('utf8')) as LicensePayload;
  } catch {
    throw new Error('Licence code payload is unreadable.');
  }
  if (!payload || payload.v !== 1 || !isValidEdition(payload.edition)) {
    throw new Error('Licence code payload is incomplete.');
  }
  if (typeof payload.customerName !== 'string' || !payload.customerName.trim()) {
    throw new Error('Licence code is missing the customer name.');
  }
  for (const field of ['issuedAt', 'expiresAt'] as const) {
    if (typeof payload[field] !== 'string' || Number.isNaN(Date.parse(payload[field]))) {
      throw new Error(`Licence code has an invalid ${field} value.`);
    }
  }
  return { payload, signature: fromB64url(parts[2]), signedBytes };
}

export function verifyLicenseCode(code: string, publicKeyBase64: string): LicensePayload {
  const { payload, signature, signedBytes } = decodeLicenseCode(code);
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, 'base64'),
    format: 'der',
    type: 'spki'
  });
  const ok = cryptoVerify(null, signedBytes, key, signature);
  if (!ok) throw new Error('Licence code signature is not valid.');
  return payload;
}

/** Days remaining until expiry (negative when already expired). */
export function daysUntil(dateIso: string, now = new Date()): number {
  const target = new Date(dateIso).getTime();
  return Math.ceil((target - now.getTime()) / 86_400_000);
}

export const SUPPORTED_EDITIONS: Edition[] = ['PHARMACY', 'SUPERMARKET', 'BOTH'];
