import type { Role } from './config';

/** Server-side authorization rules. Every route consults this; the UI only mirrors it. */

export type Capability =
  | 'sources.read_all'
  | 'sources.write'
  | 'sources.write_any'
  | 'activities.read'
  | 'activities.read_all'
  | 'activities.write'
  | 'activities.write_any'
  | 'referrals.read_all'
  | 'referrals.write'
  | 'admissions.read'
  | 'admissions.write'
  | 'reports.read'
  | 'exports.read'
  | 'users.read'
  | 'users.admin'
  | 'outreach.send'
  | 'billing.charge'
  | 'patients.access';

const MANAGER: Capability[] = [
  'sources.read_all',
  'sources.write',
  'sources.write_any',
  'activities.read',
  'activities.read_all',
  'activities.write',
  'activities.write_any',
  'referrals.read_all',
  'admissions.read',
  'reports.read',
  'exports.read',
  'users.read',
  'outreach.send',
];

const OPERATIONS: Capability[] = [...MANAGER, 'referrals.write', 'admissions.write', 'billing.charge', 'patients.access'];

const GRANTS: Record<Role, ReadonlySet<Capability>> = {
  rep: new Set<Capability>(['sources.write', 'activities.read', 'activities.write']),
  intake: new Set<Capability>(['sources.read_all', 'referrals.read_all', 'referrals.write', 'admissions.read', 'admissions.write', 'patients.access']),
  sales_manager: new Set(MANAGER),
  operations_manager: new Set(OPERATIONS),
  executive: new Set<Capability>([...OPERATIONS, 'users.admin']),
};

export function can(role: Role, capability: Capability): boolean {
  return GRANTS[role].has(capability);
}
