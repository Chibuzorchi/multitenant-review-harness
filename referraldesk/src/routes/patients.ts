import { Router, type Request, type Response } from 'express';
import { requireApiAuth } from '../auth';
import { db, nowIso } from '../db';
import { requirePatientModule } from '../features';
import { dispatch, tenantWebhook } from '../outbound';
import { can } from '../policy';

/**
 * Patient module. Exists to demonstrate server-side feature denial: every route
 * here sits behind requirePatientModule. Records are opaque synthetic tokens.
 */
export const patients = Router();

function requireAccess(req: Request, res: Response, next: () => void): void {
  if (!can(req.auth!.user.role, 'patients.access')) {
    res.status(403).json({ error: 'FORBIDDEN' });
    return;
  }
  next();
}

const gate = [requireApiAuth, requirePatientModule, requireAccess];
const tenantOf = (req: Request) => req.auth!.user.tenant_id;

patients.get('/patients', gate, (req: Request, res: Response) => {
  res.json({ rows: db().prepare('SELECT * FROM patients WHERE tenant_id = ? ORDER BY id').all(tenantOf(req)) });
});

patients.get('/patients/:id', gate, (req: Request, res: Response) => {
  const row = db().prepare('SELECT * FROM patients WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), tenantOf(req));
  if (!row) return void res.status(404).json({ error: 'NOT_FOUND' });
  const links = db().prepare('SELECT referral_id FROM patient_referral_links WHERE patient_id = ? AND tenant_id = ?').all(Number(req.params.id), tenantOf(req));
  res.json({ ...row, referral_links: links });
});

patients.get('/referrals/:id/patients', gate, (req: Request, res: Response) => {
  const rows = db()
    .prepare('SELECT p.* FROM patients p JOIN patient_referral_links l ON l.patient_id = p.id WHERE l.referral_id = ? AND p.tenant_id = ?')
    .all(Number(req.params.id), tenantOf(req));
  res.json({ rows });
});

patients.post('/patient-import', gate, (req: Request, res: Response) => {
  const records: unknown[] = Array.isArray(req.body?.records) ? req.body.records : [];
  const insert = db().prepare('INSERT OR IGNORE INTO patients (tenant_id, synthetic_ref, status, created_at) VALUES (?, ?, ?, ?)');
  let imported = 0;
  for (const record of records) {
    const ref = (record as { synthetic_ref?: unknown })?.synthetic_ref;
    if (typeof ref === 'string' && /^SYN-[A-Za-z0-9-]+$/.test(ref)) imported += insert.run(tenantOf(req), ref, 'placeholder', nowIso()).changes;
  }
  res.status(201).json({ imported });
});

patients.get('/patient-projection', gate, (req: Request, res: Response) => {
  res.json({ rows: db().prepare('SELECT * FROM patient_projection WHERE tenant_id = ? ORDER BY id DESC LIMIT 20').all(tenantOf(req)) });
});

patients.post('/jobs/patient-sync', gate, (req: Request, res: Response) => {
  const id = db()
    .prepare("INSERT INTO patient_projection_queue (tenant_id, requested_by, status, enqueued_at) VALUES (?, ?, 'queued', ?)")
    .run(tenantOf(req), req.auth!.user.id, nowIso()).lastInsertRowid;
  res.status(202).json({ queued: true, queue_item_id: Number(id) });
});

patients.post('/webhooks/patient', gate, async (req: Request, res: Response) => {
  const count = (db().prepare('SELECT COUNT(*) AS n FROM patients WHERE tenant_id = ?').get(tenantOf(req)) as { n: number }).n;
  const event = await dispatch({ tenantId: tenantOf(req), type: 'webhook', destination: tenantWebhook(tenantOf(req)), payload: { event: 'patient.sync', patient_count: count } });
  res.status(202).json({ event_id: event.id, status: event.status });
});
