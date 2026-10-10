/**
 * Feature flags under review and the surface each one gates. Stage 05 proves
 * that every entry here is denied by the server while the flag is OFF.
 */

export interface GatedRoute {
  id: string;
  kind: 'list' | 'detail' | 'import' | 'projection' | 'job' | 'webhook' | 'nested';
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface FeatureFlag {
  name: string;
  /** The state the release candidate must ship with. */
  requiredState: boolean;
  /** Status and machine-readable code the server must answer with while OFF. */
  denial: { status: number; code: string };
  apiRoutes: GatedRoute[];
  uiRoutes: string[];
  /** Navigation label that must not be rendered while OFF. */
  navLabel: string;
  /** Strings that only appear in responses carrying module data. */
  dataMarkers: string[];
  /** Background work belonging to the module. */
  queue: { enqueueRoute: string; workerJob: string };
}

export const PATIENT_MODULE: FeatureFlag = {
  name: 'patient_module',
  requiredState: false,
  denial: { status: 403, code: 'FEATURE_DISABLED' },
  apiRoutes: [
    { id: 'patients.list', kind: 'list', method: 'GET', path: '/api/patients' },
    { id: 'patients.detail', kind: 'detail', method: 'GET', path: '/api/patients/1' },
    { id: 'patients.by_referral', kind: 'nested', method: 'GET', path: '/api/referrals/1/patients' },
    { id: 'patients.import', kind: 'import', method: 'POST', path: '/api/patient-import', body: { records: [{ synthetic_ref: 'SYN-denial-probe-0001' }] } },
    { id: 'patients.projection', kind: 'projection', method: 'GET', path: '/api/patient-projection' },
    { id: 'patients.sync_job', kind: 'job', method: 'POST', path: '/api/jobs/patient-sync' },
    { id: 'patients.webhook', kind: 'webhook', method: 'POST', path: '/api/webhooks/patient' },
  ],
  uiRoutes: ['/patients', '/patients/1'],
  navLabel: 'Patients',
  dataMarkers: ['SYN-', 'synthetic_ref', 'patient_count'],
  queue: { enqueueRoute: '/api/jobs/patient-sync', workerJob: 'patient-projection-queue' },
};

export const FEATURE_FLAGS: FeatureFlag[] = [PATIENT_MODULE];

/** Request variations a client might use to slip past a route-level gate. */
export const BYPASS_VARIATIONS: Array<{ id: string; label: string; method?: string; rewrite?: (path: string) => string; headers?: Record<string, string> }> = [
  { id: 'trailing-slash', label: 'Trailing slash', rewrite: (p) => `${p}/` },
  { id: 'upper-case', label: 'Upper-cased path', rewrite: (p) => p.replace(/patients?/g, (m) => m.toUpperCase()) },
  { id: 'double-slash', label: 'Doubled path separator', rewrite: (p) => p.replace('/api/', '/api//') },
  { id: 'query-enable', label: 'Flag supplied as a query parameter', rewrite: (p) => `${p}?patient_module=true&enabled=true` },
  { id: 'header-enable', label: 'Flag supplied as request headers', headers: { 'X-Feature-Patient-Module': 'true', 'X-Patient-Module-Enabled': 'true' } },
  { id: 'method-override', label: 'Method override header', headers: { 'X-HTTP-Method-Override': 'GET' } },
  { id: 'head', label: 'HEAD request', method: 'HEAD' },
];
