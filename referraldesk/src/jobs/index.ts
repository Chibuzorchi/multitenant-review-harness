import crypto from 'node:crypto';
import { db, nowIso } from '../db';
import { dispatch } from '../outbound';
import { weekStart, weeklyReport } from '../reports';
import { executeJob, type JobContext, type JobRun, type Simulation } from './runner';

export const JOB_NAMES = ['nightly-aggregate', 'weekly-report', 'referral-sync', 'patient-projection-queue'] as const;
export type JobName = (typeof JOB_NAMES)[number];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function tenantIds(): number[] {
  return (db().prepare('SELECT id FROM tenants ORDER BY id').all() as Array<{ id: number }>).map((t) => t.id);
}

/** Recomputes one day of per-tenant totals. Upserts, so a re-run replaces rather than duplicates. */
function nightlyAggregate(ctx: JobContext): number {
  const date = ctx.scheduledFor!;
  const d = db();
  const count = (sql: string, tenant: number) => (d.prepare(sql).get(tenant, date) as { n: number }).n;
  for (const tenant of tenantIds()) {
    d.prepare(
      `INSERT INTO daily_aggregates (tenant_id, date, activities, referrals, admissions, run_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, date) DO UPDATE SET activities = excluded.activities, referrals = excluded.referrals,
         admissions = excluded.admissions, run_id = excluded.run_id`,
    ).run(
      tenant,
      date,
      count('SELECT COUNT(*) AS n FROM activities WHERE tenant_id = ? AND activity_date = ?', tenant),
      count('SELECT COUNT(*) AS n FROM referrals WHERE tenant_id = ? AND substr(received_at, 1, 10) = ?', tenant),
      count('SELECT COUNT(*) AS n FROM admissions WHERE tenant_id = ? AND substr(admitted_at, 1, 10) = ?', tenant),
      ctx.runId,
    );
    ctx.step();
  }
  return tenantIds().length;
}

/** Stores a weekly snapshot per tenant and emails a digest. The digest is de-duplicated per tenant and week. */
async function weeklyReportJob(ctx: JobContext): Promise<number> {
  const week = ctx.scheduledFor!;
  const d = db();
  for (const tenant of tenantIds()) {
    const totals = weeklyReport(tenant, { from: week, to: addDays(week, 6) })[0] ?? { week_start: week, activities: 0, referrals: 0, admissions: 0 };
    d.prepare(
      `INSERT INTO weekly_report_snapshots (tenant_id, week_start, payload, run_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(tenant_id, week_start) DO UPDATE SET payload = excluded.payload, run_id = excluded.run_id`,
    ).run(tenant, week, JSON.stringify(totals), ctx.runId);
    const recipient = d.prepare("SELECT email FROM users WHERE tenant_id = ? AND role = 'executive' ORDER BY id LIMIT 1").get(tenant) as { email: string };
    await dispatch({
      tenantId: tenant,
      type: 'email',
      destination: `mailto:${recipient.email}`,
      payload: { template: 'weekly-digest', week_start: week, totals },
      dedupeKey: `weekly-digest:${tenant}:${week}`,
    });
    ctx.step();
  }
  return tenantIds().length;
}

/** Converts pending partner-feed items into referrals. Each item commits atomically and is keyed by external_ref. */
function referralSync(ctx: JobContext): number {
  const d = db();
  const pending = d.prepare('SELECT * FROM referral_inbox WHERE processed_at IS NULL ORDER BY id').all() as Array<{
    id: number;
    tenant_id: number;
    external_ref: string;
    referral_source_id: number;
    assigned_rep_id: number;
    received_at: string;
  }>;
  const apply = d.transaction((item: (typeof pending)[number]) => {
    d.prepare(
      `INSERT OR IGNORE INTO referrals (tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at, external_ref)
       VALUES (?, ?, ?, 'received', ?, ?, ?)`,
    ).run(item.tenant_id, item.referral_source_id, item.assigned_rep_id, item.received_at, item.received_at, item.external_ref);
    d.prepare('UPDATE referral_inbox SET processed_at = ? WHERE id = ?').run(nowIso(), item.id);
  });
  let written = 0;
  for (const item of pending) {
    apply(item);
    written += 1;
    ctx.step();
  }
  return written;
}

/** Drains the patient-projection queue. Items are only enqueued while the patient module is enabled. */
function patientProjectionQueue(ctx: JobContext): number {
  const d = db();
  const queued = d.prepare("SELECT id, tenant_id FROM patient_projection_queue WHERE status = 'queued' ORDER BY id").all() as Array<{ id: number; tenant_id: number }>;
  let written = 0;
  for (const item of queued) {
    const patients = (d.prepare('SELECT COUNT(*) AS n FROM patients WHERE tenant_id = ?').get(item.tenant_id) as { n: number }).n;
    const links = (d.prepare('SELECT COUNT(*) AS n FROM patient_referral_links WHERE tenant_id = ?').get(item.tenant_id) as { n: number }).n;
    d.transaction(() => {
      d.prepare('INSERT INTO patient_projection (tenant_id, patient_count, linked_referrals, queue_item_id, run_id, computed_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        item.tenant_id,
        patients,
        links,
        item.id,
        ctx.runId,
        nowIso(),
      );
      d.prepare("UPDATE patient_projection_queue SET status = 'done', result = 'PROJECTED', processed_at = ?, run_id = ? WHERE id = ?").run(nowIso(), ctx.runId, item.id);
    })();
    written += 1;
    ctx.step();
  }
  return written;
}

export interface RunOptions {
  scheduled_for?: string;
  idempotency_key?: string;
  simulate?: Simulation;
}

export async function runJob(name: JobName, options: RunOptions = {}): Promise<JobRun> {
  const today = nowIso().slice(0, 10);
  const unique = () => crypto.randomBytes(6).toString('hex');
  switch (name) {
    case 'nightly-aggregate': {
      const date = options.scheduled_for ?? addDays(today, -1);
      return executeJob(name, nightlyAggregate, { idempotencyKey: options.idempotency_key ?? `${name}:${date}`, scheduledFor: date, simulate: options.simulate });
    }
    case 'weekly-report': {
      const week = weekStart(options.scheduled_for ?? addDays(today, -7));
      return executeJob(name, weeklyReportJob, { idempotencyKey: options.idempotency_key ?? `${name}:${week}`, scheduledFor: week, simulate: options.simulate });
    }
    case 'referral-sync':
      return executeJob(name, referralSync, { idempotencyKey: options.idempotency_key ?? `${name}:${unique()}`, simulate: options.simulate });
    case 'patient-projection-queue':
      return executeJob(name, patientProjectionQueue, { idempotencyKey: options.idempotency_key ?? `${name}:${unique()}`, simulate: options.simulate });
  }
}

/** Runs every scheduled slot between the last success and as_of that has not completed. */
export async function recoverMissed(name: 'nightly-aggregate' | 'weekly-report', asOf: string): Promise<JobRun[]> {
  const stepDays = name === 'nightly-aggregate' ? 1 : 7;
  const target = name === 'nightly-aggregate' ? asOf : weekStart(asOf);
  const state = db().prepare('SELECT last_success_for FROM job_state WHERE job_name = ?').get(name) as { last_success_for: string } | undefined;
  const runs: JobRun[] = [];
  let slot = state ? addDays(state.last_success_for, stepDays) : target;
  for (let guard = 0; slot <= target && guard < 60; guard++, slot = addDays(slot, stepDays)) {
    runs.push(await runJob(name, { scheduled_for: slot }));
  }
  return runs;
}

export function startScheduler(intervalMs = 60_000): NodeJS.Timeout {
  const tick = async () => {
    const today = nowIso().slice(0, 10);
    await recoverMissed('nightly-aggregate', addDays(today, -1));
    await recoverMissed('weekly-report', addDays(today, -7));
    await runJob('referral-sync');
    await runJob('patient-projection-queue');
  };
  return setInterval(() => void tick().catch((err) => console.error('scheduler tick failed', err)), intervalMs).unref();
}
