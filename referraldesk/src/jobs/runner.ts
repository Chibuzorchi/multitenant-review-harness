import crypto from 'node:crypto';
import { db, getSetting, nowIso } from '../db';

/**
 * Job runner with duplicate suppression (idempotency key), overlap protection
 * (per-job lock with expiry), failure recording and stalled-run detection.
 */

export interface Simulation {
  /** Throw after this many units of work: an ordinary handled failure. */
  fail_after?: number;
  /** Stop dead after this many units without cleanup: stands in for a killed process. */
  crash_after?: number;
  /** Hold the lock for this long before working, to create an overlap window. */
  hold_ms?: number;
}

export interface JobContext {
  runId: string;
  scheduledFor: string | null;
  /** Call after each committed unit of work. */
  step(): void;
}

export interface JobRun {
  run_id: string;
  job_name: string;
  idempotency_key: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped_duplicate' | 'skipped_overlap';
  attempt: number;
  scheduled_for: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  records_written: number;
  detail: string | null;
}

export type JobHandler = (ctx: JobContext) => Promise<number> | number;

class SimulatedCrash extends Error {}

function getRun(runId: string): JobRun {
  return db().prepare('SELECT * FROM job_runs WHERE run_id = ?').get(runId) as JobRun;
}

function insertRun(run: Partial<JobRun> & { run_id: string; job_name: string; idempotency_key: string; status: string }): void {
  db()
    .prepare(
      `INSERT INTO job_runs (run_id, job_name, idempotency_key, status, attempt, scheduled_for, started_at, finished_at, detail)
       VALUES (@run_id, @job_name, @idempotency_key, @status, @attempt, @scheduled_for, @started_at, @finished_at, @detail)`,
    )
    .run({ attempt: 1, scheduled_for: null, started_at: nowIso(), finished_at: null, detail: null, ...run });
}

/** Marks runs whose lock has expired as failed and frees the lock. Returns the reaped run ids. */
export function reapStalled(jobName?: string): string[] {
  const d = db();
  const stale = d
    .prepare('SELECT job_name, run_id FROM job_locks WHERE expires_at <= ? AND (? IS NULL OR job_name = ?)')
    .all(nowIso(), jobName ?? null, jobName ?? null) as Array<{ job_name: string; run_id: string }>;
  for (const lock of stale) {
    d.prepare("UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ? AND status = 'running'").run(
      nowIso(),
      'STALLED: lock expired without completion',
      lock.run_id,
    );
    d.prepare('DELETE FROM job_locks WHERE job_name = ? AND run_id = ?').run(lock.job_name, lock.run_id);
  }
  return stale.map((lock) => lock.run_id);
}

export async function executeJob(
  jobName: string,
  handler: JobHandler,
  options: { idempotencyKey: string; scheduledFor?: string | null; simulate?: Simulation },
): Promise<JobRun> {
  const d = db();
  const runId = `job_${crypto.randomBytes(8).toString('hex')}`;
  const base = { run_id: runId, job_name: jobName, idempotency_key: options.idempotencyKey, scheduled_for: options.scheduledFor ?? null };

  const completed = d
    .prepare("SELECT run_id FROM job_runs WHERE job_name = ? AND idempotency_key = ? AND status = 'succeeded'")
    .get(jobName, options.idempotencyKey) as { run_id: string } | undefined;
  if (completed) {
    insertRun({ ...base, status: 'skipped_duplicate', finished_at: nowIso(), detail: JSON.stringify({ original_run_id: completed.run_id }) });
    return getRun(runId);
  }

  reapStalled(jobName);
  const lockTtl = Number(getSetting('job_lock_ttl_seconds', '120'));
  const acquired = d
    .prepare('INSERT OR IGNORE INTO job_locks (job_name, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(jobName, runId, nowIso(), new Date(Date.now() + lockTtl * 1000).toISOString());
  if (acquired.changes === 0) {
    const holder = d.prepare('SELECT run_id FROM job_locks WHERE job_name = ?').get(jobName) as { run_id: string } | undefined;
    insertRun({ ...base, status: 'skipped_overlap', finished_at: nowIso(), detail: JSON.stringify({ held_by: holder?.run_id ?? null }) });
    return getRun(runId);
  }

  const priorAttempts = (d.prepare("SELECT COUNT(*) AS n FROM job_runs WHERE job_name = ? AND idempotency_key = ? AND status IN ('failed', 'running')").get(jobName, options.idempotencyKey) as { n: number }).n;
  insertRun({ ...base, status: 'running', attempt: priorAttempts + 1 });

  const sim = options.simulate ?? {};
  let units = 0;
  const ctx: JobContext = {
    runId,
    scheduledFor: options.scheduledFor ?? null,
    step() {
      units += 1;
      d.prepare('UPDATE job_runs SET records_written = ? WHERE run_id = ?').run(units, runId);
      if (sim.crash_after !== undefined && units >= sim.crash_after) throw new SimulatedCrash();
      if (sim.fail_after !== undefined && units >= sim.fail_after) throw new Error(`simulated failure after ${units} unit(s)`);
    },
  };

  try {
    if (sim.hold_ms) await new Promise((resolve) => setTimeout(resolve, sim.hold_ms));
    const written = await handler(ctx);
    d.prepare("UPDATE job_runs SET status = 'succeeded', finished_at = ?, records_written = ? WHERE run_id = ?").run(nowIso(), written, runId);
    if (options.scheduledFor) {
      d.prepare(
        `INSERT INTO job_state (job_name, last_success_for) VALUES (?, ?)
         ON CONFLICT(job_name) DO UPDATE SET last_success_for = MAX(last_success_for, excluded.last_success_for)`,
      ).run(jobName, options.scheduledFor);
    }
  } catch (err) {
    // A simulated crash leaves the run "running" and the lock held, exactly as a killed process would.
    if (err instanceof SimulatedCrash) return getRun(runId);
    d.prepare("UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE run_id = ?").run(nowIso(), (err as Error).message, runId);
  }
  d.prepare('DELETE FROM job_locks WHERE job_name = ? AND run_id = ?').run(jobName, runId);
  return getRun(runId);
}
