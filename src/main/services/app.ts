import type { Database } from '../core/db';
import type { AppState, LicenseStatus, SessionInfo, SetupStatus } from '../../shared/types';
import { nowIso } from '../core/db';
import { AppError, validation } from '../core/errors';
import { audit } from '../core/audit';
import { getAllSettings, getStoreProfile, isStoreConfigured, setSettings } from '../core/settings';
import { countAdmins } from '../core/auth';
import { createFirstAdmin } from './users';
import { requireValidLicense } from '../core/license';
import { featuresForEdition, productNameForEdition } from '../../shared/editions';
import type { ApiContext, Session } from '../api/context';

export function getSetupStatus(db: Database, license: LicenseStatus): SetupStatus {
  const adminConfigured = countAdmins(db, false) > 0;
  const storeConfigured = isStoreConfigured(db);
  const licensed = license.state === 'VALID' || license.state === 'EXPIRING';
  return {
    licensed,
    storeConfigured,
    adminConfigured,
    setupRequired: licensed && (!storeConfigured || !adminConfigured)
  };
}

export interface CompleteSetupInput {
  storeName: string;
  storeAddress: string;
  storePhone: string;
  receiptFooter?: string;
  adminUsername: string;
  adminFullName: string;
  adminPassword: string;
}

export function completeSetup(
  db: Database,
  input: CompleteSetupInput,
  license: LicenseStatus
): SetupStatus {
  requireValidLicense(db);
  if (countAdmins(db, false) > 0) {
    throw new AppError('CONFLICT', 'Setup has already been completed. Sign in to change settings.');
  }
  if (!input.storeName?.trim()) throw validation('Store name is required.');
  if (input.storeName.trim().length > 120) throw validation('Store name is too long.');

  db.transaction(() => {
    setSettings(db, {
      storeName: input.storeName.trim(),
      storeAddress: input.storeAddress.trim(),
      storePhone: input.storePhone.trim(),
      receiptFooter: input.receiptFooter?.trim() || 'Thank you for your patronage.'
    });
    createFirstAdmin(db, {
      username: input.adminUsername,
      fullName: input.adminFullName,
      password: input.adminPassword
    });
    audit(db, {
      action: 'setup.complete',
      entity: 'settings',
      entityId: 'store',
      username: input.adminUsername,
      severity: 'SECURITY',
      details: {
        storeName: input.storeName.trim(),
        edition: license.edition,
        admin: input.adminUsername,
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
    version: ctx.version
  };
}

export function getStore(db: Database) {
  return getStoreProfile(db);
}
