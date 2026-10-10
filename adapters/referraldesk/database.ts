import Database from 'better-sqlite3';
import { environment } from '../../config/environment';
import type { DatabaseAdapter } from '../database';

/**
 * Direct, read-only SQLite access. A connection is opened per query so the
 * harness never holds a lock on, or a stale view of, the application database.
 */
function read<T>(sql: string, ...params: unknown[]): T[] {
  const handle = new Database(environment.databasePath, { readonly: true, fileMustExist: true });
  try {
    handle.pragma('busy_timeout = 5000');
    return handle.prepare(sql).all(...params) as T[];
  } finally {
    handle.close();
  }
}

export const database: DatabaseAdapter = {
  tenants: () => read('SELECT id, slug, name FROM tenants ORDER BY id'),
  users: (tenantId) => read('SELECT id, tenant_id, email, name, role, active FROM users WHERE (? IS NULL OR tenant_id = ?) ORDER BY id', tenantId ?? null, tenantId ?? null),
  userByEmail: (email) => read<never>('SELECT id, tenant_id, email, name, role, active FROM users WHERE email = ?', email)[0] ?? null,
  sources: (tenantId) => read('SELECT * FROM referral_sources WHERE tenant_id = ? ORDER BY id', tenantId),
  activities: (tenantId) => read('SELECT * FROM activities WHERE tenant_id = ? ORDER BY id', tenantId),
  referrals: (tenantId) => read('SELECT id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at, external_ref FROM referrals WHERE tenant_id = ? ORDER BY id', tenantId),
  admissions: (tenantId) => read('SELECT * FROM admissions WHERE tenant_id = ? ORDER BY id', tenantId),
  credentials: (userId) => read('SELECT id, user_id, kind, created_at, expires_at, revoked_at FROM sessions WHERE user_id = ? ORDER BY created_at', userId),
  patientCount: (tenantId) => read<{ n: number }>('SELECT COUNT(*) AS n FROM patients WHERE (? IS NULL OR tenant_id = ?)', tenantId ?? null, tenantId ?? null)[0].n,
  projectionQueue: () => read('SELECT id, tenant_id, status, result, enqueued_at, processed_at, run_id FROM patient_projection_queue ORDER BY id'),
  projections: () => read('SELECT id, tenant_id, queue_item_id, run_id, computed_at FROM patient_projection ORDER BY id'),
  jobRuns: (jobName) => read('SELECT * FROM job_runs WHERE (? IS NULL OR job_name = ?) ORDER BY started_at, rowid', jobName ?? null, jobName ?? null),
  dailyAggregates: (date) => read('SELECT * FROM daily_aggregates WHERE (? IS NULL OR date = ?) ORDER BY date, tenant_id', date ?? null, date ?? null),
  weeklySnapshots: (weekStart) => read('SELECT * FROM weekly_report_snapshots WHERE (? IS NULL OR week_start = ?) ORDER BY week_start, tenant_id', weekStart ?? null, weekStart ?? null),
  inbox: () => read('SELECT id, tenant_id, external_ref, processed_at FROM referral_inbox ORDER BY id'),
  outboundEvents: () => read('SELECT id, tenant_id, type, destination, payload, created_at, status, transport FROM outbound_events ORDER BY created_at, rowid'),
  crossTenantReferences: () => [
    ...read<{ id: number; detail: string }>(
      `SELECT a.id, 'activity tenant ' || a.tenant_id || ' -> source tenant ' || s.tenant_id AS detail
         FROM activities a JOIN referral_sources s ON s.id = a.referral_source_id WHERE a.tenant_id <> s.tenant_id`,
    ).map((row) => ({ table: 'activities', ...row })),
    ...read<{ id: number; detail: string }>(
      `SELECT a.id, 'activity tenant ' || a.tenant_id || ' -> rep tenant ' || u.tenant_id AS detail
         FROM activities a JOIN users u ON u.id = a.rep_id WHERE a.tenant_id <> u.tenant_id`,
    ).map((row) => ({ table: 'activities', ...row })),
    ...read<{ id: number; detail: string }>(
      `SELECT s.id, 'source tenant ' || s.tenant_id || ' -> owner tenant ' || u.tenant_id AS detail
         FROM referral_sources s JOIN users u ON u.id = s.owner_rep_id WHERE s.tenant_id <> u.tenant_id`,
    ).map((row) => ({ table: 'referral_sources', ...row })),
    ...read<{ id: number; detail: string }>(
      `SELECT r.id, 'referral tenant ' || r.tenant_id || ' -> source tenant ' || s.tenant_id AS detail
         FROM referrals r JOIN referral_sources s ON s.id = r.referral_source_id WHERE r.tenant_id <> s.tenant_id`,
    ).map((row) => ({ table: 'referrals', ...row })),
    ...read<{ id: number; detail: string }>(
      `SELECT m.id, 'admission tenant ' || m.tenant_id || ' -> referral tenant ' || r.tenant_id AS detail
         FROM admissions m JOIN referrals r ON r.id = m.referral_id WHERE m.tenant_id <> r.tenant_id`,
    ).map((row) => ({ table: 'admissions', ...row })),
  ],
};
