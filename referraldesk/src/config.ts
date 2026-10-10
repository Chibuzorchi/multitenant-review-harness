import path from 'node:path';

const env = process.env;

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const APP_VERSION = '1.0.0';

export const config = {
  port: int(env.PORT, 3000),
  host: env.HOST ?? '127.0.0.1',
  dbPath: path.resolve(env.DB_PATH ?? 'data/referraldesk.db'),
  logDir: path.resolve(env.LOG_DIR ?? 'data/logs'),
  environmentName: env.APP_ENV ?? 'local-demo',
  buildSha: env.BUILD_SHA ?? 'unversioned',
  // Operator key for the /ops control plane (flag toggles, job triggers, reset).
  opsKey: env.OPS_KEY ?? 'local-demo-ops-key',
  // Shared password of the fictional seed accounts.
  demoPassword: env.DEMO_PASSWORD ?? 'Fictional-Demo-Pass-1',
  sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 1800),
  apiTokenTtlSeconds: int(env.API_TOKEN_TTL_SECONDS, 3600),
  jobLockTtlSeconds: int(env.JOB_LOCK_TTL_SECONDS, 120),
  patientModuleEnabled: env.PATIENT_MODULE_ENABLED === 'true',
  schedulerEnabled: env.SCHEDULER_ENABLED === 'true',
  seedOnStart: env.SEED_ON_START === 'true',
  // Every outbound provider (email, SMS, ads, billing, webhooks) is pointed at the local sink.
  sinkUrl: env.SINK_URL ?? 'http://127.0.0.1:4010',
  egressAllowHosts: (env.EGRESS_ALLOW_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
};

export type Role = 'executive' | 'operations_manager' | 'sales_manager' | 'intake' | 'rep';
export const ROLES: Role[] = ['executive', 'operations_manager', 'sales_manager', 'intake', 'rep'];
