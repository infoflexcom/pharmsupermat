import type { Edition, Role } from './types';

/** Fine-grained permissions checked in the MAIN process on every call. */
export const PERMISSIONS = [
  'pos.sell',
  'wholesale.sell',
  'sales.view.own',
  'sales.view.all',
  'sales.void.request',
  'sales.void.approve',
  'sales.credit.collect',
  'returns.create',
  'returns.approve',
  'products.view',
  'products.manage',
  'prices.set',
  'prices.override',
  'stock.receive',
  'stock.adjust',
  'reports.view.own',
  'reports.view.all',
  'users.manage',
  'settings.manage',
  'backup.manage',
  'audit.view',
  'license.manage',
  'prescriptions.manage'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Everything an administrator can do (used by seeding, tests and the verifier). */
export const ALL_PERMISSIONS: Permission[] = [...PERMISSIONS];

const ADMIN_PERMISSIONS: Permission[] = [...PERMISSIONS];

const SUPERVISOR_PERMISSIONS: Permission[] = [
  'pos.sell',
  'wholesale.sell',
  'sales.view.own',
  'sales.view.all',
  'sales.void.request',
  'sales.void.approve',
  'sales.credit.collect',
  'returns.create',
  'returns.approve',
  'products.view',
  'prices.override',
  'stock.receive',
  'reports.view.own',
  'reports.view.all',
  'audit.view'
];

const CASHIER_PERMISSIONS: Permission[] = [
  'pos.sell',
  'sales.view.own',
  'sales.void.request',
  'returns.create',
  'products.view',
  'reports.view.own'
];

/**
 * Role -> permission mapping. Supervisors only exist on supermarket licences,
 * so a stray SUPERVISOR row on a pharmacy install gets no extra power.
 */
export function permissionsForRole(role: Role, edition: Edition | null): Permission[] {
  switch (role) {
    case 'ADMIN':
      return [...ADMIN_PERMISSIONS];
    case 'SUPERVISOR':
      return edition === 'SUPERMARKET' || edition === 'BOTH' ? [...SUPERVISOR_PERMISSIONS] : [];
    case 'CASHIER':
      return [...CASHIER_PERMISSIONS];
    default:
      return [];
  }
}

export function hasPermission(
  permissions: readonly string[],
  permission: Permission | undefined
): boolean {
  if (!permission) return true;
  return permissions.includes(permission);
}

/** Human readable role labels used in the UI and on printed documents. */
export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervisor',
  CASHIER: 'Cashier'
};
