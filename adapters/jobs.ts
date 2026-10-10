/** Control of the target's scheduled and background work. */

export interface JobResult {
  run_id: string;
  job_name: string;
  idempotency_key: string;
  status: 'running' | 'succeeded' | 'failed' | 'skipped_duplicate' | 'skipped_overlap';
  attempt: number;
  scheduled_for: string | null;
  error: string | null;
  records_written: number;
}

export interface RunOptions {
  scheduledFor?: string;
  idempotencyKey?: string;
  /** Fault injection supported by the target's job runner. */
  simulate?: { failAfter?: number; crashAfter?: number; holdMs?: number };
}

export interface JobsAdapter {
  readonly names: { nightlyAggregate: string; weeklyReport: string; referralSync: string; patientQueue: string };
  run(job: string, options?: RunOptions): Promise<JobResult>;
  /** Run every scheduled slot that was missed up to the given date. */
  recover(job: string, asOf: string): Promise<JobResult[]>;
  /** Detect runs that died without completing. Returns their run ids. */
  detectStalled(): Promise<string[]>;
}
