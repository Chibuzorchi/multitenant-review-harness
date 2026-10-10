/**
 * Finding classes and the severity rubric. Severity is assigned by class, on a
 * five-level qualitative scale. It is not a CVSS score and is never presented
 * as one.
 */

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = ['baseline', 'role-boundary', 'session-management', 'tenant-isolation', 'module-denial', 'reconciliation', 'scheduled-work', 'containment'] as const;
export type Category = (typeof CATEGORIES)[number];

export const FINDING_STATUSES = ['OPEN', 'FIXED_PENDING_RETEST', 'VERIFIED_FIXED', 'PARTIALLY_FIXED', 'NOT_FIXED', 'REGRESSION'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

export const SEVERITY_RUBRIC: Record<Severity, string> = {
  Critical: 'Data crosses a tenant boundary, or the system causes an uncontrolled real-world side effect. Blocks release.',
  High: 'A role, session or disabled-module control can be bypassed inside a tenant. Blocks release.',
  Medium: 'Business figures or background work are wrong or unreliable, with no direct loss of confidentiality.',
  Low: 'A defence-in-depth or consistency gap with limited practical impact.',
  Informational: 'An observation recorded for completeness. No action required for release.',
};

/** Open findings at these severities block the release. */
export const RELEASE_BLOCKING: Severity[] = ['Critical', 'High'];

export interface FindingClass {
  category: Category;
  severity: Severity;
  securityImpact: string;
  businessImpact: string;
}

export const CLASSES = {
  baselineMismatch: {
    category: 'baseline',
    severity: 'High',
    securityImpact: 'The environment under review is not the one the review was scoped for, so no result from it can be relied on.',
    businessImpact: 'A release decision made on this run would not describe the build that ships.',
  },
  crossTenantRead: {
    category: 'tenant-isolation',
    severity: 'Critical',
    securityImpact: 'An authenticated user of one tenant can read records that belong to a different tenant by changing an identifier.',
    businessImpact: 'One customer can see another customer\'s commercial relationships. This is a reportable breach of tenant confidentiality and of the customer contract.',
  },
  crossTenantWrite: {
    category: 'tenant-isolation',
    severity: 'Critical',
    securityImpact: 'An authenticated user of one tenant can create or change records in, or linked to, a different tenant.',
    businessImpact: 'One customer can corrupt or disrupt another customer\'s data and operations.',
  },
  roleBoundaryRead: {
    category: 'role-boundary',
    severity: 'High',
    securityImpact: 'A role can read data the permission model denies it. The restriction exists in the interface but is not enforced by the server.',
    businessImpact: 'Staff can see colleagues\' accounts and pipeline, which undermines territory ownership and commission integrity, and breaks the access promises made to the customer.',
  },
  roleBoundaryWrite: {
    category: 'role-boundary',
    severity: 'High',
    securityImpact: 'A role can perform a change the permission model denies it.',
    businessImpact: 'Records can be altered by staff who are not accountable for them, and administrative separation of duties is lost.',
  },
  roleOverRestricted: {
    category: 'role-boundary',
    severity: 'Medium',
    securityImpact: 'No loss of confidentiality: a role is denied an operation the permission model grants it.',
    businessImpact: 'Staff cannot do part of their job in the product, which drives workarounds outside it.',
  },
  roleIndeterminate: {
    category: 'role-boundary',
    severity: 'Low',
    securityImpact: 'The server answered a permission probe with neither a clear grant nor a clear denial, so the control could not be confirmed.',
    businessImpact: 'The permission cannot be signed off until the response is understood.',
  },
  navigationMismatch: {
    category: 'role-boundary',
    severity: 'Low',
    securityImpact: 'Navigation shown to a role does not match what the role may use. The server remains the control.',
    businessImpact: 'Users are shown functions they cannot use, or cannot find functions they may use.',
  },
  sessionLifecycle: {
    category: 'session-management',
    severity: 'High',
    securityImpact: 'A credential remains usable after the point at which the system says it has ended.',
    businessImpact: 'Access cannot be reliably withdrawn from a departing employee, a lost device or a leaked credential.',
  },
  unauthenticatedAccess: {
    category: 'session-management',
    severity: 'Critical',
    securityImpact: 'A protected resource is served without a valid credential.',
    businessImpact: 'Customer data is exposed to anyone who can reach the application.',
  },
  persistence: {
    category: 'session-management',
    severity: 'Medium',
    securityImpact: 'No direct security impact: saved work or a valid session is not preserved as expected.',
    businessImpact: 'Users lose work or are signed out unexpectedly.',
  },
  moduleDenial: {
    category: 'module-denial',
    severity: 'High',
    securityImpact: 'Functionality behind a disabled feature flag is reachable or executes. For a module that is switched off because it is not yet approved to hold regulated data, the switch is the control.',
    businessImpact: 'The business cannot state that the unapproved module is inert in production, which is the basis on which the release is being approved.',
  },
  reconciliation: {
    category: 'reconciliation',
    severity: 'Medium',
    securityImpact: 'No confidentiality impact: a reported figure does not match the records it is calculated from.',
    businessImpact: 'Managers act on wrong numbers. Activity credited to the wrong period distorts performance reviews, targets and commission.',
  },
  scheduledWork: {
    category: 'scheduled-work',
    severity: 'Medium',
    securityImpact: 'Background work is not safe to repeat, overlap or recover, which can duplicate or lose records.',
    businessImpact: 'Duplicate referrals, missing aggregates or repeated notifications reach customers and staff.',
  },
  uncontainedOutbound: {
    category: 'containment',
    severity: 'Critical',
    securityImpact: 'The system under review produced an external side effect that the test did not intend, or attempted to reach a host outside the review environment.',
    businessImpact: 'Testing could message, bill or advertise to real people, or leak data to a third party.',
  },
  outboundRecord: {
    category: 'containment',
    severity: 'Medium',
    securityImpact: 'Outbound activity is not fully recorded, so it cannot be audited.',
    businessImpact: 'The business cannot show what was, or was not, sent on its behalf.',
  },
} as const satisfies Record<string, FindingClass>;

export const STAGES = [
  { id: '01-baseline', title: 'Baseline', purpose: 'Fix the build, data and environment under review, and prove the harness can see it.' },
  { id: '02-role-matrix', title: 'Role matrix', purpose: 'Every role against every operation, through the UI and directly against the API.' },
  { id: '03-sessions', title: 'Sessions and tokens', purpose: 'Login, logout, expiry, revocation, stale state and persistence.' },
  { id: '04-tenant-isolation', title: 'Tenant isolation', purpose: 'Every way an identifier can be supplied, tried across tenants.' },
  { id: '05-module-denial', title: 'Patient-module denial', purpose: 'Server-side denial of the disabled module, including queued work.' },
  { id: '06-reconciliation', title: 'Reconciliation', purpose: 'Reported totals recalculated independently from source rows.' },
  { id: '07-scheduled', title: 'Scheduled work', purpose: 'Single, duplicate, overlapping, interrupted, retried and missed runs.' },
  { id: '08-containment', title: 'Containment', purpose: 'Nothing leaves the environment; every outbound action lands in the local sink.' },
  { id: '09-report', title: 'Report', purpose: 'Evidence collation, finding records and the release report.' },
] as const;

export type StageId = (typeof STAGES)[number]['id'];
