import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { config } from '../config';
import { db, getSetting, setSetting } from '../db';
import { egressReport, withEgressTag } from '../egress';
import { patientModuleEnabled, setPatientModule } from '../features';
import { JOB_NAMES, recoverMissed, runJob, type JobName } from '../jobs';
import { reapStalled } from '../jobs/runner';
import { dispatch } from '../outbound';
import { runSeed } from '../seed';

/**
 * Operator control plane: the actions an environment owner performs during a
 * review (flag toggles, job triggers, reset). Authenticated by an operator key,
 * separate from tenant credentials.
 */
export const ops = Router();

ops.use((req: Request, res: Response, next: NextFunction) => {
  const supplied = Buffer.from(String(req.headers['x-ops-key'] ?? ''));
  const expected = Buffer.from(config.opsKey);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    res.status(401).json({ error: 'UNAUTHENTICATED' });
    return;
  }
  next();
});

ops.post('/reset', (_req, res) => {
  res.json(runSeed());
});

ops.get('/feature-flags', (_req, res) => {
  res.json({ patient_module: patientModuleEnabled() });
});

ops.put('/feature-flags/patient_module', (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return void res.status(400).json({ error: 'INVALID_REQUEST' });
  setPatientModule(req.body.enabled);
  res.json({ patient_module: patientModuleEnabled() });
});

const SETTINGS = ['session_ttl_seconds', 'api_token_ttl_seconds', 'job_lock_ttl_seconds'];

ops.get('/settings', (_req, res) => {
  res.json(Object.fromEntries(SETTINGS.map((key) => [key, Number(getSetting(key, '0'))])));
});

ops.put('/settings', (req, res) => {
  for (const key of SETTINGS) {
    const value = req.body?.[key];
    if (Number.isInteger(value) && value > 0) setSetting(key, String(value));
  }
  res.json(Object.fromEntries(SETTINGS.map((key) => [key, Number(getSetting(key, '0'))])));
});

const isJob = (name: string): name is JobName => (JOB_NAMES as readonly string[]).includes(name);

ops.get('/jobs', (_req, res) => {
  res.json({ jobs: JOB_NAMES });
});

ops.post('/jobs/reap', (_req, res) => {
  res.json({ reaped: reapStalled() });
});

ops.get('/jobs/runs', (req, res) => {
  const name = typeof req.query.job_name === 'string' ? req.query.job_name : null;
  res.json({ rows: db().prepare('SELECT * FROM job_runs WHERE (? IS NULL OR job_name = ?) ORDER BY started_at, rowid').all(name, name) });
});

ops.post('/jobs/:name/run', async (req, res) => {
  const name = String(req.params.name);
  if (!isJob(name)) return void res.status(404).json({ error: 'NOT_FOUND' });
  res.json(await runJob(name, { scheduled_for: req.body?.scheduled_for, idempotency_key: req.body?.idempotency_key, simulate: req.body?.simulate }));
});

ops.post('/jobs/:name/recover', async (req, res) => {
  const name = String(req.params.name);
  if (name !== 'nightly-aggregate' && name !== 'weekly-report') return void res.status(404).json({ error: 'NOT_FOUND' });
  res.json({ runs: await recoverMissed(name, String(req.body?.as_of)) });
});

ops.get('/outbound/events', (_req, res) => {
  res.json({ rows: db().prepare('SELECT * FROM outbound_events ORDER BY created_at, rowid').all() });
});

ops.get('/egress', (_req, res) => {
  res.json(egressReport());
});

/** Positive control: proves the guard refuses a non-local destination. The name is RFC 2606 reserved and is never resolved. */
ops.post('/egress/selftest', async (_req, res) => {
  const event = await withEgressTag('selftest', () =>
    dispatch({ tenantId: null, type: 'webhook', destination: 'https://egress-selftest.invalid/', payload: { selftest: true }, transportUrl: 'http://egress-selftest.invalid/capture' }),
  );
  res.json({ event_id: event.id, status: event.status });
});
