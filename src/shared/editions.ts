import type { Edition, FeatureFlags } from './types';

export const PRODUCT_NAMES: Record<Edition, string> = {
  PHARMACY: 'Infoflex Pharm',
  SUPERMARKET: 'Infoflex Mart',
  BOTH: 'Infoflex Pharm & Mart'
};

/** Fallback title used before a licence has been activated. */
export const UNLICENSED_PRODUCT_NAME = 'Infoflex';

export function productNameForEdition(edition: Edition | null | undefined): string {
  if (!edition) return UNLICENSED_PRODUCT_NAME;
  return PRODUCT_NAMES[edition] ?? UNLICENSED_PRODUCT_NAME;
}

/**
 * Feature flags derived from the (signed) licence edition. The main process is
 * the single source of truth: the sidebar and every IPC handler are gated from
 * these flags, never from renderer-side state.
 */
export function featuresForEdition(edition: Edition): FeatureFlags {
  const pharmacy = edition === 'PHARMACY' || edition === 'BOTH';
  const supermarket = edition === 'SUPERMARKET' || edition === 'BOTH';
  return {
    edition,
    pharmacy,
    supermarket,
    wholesale: true,
    prescriptions: pharmacy,
    itemLabel: pharmacy && !supermarket ? 'Drug' : supermarket && !pharmacy ? 'Product' : 'Item',
    productName: productNameForEdition(edition)
  };
}

export function isValidEdition(value: unknown): value is Edition {
  return value === 'PHARMACY' || value === 'SUPERMARKET' || value === 'BOTH';
}

/** Which roles exist for an edition. Supervisors are a supermarket concept. */
export function availableRoles(edition: Edition | null): Array<'ADMIN' | 'SUPERVISOR' | 'CASHIER'> {
  const roles: Array<'ADMIN' | 'SUPERVISOR' | 'CASHIER'> = ['ADMIN'];
  if (edition === 'SUPERMARKET' || edition === 'BOTH') roles.push('SUPERVISOR');
  roles.push('CASHIER');
  return roles;
}
