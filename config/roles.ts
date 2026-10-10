/** Roles, tenants and the test accounts the review uses. Account passwords are supplied via environment. */

export const ROLES = ['executive', 'operations_manager', 'sales_manager', 'intake', 'rep'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  executive: 'Executive',
  operations_manager: 'Operations manager',
  sales_manager: 'Sales manager',
  intake: 'Intake',
  rep: 'Rep',
};

export interface TenantRef {
  /** Harness-side label. The real identifier is discovered at baseline. */
  key: string;
  slug: string;
}

export const TENANTS: TenantRef[] = [
  { key: 'A', slug: 'harbor-ridge' },
  { key: 'B', slug: 'juniper-valley' },
  { key: 'C', slug: 'lakeshore-meridian' },
];

/** The tenant the role matrix, sessions and module-denial stages run against. */
export const PRIMARY_TENANT = 'A';

/** Ordered attacker -> victim pairs for tenant-isolation checks. */
export const TENANT_PAIRS: Array<[attacker: string, victim: string]> = [
  ['A', 'B'],
  ['B', 'C'],
  ['C', 'A'],
];

export interface Account {
  tenant: string;
  role: Role;
  email: string;
  /** What the account is used for. */
  purpose: string;
}

const LOCAL_PART: Record<Role, string> = {
  executive: 'executive',
  operations_manager: 'ops.manager',
  sales_manager: 'sales.manager',
  intake: 'intake',
  rep: 'rep01',
};

function tenant(key: string): TenantRef {
  const found = TENANTS.find((t) => t.key === key);
  if (!found) throw new Error(`Unknown tenant key ${key}`);
  return found;
}

/** The primary test account for a role in a tenant. For reps this is the "subject" rep. */
export function account(tenantKey: string, role: Role): Account {
  return { tenant: tenantKey, role, email: `${LOCAL_PART[role]}@${tenant(tenantKey).slug}.example`, purpose: `primary ${role} account` };
}

/** A second rep in the same tenant, used as the "other rep" whose data the subject rep must not reach. */
export function otherRep(tenantKey: string): Account {
  return { tenant: tenantKey, role: 'rep', email: `rep02@${tenant(tenantKey).slug}.example`, purpose: 'other rep (peer of the subject rep)' };
}

/** A rep reserved for destructive session and administration tests, so shared credentials are not disturbed. */
export function spareRep(tenantKey: string): Account {
  return { tenant: tenantKey, role: 'rep', email: `rep03@${tenant(tenantKey).slug}.example`, purpose: 'spare rep for revocation and administration tests' };
}

export function allAccounts(): Account[] {
  return TENANTS.flatMap((t) => [...ROLES.map((role) => account(t.key, role)), otherRep(t.key), spareRep(t.key)]);
}

export function tenantSlug(key: string): string {
  return tenant(key).slug;
}
