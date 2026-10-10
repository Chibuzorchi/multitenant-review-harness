import type { JobResult, JobsAdapter } from '../jobs';
import { ops } from './ops';

export const jobs: JobsAdapter = {
  names: { nightlyAggregate: 'nightly-aggregate', weeklyReport: 'weekly-report', referralSync: 'referral-sync', patientQueue: 'patient-projection-queue' },
  run(job, options = {}) {
    const simulate = options.simulate && { fail_after: options.simulate.failAfter, crash_after: options.simulate.crashAfter, hold_ms: options.simulate.holdMs };
    return ops<JobResult>('POST', `/ops/jobs/${job}/run`, { scheduled_for: options.scheduledFor, idempotency_key: options.idempotencyKey, simulate });
  },
  async recover(job, asOf) {
    return (await ops<{ runs: JobResult[] }>('POST', `/ops/jobs/${job}/recover`, { as_of: asOf })).runs;
  },
  async detectStalled() {
    return (await ops<{ reaped: string[] }>('POST', '/ops/jobs/reap')).reaped;
  },
};
