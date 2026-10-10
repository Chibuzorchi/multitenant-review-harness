import type { PermissionKey } from './permissions';

/**
 * Route catalogue for the target application. Stages 02-05 are driven by this
 * file: to point the harness at another application, replace these entries
 * (and the permission model) rather than the test code.
 */

/** Concrete identifiers resolved at run time from the seeded data. */
export interface Subjects {
  tenantId: number;
  /** The account performing the operation. */
  actor: { id: number; email: string };
  /** "Own" resources belong to the subject rep; "other" resources belong to a peer rep in the same tenant. */
  subjectRep: { id: number };
  otherRep: { id: number };
  spareRep: { id: number };
  ownSourceId: number;
  otherSourceId: number;
  otherSourceName: string;
  ownActivityId: number;
  otherActivityId: number;
  assignedReferralId: number;
  otherReferralId: number;
  /** An accepted referral with no admission yet, reserved for this actor. */
  admittableReferralId: number;
  /** Unique per actor, for records the operation creates. */
  unique: string;
}

type Rows = { rows?: Array<Record<string, unknown>> };
const rows = (body: unknown): Array<Record<string, unknown>> => (body as Rows)?.rows ?? [];

export interface ApiProbe {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: (s: Subjects) => string;
  body?: (s: Subjects) => unknown;
  /**
   * For operations where a 2xx alone does not prove access (a list that is
   * silently scoped), returns true only when the response contains the data
   * the permission protects.
   */
  proves?: (body: unknown, s: Subjects) => boolean;
}

export interface UiProbe {
  path: (s: Subjects) => string;
  /** Value of main[data-page] when the page is served. */
  page: string;
  /** Selector that is present only when the protected data is rendered. */
  proves?: (s: Subjects) => string;
}

export interface Operation {
  id: string;
  label: string;
  /** Display form of the route, used in the role matrix. */
  route: string;
  permission: PermissionKey;
  api?: ApiProbe;
  ui?: UiProbe;
  /** Outbound events the operation emits when it is allowed. */
  outbound?: number;
  /** Also request the API route by direct navigation in a signed-in browser. */
  browserDirect?: boolean;
}

const ACTIVITY_DATE = '2026-09-15';

export const OPERATIONS: Operation[] = [
  // ------------------------------------------------------------ referral sources
  {
    id: 'sources.list',
    label: 'List referral sources',
    route: 'GET /api/referral-sources',
    permission: 'sources.read_own',
    api: { method: 'GET', path: () => '/api/referral-sources' },
    ui: { path: () => '/referral-sources', page: 'referral-sources' },
  },
  {
    id: 'sources.read_own',
    label: 'Read a referral source owned by the subject rep',
    route: 'GET /api/referral-sources/:id',
    permission: 'sources.read_own',
    api: { method: 'GET', path: (s) => `/api/referral-sources/${s.ownSourceId}` },
    ui: { path: (s) => `/referral-sources/${s.ownSourceId}`, page: 'referral-source' },
  },
  {
    id: 'sources.read_other_rep',
    label: "Read another rep's referral source",
    route: 'GET /api/referral-sources/:id',
    permission: 'sources.read_other_rep',
    api: { method: 'GET', path: (s) => `/api/referral-sources/${s.otherSourceId}` },
    ui: { path: (s) => `/referral-sources/${s.otherSourceId}`, page: 'referral-source' },
    browserDirect: true,
  },
  {
    id: 'sources.list_other_rep',
    label: "List another rep's referral sources by filter",
    route: 'GET /api/referral-sources?owner_rep_id=:rep',
    permission: 'sources.read_other_rep',
    api: {
      method: 'GET',
      path: (s) => `/api/referral-sources?owner_rep_id=${s.otherRep.id}`,
      proves: (body, s) => rows(body).some((row) => row.owner_rep_id === s.otherRep.id),
    },
    ui: { path: () => '/referral-sources', page: 'referral-sources', proves: (s) => `tr[data-owner-rep-id="${s.otherRep.id}"]` },
  },
  {
    id: 'sources.search_other_rep',
    label: "Find another rep's referral source through search",
    route: 'GET /api/search?q=:name',
    permission: 'sources.read_other_rep',
    api: {
      method: 'GET',
      path: (s) => `/api/search?q=${encodeURIComponent(s.otherSourceName)}`,
      proves: (body, s) => rows(body).some((row) => row.id === s.otherSourceId),
    },
    ui: { path: (s) => `/referral-sources?q=${encodeURIComponent(s.otherSourceName)}`, page: 'referral-sources', proves: (s) => `tr[data-id="${s.otherSourceId}"]` },
  },
  {
    id: 'sources.create_own',
    label: 'Create a referral source',
    route: 'POST /api/referral-sources',
    permission: 'sources.write_own',
    api: {
      method: 'POST',
      path: () => '/api/referral-sources',
      body: (s) => ({ business_name: `Matrix Probe ${s.unique} (fictional)`, business_type: 'clinic', address: '1 Probe Lane, Nowhere, ZZ 00000', owner_rep_id: s.subjectRep.id }),
    },
  },
  {
    id: 'sources.update_own',
    label: 'Update a referral source owned by the subject rep',
    route: 'PATCH /api/referral-sources/:id',
    permission: 'sources.write_own',
    api: { method: 'PATCH', path: (s) => `/api/referral-sources/${s.ownSourceId}`, body: (s) => ({ address: `2 Probe Lane ${s.unique}, Nowhere, ZZ 00000` }) },
  },
  {
    id: 'sources.update_other_rep',
    label: "Update another rep's referral source",
    route: 'PATCH /api/referral-sources/:id',
    permission: 'sources.write_other_rep',
    api: { method: 'PATCH', path: (s) => `/api/referral-sources/${s.otherSourceId}`, body: (s) => ({ address: `3 Probe Lane ${s.unique}, Nowhere, ZZ 00000` }) },
  },

  // ------------------------------------------------------------ activities
  {
    id: 'activities.list_own',
    label: "List the subject rep's activities",
    route: 'GET /api/activities?rep_id=:self',
    permission: 'activities.read_own',
    api: {
      method: 'GET',
      path: (s) => `/api/activities?rep_id=${s.subjectRep.id}`,
      proves: (body, s) => rows(body).some((row) => row.rep_id === s.subjectRep.id),
    },
    ui: { path: () => '/activities', page: 'activities' },
  },
  {
    id: 'activities.list_other_rep',
    label: "List another rep's activities by filter",
    route: 'GET /api/activities?rep_id=:other_rep',
    permission: 'activities.read_other_rep',
    api: {
      method: 'GET',
      path: (s) => `/api/activities?rep_id=${s.otherRep.id}`,
      proves: (body, s) => rows(body).some((row) => row.rep_id === s.otherRep.id),
    },
    ui: { path: (s) => `/activities?rep_id=${s.otherRep.id}`, page: 'activities', proves: (s) => `tr[data-rep-id="${s.otherRep.id}"]` },
    browserDirect: true,
  },
  {
    id: 'activities.read_other_rep',
    label: "Read another rep's activity by id",
    route: 'GET /api/activities/:id',
    permission: 'activities.read_other_rep',
    api: { method: 'GET', path: (s) => `/api/activities/${s.otherActivityId}` },
    browserDirect: true,
  },
  {
    id: 'activities.read_own',
    label: "Read the subject rep's activity by id",
    route: 'GET /api/activities/:id',
    permission: 'activities.read_own',
    api: { method: 'GET', path: (s) => `/api/activities/${s.ownActivityId}` },
  },
  {
    id: 'activities.by_source_other_rep',
    label: "List activities under another rep's referral source",
    route: 'GET /api/referral-sources/:id/activities',
    permission: 'activities.read_other_rep',
    api: { method: 'GET', path: (s) => `/api/referral-sources/${s.otherSourceId}/activities` },
    ui: { path: (s) => `/referral-sources/${s.otherSourceId}`, page: 'referral-source', proves: () => 'table[data-testid="activity-table"]' },
  },
  {
    id: 'activities.create_own',
    label: "Log an activity on the subject rep's referral source",
    route: 'POST /api/activities',
    permission: 'activities.write_own',
    api: {
      method: 'POST',
      path: () => '/api/activities',
      body: (s) => ({ referral_source_id: s.ownSourceId, activity_type: 'note', activity_date: ACTIVITY_DATE, notes: `matrix probe ${s.unique}` }),
    },
  },
  {
    id: 'activities.create_other_rep',
    label: "Log an activity on another rep's referral source",
    route: 'POST /api/activities',
    permission: 'activities.write_other_rep',
    api: {
      method: 'POST',
      path: () => '/api/activities',
      body: (s) => ({ referral_source_id: s.otherSourceId, activity_type: 'note', activity_date: ACTIVITY_DATE, notes: `matrix probe ${s.unique}` }),
    },
  },
  {
    id: 'activities.create_as_other_rep',
    label: 'Log an activity attributed to another rep',
    route: 'POST /api/activities (rep_id in body)',
    permission: 'activities.write_other_rep',
    api: {
      method: 'POST',
      path: () => '/api/activities',
      body: (s) => ({ referral_source_id: s.otherSourceId, rep_id: s.otherRep.id, activity_type: 'call', activity_date: ACTIVITY_DATE, notes: `matrix probe ${s.unique}` }),
    },
  },

  // ------------------------------------------------------------ referrals and admissions
  {
    id: 'referrals.list_all',
    label: 'List referrals assigned to other reps',
    route: 'GET /api/referrals',
    permission: 'referrals.read_all',
    api: {
      method: 'GET',
      path: (s) => `/api/referrals?assigned_rep_id=${s.otherRep.id}`,
      proves: (body, s) => rows(body).some((row) => row.assigned_rep_id === s.otherRep.id),
    },
    ui: { path: () => '/referrals', page: 'referrals', proves: (s) => `tr[data-rep-id="${s.otherRep.id}"]` },
  },
  {
    id: 'referrals.read_assigned',
    label: 'Read a referral assigned to the subject rep',
    route: 'GET /api/referrals/:id',
    permission: 'referrals.read_assigned',
    api: { method: 'GET', path: (s) => `/api/referrals/${s.assignedReferralId}` },
    ui: { path: (s) => `/referrals/${s.assignedReferralId}`, page: 'referral' },
  },
  {
    id: 'referrals.read_other_rep',
    label: 'Read a referral assigned to another rep',
    route: 'GET /api/referrals/:id',
    permission: 'referrals.read_all',
    api: { method: 'GET', path: (s) => `/api/referrals/${s.otherReferralId}` },
    ui: { path: (s) => `/referrals/${s.otherReferralId}`, page: 'referral' },
    browserDirect: true,
  },
  {
    id: 'referrals.update_status',
    label: 'Change a referral status',
    route: 'PATCH /api/referrals/:id',
    permission: 'referrals.write',
    api: { method: 'PATCH', path: (s) => `/api/referrals/${s.assignedReferralId}`, body: () => ({ status: 'in_review' }) },
    ui: { path: (s) => `/referrals/${s.assignedReferralId}`, page: 'referral', proves: () => 'form[data-testid="status-form"]' },
  },
  {
    id: 'referrals.create',
    label: 'Record a new referral',
    route: 'POST /api/referrals',
    permission: 'referrals.write',
    api: { method: 'POST', path: () => '/api/referrals', body: (s) => ({ referral_source_id: s.ownSourceId }) },
  },
  {
    id: 'admissions.list',
    label: 'List admissions',
    route: 'GET /api/admissions',
    permission: 'admissions.read',
    api: { method: 'GET', path: () => '/api/admissions' },
  },
  {
    id: 'admissions.create',
    label: 'Record an admission',
    route: 'POST /api/admissions',
    permission: 'admissions.write',
    api: { method: 'POST', path: () => '/api/admissions', body: (s) => ({ referral_id: s.admittableReferralId }) },
    outbound: 1,
  },

  // ------------------------------------------------------------ reports and exports
  ...(['summary', 'weekly', 'monthly', 'by-rep', 'by-source'] as const).map(
    (name): Operation => ({
      id: `reports.${name}`,
      label: `View the ${name} report`,
      route: `GET /api/reports/${name}`,
      permission: 'reports.read',
      api: { method: 'GET', path: () => `/api/reports/${name}` },
      ...(name === 'summary' ? { ui: { path: () => '/reports', page: 'reports' }, browserDirect: true } : {}),
    }),
  ),
  {
    id: 'exports.activities',
    label: 'Export activities as CSV',
    route: 'GET /api/export/activities.csv',
    permission: 'exports.read',
    api: { method: 'GET', path: () => '/api/export/activities.csv' },
    browserDirect: false,
  },
  {
    id: 'exports.referrals',
    label: 'Export referrals as CSV',
    route: 'GET /api/export/referrals.csv',
    permission: 'exports.read',
    api: { method: 'GET', path: () => '/api/export/referrals.csv' },
  },

  // ------------------------------------------------------------ user administration
  {
    id: 'users.list',
    label: 'List users',
    route: 'GET /api/users',
    permission: 'users.read',
    api: { method: 'GET', path: () => '/api/users' },
    browserDirect: true,
  },
  {
    id: 'users.admin_page',
    label: 'Open the user administration page',
    route: 'GET /admin/users',
    permission: 'users.admin',
    ui: { path: () => '/admin/users', page: 'admin-users' },
  },
  {
    id: 'users.create',
    label: 'Create a user',
    route: 'POST /api/users',
    permission: 'users.admin',
    api: { method: 'POST', path: () => '/api/users', body: (s) => ({ email: `probe-${s.unique}@matrix-probe.example`, name: 'Matrix Probe', role: 'rep' }) },
  },
  {
    id: 'users.update',
    label: "Change another user's role",
    route: 'PATCH /api/users/:id',
    permission: 'users.admin',
    api: { method: 'PATCH', path: (s) => `/api/users/${s.spareRep.id}`, body: () => ({ name: 'Renamed By Matrix Probe' }) },
  },
  {
    id: 'users.escalate_self',
    label: 'Escalate own role',
    route: 'PATCH /api/users/:self',
    permission: 'users.admin',
    api: { method: 'PATCH', path: (s) => `/api/users/${s.actor.id}`, body: () => ({ role: 'executive' }) },
  },
  {
    id: 'users.revoke_sessions',
    label: "Revoke another user's sessions",
    route: 'POST /api/users/:id/revoke-sessions',
    permission: 'users.admin',
    api: { method: 'POST', path: (s) => `/api/users/${s.spareRep.id}/revoke-sessions` },
  },

  // ------------------------------------------------------------ actions with external side effects
  {
    id: 'outreach.campaign',
    label: 'Send an outreach campaign',
    route: 'POST /api/outreach/campaigns',
    permission: 'outreach.send',
    api: { method: 'POST', path: () => '/api/outreach/campaigns', body: () => ({ channel: 'advertisement', message: 'matrix probe', audience: 'referral-sources' }) },
    outbound: 1,
  },
  {
    id: 'billing.charge',
    label: 'Create a charge',
    route: 'POST /api/billing/charges',
    permission: 'billing.charge',
    api: { method: 'POST', path: () => '/api/billing/charges', body: () => ({ amount_cents: 100, description: 'matrix probe' }) },
    outbound: 1,
  },

  // ------------------------------------------------------------ patient module (flag OFF during the matrix)
  {
    id: 'patients.list',
    label: 'List patient records (module disabled)',
    route: 'GET /api/patients',
    permission: 'patients.any_while_disabled',
    api: { method: 'GET', path: () => '/api/patients' },
    ui: { path: () => '/patients', page: 'patients' },
  },
  {
    id: 'patients.sync',
    label: 'Queue a patient sync (module disabled)',
    route: 'POST /api/jobs/patient-sync',
    permission: 'patients.any_while_disabled',
    api: { method: 'POST', path: () => '/api/jobs/patient-sync' },
  },
];

/** Navigation entries whose visibility must match the permission model. */
export const NAVIGATION: Array<{ label: string; href: string; permission: PermissionKey }> = [
  { label: 'Activities', href: '/activities', permission: 'activities.read_own' },
  { label: 'Reports', href: '/reports', permission: 'reports.read' },
  { label: 'Users', href: '/admin/users', permission: 'users.admin' },
  { label: 'Patients', href: '/patients', permission: 'patients.any_while_disabled' },
];

/** Routes that must reject requests carrying no, expired or revoked credentials. */
export const PROTECTED_API_ROUTES = [
  '/api/me',
  '/api/referral-sources',
  '/api/activities',
  '/api/referrals',
  '/api/admissions',
  '/api/reports/summary',
  '/api/reports/monthly',
  '/api/export/activities.csv',
  '/api/users',
  '/api/search?q=a',
  '/api/patients',
];

export const PROTECTED_UI_ROUTES = ['/', '/referral-sources', '/activities', '/referrals', '/reports', '/admin/users', '/patients'];

export const UI = {
  loginPath: '/login',
  pageSelector: 'main[data-page]',
  pageAttribute: 'data-page',
  deniedPages: ['forbidden', 'not-found', 'feature-disabled', 'login'],
  navSelector: 'nav[aria-label="Main"] a',
} as const;

/** Identifiers of a victim tenant, resolved at run time, used by the tenant-isolation probes. */
export interface Victim {
  tenantId: number;
  sourceId: number;
  sourceName: string;
  sourceIds: number[];
  repId: number;
  activityId: number;
  referralId: number;
  acceptedReferralId: number;
  admissionId: number;
  userId: number;
  userEmail: string;
}

/** Identifiers in the attacker's own tenant that body probes combine with victim identifiers. */
export interface Attacker {
  tenantId: number;
  ownSourceId: number;
}

export type IsolationVector = 'url-path-id' | 'nested-id' | 'query-parameter' | 'request-body' | 'search' | 'list-filter' | 'export' | 'entity-id-sweep';

export interface IsolationProbe {
  id: string;
  /** Finding key suffix: probes against the same route share it. */
  route: string;
  vector: IsolationVector;
  label: string;
  method: 'GET' | 'POST' | 'PATCH';
  path: (v: Victim, a: Attacker) => string;
  body?: (v: Victim, a: Attacker) => unknown;
  /** True when the response discloses victim-tenant data. A denial status is not enough on its own for lists. */
  leaks: (body: unknown, text: string, v: Victim) => boolean;
  /** A write probe: on top of the response, the database is checked for cross-tenant effects. */
  write?: 'activities' | 'referrals' | 'admissions' | 'referral_sources' | 'users' | 'sessions';
}

const anyRowOfTenant = (body: unknown, v: Victim) => rows(body).some((row) => row.tenant_id === v.tenantId);
const rowLeak = (body: unknown, _text: string, v: Victim) => anyRowOfTenant(body, v);
const objectOfTenant = (body: unknown, v: Victim) => (body as { tenant_id?: unknown } | null)?.tenant_id === v.tenantId;

export const ISOLATION_PROBES: IsolationProbe[] = [
  // URL path identifiers
  { id: 'path.source', route: 'GET /api/referral-sources/:id', vector: 'url-path-id', label: 'Referral source detail by foreign id', method: 'GET', path: (v) => `/api/referral-sources/${v.sourceId}`, leaks: (b, t, v) => objectOfTenant(b, v) || t.includes(v.sourceName) },
  { id: 'path.activity', route: 'GET /api/activities/:id', vector: 'url-path-id', label: 'Activity detail by foreign id', method: 'GET', path: (v) => `/api/activities/${v.activityId}`, leaks: (b, _t, v) => objectOfTenant(b, v) },
  { id: 'path.referral', route: 'GET /api/referrals/:id', vector: 'url-path-id', label: 'Referral detail by foreign id', method: 'GET', path: (v) => `/api/referrals/${v.referralId}`, leaks: (b, _t, v) => objectOfTenant(b, v) },
  { id: 'path.admission', route: 'GET /api/admissions/:id', vector: 'url-path-id', label: 'Admission detail by foreign id', method: 'GET', path: (v) => `/api/admissions/${v.admissionId}`, leaks: (b, _t, v) => objectOfTenant(b, v) },
  { id: 'path.user', route: 'GET /api/users/:id', vector: 'url-path-id', label: 'User detail by foreign id', method: 'GET', path: (v) => `/api/users/${v.userId}`, leaks: (b, t, v) => objectOfTenant(b, v) || t.includes(v.userEmail) },

  // Nested identifiers
  { id: 'nested.source_activities', route: 'GET /api/referral-sources/:id/activities', vector: 'nested-id', label: 'Activities nested under a foreign referral source', method: 'GET', path: (v) => `/api/referral-sources/${v.sourceId}/activities`, leaks: rowLeak },

  // Query parameters
  { id: 'query.activities_rep', route: 'GET /api/activities', vector: 'query-parameter', label: 'Activities filtered by a foreign rep id', method: 'GET', path: (v) => `/api/activities?rep_id=${v.repId}`, leaks: rowLeak },
  { id: 'query.activities_source', route: 'GET /api/activities', vector: 'query-parameter', label: 'Activities filtered by a foreign source id', method: 'GET', path: (v) => `/api/activities?referral_source_id=${v.sourceId}`, leaks: rowLeak },
  { id: 'query.referrals_source', route: 'GET /api/referrals', vector: 'query-parameter', label: 'Referrals filtered by a foreign source id', method: 'GET', path: (v) => `/api/referrals?referral_source_id=${v.sourceId}`, leaks: rowLeak },
  { id: 'query.referrals_rep', route: 'GET /api/referrals', vector: 'query-parameter', label: 'Referrals filtered by a foreign rep id', method: 'GET', path: (v) => `/api/referrals?assigned_rep_id=${v.repId}`, leaks: rowLeak },
  { id: 'query.sources_owner', route: 'GET /api/referral-sources', vector: 'query-parameter', label: 'Referral sources filtered by a foreign owner id', method: 'GET', path: (v) => `/api/referral-sources?owner_rep_id=${v.repId}`, leaks: rowLeak },
  { id: 'query.tenant_override', route: 'GET /api/referral-sources', vector: 'query-parameter', label: 'Tenant id supplied as a query parameter', method: 'GET', path: (v) => `/api/referral-sources?tenant_id=${v.tenantId}`, leaks: rowLeak },

  // Request bodies
  { id: 'body.activity_source', route: 'POST /api/activities', vector: 'request-body', label: 'Activity created against a foreign source id', method: 'POST', path: () => '/api/activities', body: (v) => ({ referral_source_id: v.sourceId, activity_type: 'note', activity_date: ACTIVITY_DATE, notes: 'isolation probe' }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'activities' },
  { id: 'body.activity_rep', route: 'POST /api/activities', vector: 'request-body', label: 'Activity created on own source attributed to a foreign rep', method: 'POST', path: () => '/api/activities', body: (v, a) => ({ referral_source_id: a.ownSourceId, rep_id: v.repId, activity_type: 'note', activity_date: ACTIVITY_DATE, notes: 'isolation probe' }), leaks: (b, _t, v) => (b as { rep_id?: unknown } | null)?.rep_id === v.repId, write: 'activities' },
  { id: 'body.activity_tenant', route: 'POST /api/activities', vector: 'request-body', label: 'Activity created with a foreign tenant_id in the body', method: 'POST', path: () => '/api/activities', body: (v, a) => ({ tenant_id: v.tenantId, referral_source_id: a.ownSourceId, activity_type: 'note', activity_date: ACTIVITY_DATE, notes: 'isolation probe' }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'activities' },
  { id: 'body.referral_source', route: 'POST /api/referrals', vector: 'request-body', label: 'Referral created against a foreign source id', method: 'POST', path: () => '/api/referrals', body: (v) => ({ referral_source_id: v.sourceId }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'referrals' },
  { id: 'body.admission_referral', route: 'POST /api/admissions', vector: 'request-body', label: 'Admission created against a foreign referral id', method: 'POST', path: () => '/api/admissions', body: (v) => ({ referral_id: v.acceptedReferralId }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'admissions' },
  { id: 'body.source_owner', route: 'POST /api/referral-sources', vector: 'request-body', label: 'Referral source created with a foreign owner id', method: 'POST', path: () => '/api/referral-sources', body: (v) => ({ business_name: 'Isolation Probe (fictional)', business_type: 'clinic', address: '4 Probe Lane, Nowhere, ZZ 00000', owner_rep_id: v.repId }), leaks: (b, _t, v) => (b as { owner_rep_id?: unknown } | null)?.owner_rep_id === v.repId, write: 'referral_sources' },
  { id: 'body.source_update', route: 'PATCH /api/referral-sources/:id', vector: 'request-body', label: 'Foreign referral source updated', method: 'PATCH', path: (v) => `/api/referral-sources/${v.sourceId}`, body: () => ({ address: 'changed by isolation probe' }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'referral_sources' },
  { id: 'body.referral_update', route: 'PATCH /api/referrals/:id', vector: 'request-body', label: 'Foreign referral status changed', method: 'PATCH', path: (v) => `/api/referrals/${v.referralId}`, body: () => ({ status: 'declined' }), leaks: (b, _t, v) => objectOfTenant(b, v), write: 'referrals' },
  { id: 'body.user_update', route: 'PATCH /api/users/:id', vector: 'request-body', label: 'Foreign user modified', method: 'PATCH', path: (v) => `/api/users/${v.userId}`, body: () => ({ name: 'changed by isolation probe' }), leaks: (b, _t, v) => (b as { id?: unknown } | null)?.id === v.userId, write: 'users' },
  { id: 'body.user_revoke', route: 'POST /api/users/:id/revoke-sessions', vector: 'request-body', label: 'Foreign user sessions revoked', method: 'POST', path: (v) => `/api/users/${v.userId}/revoke-sessions`, leaks: (b) => (b as { ok?: unknown } | null)?.ok === true, write: 'sessions' },

  // Search
  { id: 'search.global', route: 'GET /api/search', vector: 'search', label: 'Search for a foreign business name', method: 'GET', path: (v) => `/api/search?q=${encodeURIComponent(v.sourceName)}`, leaks: (b, t, v) => anyRowOfTenant(b, v) || t.includes(v.sourceName) },
  { id: 'search.wildcard', route: 'GET /api/search', vector: 'search', label: 'Wildcard search', method: 'GET', path: () => '/api/search?q=%25', leaks: rowLeak },
  { id: 'search.sources_q', route: 'GET /api/referral-sources', vector: 'search', label: 'Source list search for a foreign business name', method: 'GET', path: (v) => `/api/referral-sources?q=${encodeURIComponent(v.sourceName)}`, leaks: (b, t, v) => anyRowOfTenant(b, v) || t.includes(v.sourceName) },

  // List filters
  ...(['referral-sources', 'activities', 'referrals', 'admissions', 'users'] as const).map(
    (name): IsolationProbe => ({ id: `list.${name}`, route: `GET /api/${name}`, vector: 'list-filter', label: `Unfiltered ${name} list`, method: 'GET', path: () => `/api/${name}`, leaks: rowLeak }),
  ),
  { id: 'list.report_by_source', route: 'GET /api/reports/by-source', vector: 'list-filter', label: 'Per-source report rows', method: 'GET', path: () => '/api/reports/by-source', leaks: (b, t, v) => rows(b).some((row) => v.sourceIds.includes(Number(row.referral_source_id))) || t.includes(v.sourceName) },
  { id: 'list.report_by_rep', route: 'GET /api/reports/by-rep', vector: 'list-filter', label: 'Per-rep report rows', method: 'GET', path: () => '/api/reports/by-rep', leaks: (b, _t, v) => rows(b).some((row) => row.rep_id === v.repId) },

  // Exports
  { id: 'export.activities', route: 'GET /api/export/activities.csv', vector: 'export', label: 'Activity export', method: 'GET', path: () => '/api/export/activities.csv', leaks: (_b, t, v) => csvHasTenant(t, v.tenantId) },
  { id: 'export.referrals', route: 'GET /api/export/referrals.csv', vector: 'export', label: 'Referral export', method: 'GET', path: () => '/api/export/referrals.csv', leaks: (_b, t, v) => csvHasTenant(t, v.tenantId) },
];

/** Detail routes swept with a range of foreign identifiers. */
export const ENTITY_SWEEP: Array<{ route: string; path: (id: number) => string; ids: (v: Victim) => number[] }> = [
  { route: 'GET /api/referral-sources/:id', path: (id) => `/api/referral-sources/${id}`, ids: (v) => v.sourceIds },
];

function csvHasTenant(text: string, tenantId: number): boolean {
  const [header, ...lines] = text.trim().split('\n');
  const index = (header ?? '').split(',').indexOf('tenant_id');
  return index >= 0 && lines.some((line) => line.split(',')[index] === String(tenantId));
}
