import { environment } from '../../config/environment';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { day } from '../lib/recalc';
import { sleep } from '../lib/run';

/**
 * Stage 07. Scheduled and background work is run once, twice, concurrently,
 * killed part-way, failed and retried. After each case the database is read to
 * confirm the work was done exactly once and that the run record tells the truth.
 */

const cls = CLASSES.scheduledWork;
const base = { cls, roles: [] as string[] };

test.describe('07 scheduled and background work', () => {
  test.beforeEach(async ({ target }) => {
    await target.control.reset();
  });

  test('nightly aggregate: single run, then duplicate runs', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.nightlyAggregate;
    const date = '2026-09-15';
    const first = await target.jobs.run(job, { scheduledFor: date });
    const rows = db.dailyAggregates(date);
    const wrong = db.tenants().filter((tenant) => {
      const row = rows.find((entry) => entry.tenant_id === tenant.id);
      const expected = {
        activities: db.activities(tenant.id).filter((entry) => entry.activity_date === date).length,
        referrals: db.referrals(tenant.id).filter((entry) => day(entry.received_at) === date).length,
        admissions: db.admissions(tenant.id).filter((entry) => day(entry.admitted_at) === date).length,
      };
      return !row || row.activities !== expected.activities || row.referrals !== expected.referrals || row.admissions !== expected.admissions || row.run_id !== first.run_id;
    });
    review.verify(first.status === 'succeeded' && rows.length === db.tenants().length && wrong.length === 0, { ...base, key: 'scheduled/nightly-aggregate/single-run', title: 'The nightly aggregate does not produce correct totals', label: date, route: `job ${job}`, expected: 'run succeeded; one row per tenant equal to the source-row counts, stamped with the run id', actual: `run ${first.status}; ${rows.length} row(s); ${wrong.length} tenant(s) wrong`, data: { run: first, rows } });

    const record = db.jobRuns(job).find((run) => run.run_id === first.run_id);
    review.verify(Boolean(record?.run_id && record.idempotency_key && record.finished_at && record.status === 'succeeded'), { ...base, key: 'scheduled/run-record', title: 'A job run is not recorded with a run id and idempotency key', label: `${job} run record`, route: `job ${job}`, expected: 'a run record with run id, idempotency key, status and finish time', actual: JSON.stringify(record ?? null) });

    const second = await target.jobs.run(job, { scheduledFor: date });
    const afterDuplicate = db.dailyAggregates(date);
    review.verify(second.status === 'skipped_duplicate' && JSON.stringify(afterDuplicate) === JSON.stringify(rows), { ...base, key: 'scheduled/nightly-aggregate/duplicate-run', title: 'A duplicate nightly run is not suppressed', label: 'same slot run twice', route: `job ${job}`, expected: 'second run skipped as a duplicate; aggregate rows untouched', actual: `second run ${second.status}; rows ${JSON.stringify(afterDuplicate) === JSON.stringify(rows) ? 'unchanged' : 'changed'}`, data: { first, second } });

    // Even if suppression is bypassed with a new key, re-running must not double the totals.
    const forced = await target.jobs.run(job, { scheduledFor: date, idempotencyKey: `forced-${environment.run.id}` });
    const afterForced = db.dailyAggregates(date);
    const totals = (list: typeof rows) => list.map((row) => [row.tenant_id, row.activities, row.referrals, row.admissions]);
    review.verify(forced.status === 'succeeded' && afterForced.length === rows.length && JSON.stringify(totals(afterForced)) === JSON.stringify(totals(rows)), { ...base, key: 'scheduled/nightly-aggregate/duplicate-run', title: 'A duplicate nightly run is not suppressed', label: 'forced re-run does not double-count', route: `job ${job}`, expected: 'the same number of rows with the same totals', actual: `${afterForced.length} row(s); totals ${JSON.stringify(totals(afterForced)) === JSON.stringify(totals(rows)) ? 'unchanged' : 'changed'}`, data: { before: rows, after: afterForced } });
  });

  test('weekly report: one digest per tenant however often it runs', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.weeklyReport;
    const week = '2026-09-07';
    const tenants = db.tenants().length;
    review.expectOutbound(tenants);
    const digests = () => db.outboundEvents().filter((event) => event.type === 'email' && event.payload.includes('weekly-digest') && event.payload.includes(week));

    const first = await target.jobs.run(job, { scheduledFor: week });
    review.verify(first.status === 'succeeded' && db.weeklySnapshots(week).length === tenants && digests().length === tenants, { ...base, key: 'scheduled/weekly-report/single-run', title: 'The weekly report job does not produce one snapshot and one digest per tenant', label: week, route: `job ${job}`, expected: `${tenants} snapshots, ${tenants} digests`, actual: `run ${first.status}; ${db.weeklySnapshots(week).length} snapshots, ${digests().length} digests` });

    const second = await target.jobs.run(job, { scheduledFor: week });
    const forced = await target.jobs.run(job, { scheduledFor: week, idempotencyKey: `forced-${environment.run.id}` });
    review.verify(second.status === 'skipped_duplicate' && forced.status === 'succeeded' && db.weeklySnapshots(week).length === tenants && digests().length === tenants, { ...base, key: 'scheduled/weekly-report/duplicate-run', title: 'Re-running the weekly report sends duplicate digests', label: 'duplicate and forced re-run', route: `job ${job}`, expected: `second run skipped; forced run succeeds; still ${tenants} snapshots and ${tenants} digests`, actual: `second ${second.status}, forced ${forced.status}; ${db.weeklySnapshots(week).length} snapshots, ${digests().length} digests`, data: { second, forced } });
  });

  test('overlapping runs: the second is refused while the first holds the lock', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.nightlyAggregate;
    const slow = target.jobs.run(job, { scheduledFor: '2026-09-16', simulate: { holdMs: 1500 } });
    await sleep(400);
    const overlapping = await target.jobs.run(job, { scheduledFor: '2026-09-17' });
    const first = await slow;
    review.verify(first.status === 'succeeded' && overlapping.status === 'skipped_overlap' && db.dailyAggregates('2026-09-17').length === 0, { ...base, key: 'scheduled/overlap', title: 'Two runs of the same job can execute at the same time', label: 'second run started while the first is running', route: `job ${job}`, expected: 'first run succeeds; second is refused and writes nothing', actual: `first ${first.status}; second ${overlapping.status}; ${db.dailyAggregates('2026-09-17').length} row(s) written by the second`, data: { first, overlapping } });

    const later = await target.jobs.run(job, { scheduledFor: '2026-09-17' });
    review.verify(later.status === 'succeeded' && db.dailyAggregates('2026-09-17').length === db.tenants().length, { ...base, key: 'scheduled/overlap', title: 'Two runs of the same job can execute at the same time', label: 'lock released after completion', route: `job ${job}`, expected: 'the refused slot runs once the lock is free', actual: `run ${later.status}` });
  });

  test('interrupted run: detected, then retried without duplicates', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.referralSync;
    const previous = await target.control.settings();
    const key = `sync-${environment.run.id}`;
    const pending = db.inbox().length;
    const referralsBefore = db.tenants().reduce((sum, tenant) => sum + db.referrals(tenant.id).length, 0);
    const imported = () => db.tenants().flatMap((tenant) => db.referrals(tenant.id)).filter((row) => row.external_ref !== null);
    try {
      await target.control.setSettings({ jobLockTtlSeconds: 1 });
      const crashed = await target.jobs.run(job, { idempotencyKey: key, simulate: { crashAfter: 5 } });
      const partial = imported().length;
      review.verify(crashed.status === 'running' && partial === 5 && db.inbox().filter((item) => item.processed_at !== null).length === 5, { ...base, key: 'scheduled/interrupted/partial-work', title: 'An interrupted run leaves partly committed or inconsistent work', label: 'killed after 5 of the pending items', route: `job ${job}`, expected: 'exactly 5 items committed, each with its inbox item marked processed; run still recorded as running', actual: `run ${crashed.status}; ${partial} referral(s) imported; ${db.inbox().filter((item) => item.processed_at !== null).length} inbox item(s) processed`, data: { crashed, pending } });

      await sleep(1300);
      const stalled = await target.jobs.detectStalled();
      const record = db.jobRuns(job).find((run) => run.run_id === crashed.run_id);
      review.verify(stalled.includes(crashed.run_id) && record?.status === 'failed' && Boolean(record.error), { ...base, key: 'scheduled/interrupted/detection', title: 'A run that died without completing is not detected', label: 'stalled-run detection', route: `job ${job}`, expected: 'the dead run is reported and recorded as failed with a reason', actual: `reported: ${stalled.includes(crashed.run_id)}; record ${record?.status ?? 'missing'} (${record?.error ?? 'no error'})`, data: { stalled, record } });

      const retry = await target.jobs.run(job, { idempotencyKey: key });
      const refs = imported().map((row) => row.external_ref);
      const total = db.tenants().reduce((sum, tenant) => sum + db.referrals(tenant.id).length, 0);
      review.verify(retry.status === 'succeeded' && retry.attempt === 2 && refs.length === pending && new Set(refs).size === pending && total === referralsBefore + pending && db.inbox().every((item) => item.processed_at !== null), { ...base, key: 'scheduled/interrupted/second-attempt', title: 'Retrying an interrupted run duplicates or loses work', label: 'retry with the same idempotency key', route: `job ${job}`, expected: `attempt 2 succeeds; ${pending} referrals imported in total, each once`, actual: `retry ${retry.status} (attempt ${retry.attempt}); ${refs.length} imported, ${new Set(refs).size} distinct; referrals ${referralsBefore} → ${total}`, data: { retry } });

      const again = await target.jobs.run(job, { idempotencyKey: key });
      const fresh = await target.jobs.run(job);
      const finalTotal = db.tenants().reduce((sum, tenant) => sum + db.referrals(tenant.id).length, 0);
      review.verify(again.status === 'skipped_duplicate' && fresh.status === 'succeeded' && fresh.records_written === 0 && finalTotal === total, { ...base, key: 'scheduled/referral-sync/duplicate-run', title: 'Re-running the referral sync creates duplicate referrals', label: 'run again after completion', route: `job ${job}`, expected: 'same key skipped; a new run finds nothing to do', actual: `same key ${again.status}; new run ${fresh.status} wrote ${fresh.records_written}; referrals ${total} → ${finalTotal}` });
    } finally {
      await target.control.setSettings(previous);
    }
  });

  test('failed run: recorded as failed, lock released, retry completes once', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.weeklyReport;
    const week = '2026-09-14';
    const tenants = db.tenants().length;
    review.expectOutbound(tenants);
    const digests = () => db.outboundEvents().filter((event) => event.type === 'email' && event.payload.includes('weekly-digest') && event.payload.includes(week));

    const failed = await target.jobs.run(job, { scheduledFor: week, simulate: { failAfter: 2 } });
    const record = db.jobRuns(job).find((run) => run.run_id === failed.run_id);
    review.verify(failed.status === 'failed' && Boolean(record?.error) && Boolean(record?.finished_at), { ...base, key: 'scheduled/failure/detection', title: 'A failed run is not recorded as failed', label: 'failure after 2 of 3 tenants', route: `job ${job}`, expected: 'run recorded as failed with an error and a finish time', actual: `run ${failed.status}; error ${record?.error ?? 'none'}`, data: { failed } });

    const retry = await target.jobs.run(job, { scheduledFor: week });
    review.verify(retry.status === 'succeeded' && retry.attempt === 2 && db.weeklySnapshots(week).length === tenants && digests().length === tenants, { ...base, key: 'scheduled/failure/second-attempt', title: 'Retrying a failed run repeats work that had already been done', label: 'retry after failure', route: `job ${job}`, expected: `attempt 2 succeeds; ${tenants} snapshots; ${tenants} digests in total, none sent twice`, actual: `retry ${retry.status} (attempt ${retry.attempt}); ${db.weeklySnapshots(week).length} snapshots; ${digests().length} digests`, data: { retry, digests: digests().map((event) => ({ id: event.id, tenant: event.tenant_id })) } });
  });

  test('missed runs are recovered once', async ({ target, review }) => {
    const db = target.database;
    const job = target.jobs.names.nightlyAggregate;
    await target.jobs.run(job, { scheduledFor: '2026-09-10' });
    const missed = ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14'];
    const recovered = await target.jobs.recover(job, '2026-09-14');
    const slots = recovered.map((run) => run.scheduled_for);
    const filled = missed.filter((date) => db.dailyAggregates(date).length === db.tenants().length);
    review.verify(JSON.stringify(slots) === JSON.stringify(missed) && recovered.every((run) => run.status === 'succeeded') && filled.length === missed.length, { ...base, key: 'scheduled/missed-run-recovery', title: 'Missed scheduled runs are not recovered', label: 'four missed nightly slots', route: `job ${job}`, expected: `runs for ${missed.join(', ')}, all succeeded, aggregates present`, actual: `runs for ${slots.join(', ') || 'none'}; ${filled.length} of ${missed.length} dates have aggregates`, data: { recovered } });

    const again = await target.jobs.recover(job, '2026-09-14');
    review.verify(again.length === 0, { ...base, key: 'scheduled/missed-run-recovery', title: 'Missed scheduled runs are not recovered', label: 'recovery is not repeated', route: `job ${job}`, expected: 'nothing left to recover', actual: `${again.length} run(s)` });
  });
});
