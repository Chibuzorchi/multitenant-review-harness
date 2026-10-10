import { ROLES, type Role } from './roles';

/**
 * The INTENDED permission model, as agreed with the product owner. This file is
 * the specification the review tests against; it is not derived from the
 * application. Each key lists the roles that must be allowed. Every role not
 * listed must be denied, and the denial must be enforced by the server.
 */

const ALL: readonly Role[] = ROLES;
const MANAGERS: readonly Role[] = ['executive', 'operations_manager', 'sales_manager'];
const NOT_REP: readonly Role[] = ['executive', 'operations_manager', 'sales_manager', 'intake'];
const REFERRAL_WRITERS: readonly Role[] = ['executive', 'operations_manager', 'intake'];
const FIELD: readonly Role[] = ['executive', 'operations_manager', 'sales_manager', 'rep'];
const NONE: readonly Role[] = [];

export const PERMISSIONS = {
  // Referral sources. A rep works only with the sources they own.
  'sources.read_own': ALL,
  'sources.read_other_rep': NOT_REP,
  'sources.write_own': FIELD,
  'sources.write_other_rep': MANAGERS,

  // Activities. A rep sees and logs only their own; intake has no activity access.
  'activities.read_own': FIELD,
  'activities.read_other_rep': MANAGERS,
  'activities.write_own': FIELD,
  'activities.write_other_rep': MANAGERS,

  // Referrals and admissions. A rep sees only referrals assigned to them.
  'referrals.read_assigned': ALL,
  'referrals.read_all': NOT_REP,
  'referrals.write': REFERRAL_WRITERS,
  'admissions.read': NOT_REP,
  'admissions.write': REFERRAL_WRITERS,

  // Reporting and exports: team reporting for managers only.
  'reports.read': MANAGERS,
  'exports.read': MANAGERS,

  // Administration.
  'users.read': MANAGERS,
  'users.admin': ['executive'],

  // Actions with external side effects.
  'outreach.send': MANAGERS,
  'billing.charge': ['executive', 'operations_manager'],

  // Patient module: no role has access while the module flag is OFF.
  'patients.any_while_disabled': NONE,
} as const satisfies Record<string, readonly Role[]>;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Decision = 'allowed' | 'denied';

export function expectedDecision(role: Role, permission: PermissionKey): Decision {
  return (PERMISSIONS[permission] as readonly Role[]).includes(role) ? 'allowed' : 'denied';
}

export function rolesWith(permission: PermissionKey): Role[] {
  return [...(PERMISSIONS[permission] as readonly Role[])];
}

/** Rules that hold for every role and are tested by their own stages. */
export const GLOBAL_RULES = [
  { id: 'GR-1', rule: 'No user can read or change data belonging to another tenant.', stage: '04-tenant-isolation' },
  { id: 'GR-2', rule: 'No role can reach the patient module while its feature flag is OFF.', stage: '05-module-denial' },
  { id: 'GR-3', rule: 'Authorization is decided by the server. Hiding a control in the UI is not a control.', stage: '02-role-matrix' },
] as const;
