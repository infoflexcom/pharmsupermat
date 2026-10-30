import type { Database } from '../db';
import type {
  AppState,
  CompleteSetupInput,
  Edition,
  LicenseStatus,
  SessionInfo,
  SetupStatus
} from '../shared/types';
import { nowIso } from '../db';
import { AppError, validation } from '../shared/errors';
import { audit } from './audit';
import {
  DEFAULT_SETTINGS,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  getAllSettings,
  getStoreProfile,
  idleTimeoutMs,
  isStoreConfigured,
  setSettings,
  validateStoreLogo
} from './settings';
import { countAdmins } from './auth';
import { createFirstAdmin } from './users';
import { requireValidLicense } from '../license/license';
import { featuresForEdition, productNameForEdition } from '../shared/editions';
import type { ApiContext, Session } from './session';

/**
 * The store-details label follows the edition: a pharmacy names its premises a
 * pharmacy, a supermarket a supermarket, and a combined licence a business.
 */
export function storeNameLabel(edition: Edition | null | undefined): string {
  switch (edition) {
    case 'PHARMACY':
      return 'Pharmacy name';
    case 'SUPERMARKET':
      return 'Supermarket name';
    case 'BOTH':
      return 'Business name';
    default:
      return 'Store name';
  }
}

export function storeNamePlaceholder(edition: Edition | null | undefined): string {
  switch (edition) {
    case 'PHARMACY':
      return 'e.g. Grace Pharmacy, Ikeja';
    case 'SUPERMARKET':
      return 'e.g. Grace Supermarket, Lekki';
    case 'BOTH':
      return 'e.g. Grace Pharmacy & Mart';
    default:
      return 'Your store name';
  }
}

export function getSetupStatus(db: Database, license: LicenseStatus): SetupStatus {
  const adminConfigured = countAdmins(db, false) > 0;
  const storeConfigured = isStoreConfigured(db);
  const licensed = license.usable;
  return {
    licensed,
    storeConfigured,
    adminConfigured,
    setupRequired: licensed && (!storeConfigured || !adminConfigured),
    storeNameLabel: storeNameLabel(license.edition)
  };
}

export type { CompleteSetupInput };

function optional(value: string | undefined | null): string {
  return value?.trim() ?? '';
}

/**
 * First-run setup: the administrator account and the store details are saved in
 * a single transaction, so a failure on either side leaves no half-configured
 * installation behind (no users, no store name, setup still required).
 */
export function completeSetup(
  db: Database,
  input: CompleteSetupInput,
  license: LicenseStatus
): SetupStatus {
  requireValidLicense(db);
  if (countAdmins(db, false) > 0) {
    throw new AppError('CONFLICT', 'Setup has already been completed. Sign in to change settings.');
  }

  const storeName = input.storeName?.trim() ?? '';
  if (!storeName) throw validation('Your store name is required — it prints on every document.');
  if (storeName.length > 120) throw validation('Store name is too long.');
  if (!input.adminUsername?.trim()) throw validation('An administrator username is required.');
  if (!input.adminFullName?.trim()) throw validation('The administrator full name is required.');
  if (!input.adminPassword) throw validation('An administrator password is required.');
  if (input.adminPassword !== undefined && input.adminPassword.length < 8) {
    throw validation('Password must be at least 8 characters.');
  }
  const email = optional(input.storeEmail);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validation('The store email address looks invalid.');
  }
  const idle = input.idleTimeoutMinutes ?? DEFAULT_SETTINGS.idleTimeoutMinutes;
  if (!Number.isInteger(idle) || idle < MIN_IDLE_MINUTES || idle > MAX_IDLE_MINUTES) {
    throw validation(`Auto sign-out must be between ${MIN_IDLE_MINUTES} and ${MAX_IDLE_MINUTES} minutes.`);
  }
  const storeLogo = validateStoreLogo(input.storeLogo);

  db.transaction(() => {
    setSettings(db, {
      storeName,
      storeAddress: optional(input.storeAddress),
      storePhone: optional(input.storePhone),
      storeEmail: email,
      storeLicenceNo: optional(input.storeLicenceNo),
      storeVatNo: optional(input.storeVatNo),
      storeLogo,
      receiptFooter: optional(input.receiptFooter) || DEFAULT_SETTINGS.receiptFooter,
      thankYouNote: optional(input.thankYouNote) || DEFAULT_SETTINGS.thankYouNote,
      idleTimeoutMinutes: idle
    });
    createFirstAdmin(db, {
      username: input.adminUsername,
      fullName: input.adminFullName,
      password: input.adminPassword,
      email: optional(input.adminEmail) || null
    });
    audit(db, {
      action: 'setup.complete',
      entity: 'settings',
      entityId: 'store',
      username: input.adminUsername.trim(),
      severity: 'SECURITY',
      details: {
        storeName,
        edition: license.edition,
        admin: input.adminUsername.trim(),
        storeEmail: email || null,
        storeLicenceNo: optional(input.storeLicenceNo) || null,
        storeVatNo: optional(input.storeVatNo) || null,
        storeLogo: storeLogo ? 'uploaded' : null,
        idleTimeoutMinutes: idle,
        completedAt: nowIso()
      }
    });
  });
  return getSetupStatus(db, requireValidLicense(db));
}

export function toSessionInfo(session: Session, storeName: string): SessionInfo {
  return {
    token: session.token,
    userId: session.userId,
    username: session.username,
    fullName: session.fullName,
    role: session.role,
    permissions: session.permissions,
    mustChangePassword: session.mustChangePassword,
    storeName
  };
}

export function getAppState(
  ctx: ApiContext,
  license: LicenseStatus,
  session: Session | null
): AppState {
  const settings = getAllSettings(ctx.db);
  const features = license.features ?? featuresForEdition('PHARMACY');
  return {
    productName: license.productName || productNameForEdition(null),
    // Feature flags always come from the signed licence, never from the DB.
    features: license.features
      ? features
      : { ...featuresForEdition('PHARMACY'), edition: 'PHARMACY', pharmacy: false, supermarket: false, prescriptions: false },
    license,
    setup: getSetupStatus(ctx.db, license),
    session: session ? toSessionInfo(session, settings.storeName) : null,
    version: ctx.version,
    storeName: settings.storeName || null,
    idleTimeoutMinutes: Math.round(idleTimeoutMs(ctx.db) / 60_000)
  };
}

export function getStore(db: Database) {
  return getStoreProfile(db);
}
