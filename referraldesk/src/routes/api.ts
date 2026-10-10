import { Router, type Request, type Response } from 'express';
import {
  checkCredentials,
  clearSessionCookie,
  issueCredential,
  requireApiAuth,
  revokeSession,
  revokeUserCredentials,
  setSessionCookie,
  type AuthUser,
} from '../auth';
import { config, ROLES, type Role } from '../config';
import { audit, db, nowIso } from '../db';
import { dispatch, tenantWebhook } from '../outbound';
import { can, type Capability } from '../policy';
import { byRepReport, bySourceReport, monthlyReport, parseRange, summaryReport, weeklyReport } from '../reports';
import { hashPassword, sha256 } from '../security';

export const api = Router();

const ACTIVITY_TYPES = ['visit', 'call', 'note'];
const REFERRAL_STATUSES = ['received', 'in_review', 'accepted', 'declined'];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const forbidden = (res: Response) => res.status(403).json({ error: 'FORBIDDEN' });
const notFound = (res: Response) => res.status(404).json({ error: 'NOT_FOUND' });
const invalid = (res: Response, message: string) => res.status(400).json({ error: 'INVALID_REQUEST', message });
const me = (req: Request): AuthUser => req.auth!.user;
const idParam = (value: unknown): number => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : -1;
};

function requireCap(capability: Capability) {
  return (req: Request, res: Response, next: () => void) => {
    if (!can(me(req).role, capability)) {
      forbidden(res);
      return;
    }
    next();
  };
}

function tenantRep(tenantId: number, repId: number): boolean {
  return Boolean(db().prepare("SELECT 1 FROM users WHERE id = ? AND tenant_id = ? AND role = 'rep' AND active = 1").get(repId, tenantId));
}

// ---------------------------------------------------------------- authentication

api.post('/auth/login', (req, res) => {
  const user = checkCredentials(req.body?.email, req.body?.password);
  if (!user) {
    res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    return;
  }
  const session = issueCredential(user, 'browser');
  setSessionCookie(res, session.secret, session.expires_at);
  res.json({ user, expires_at: session.expires_at });
});

api.post('/auth/token', (req, res) => {
  const user = checkCredentials(req.body?.email, req.body?.password);
  if (!user) {
    res.status(401).json({ error: 'INVALID_CREDENTIALS' });
    return;
  }
  const token = issueCredential(user, 'api');
  res.status(201).json({ token: token.secret, token_type: 'Bearer', expires_at: token.expires_at });
});

api.use(requireApiAuth);

api.get('/me', (req, res) => {
  res.json({ user: me(req), credential: req.auth!.kind });
});

api.post('/auth/logout', (req, res) => {
  revokeSession(req.auth!.sessionId);
  clearSessionCookie(res);
  res.json({ ok: true });
});

api.post('/auth/revoke', (req, res) => {
  const revoked = revokeUserCredentials(me(req).id);
  audit('credentials.revoked', me(req).tenant_id, me(req).id, { by: 'self', revoked });
  clearSessionCookie(res);
  res.json({ ok: true, revoked });
});

// ---------------------------------------------------------------- users

api.get('/users', requireCap('users.read'), (req, res) => {
  res.json({ rows: db().prepare('SELECT id, tenant_id, email, name, role, active FROM users WHERE tenant_id = ? ORDER BY id').all(me(req).tenant_id) });
});

api.get('/users/:id', requireCap('users.read'), (req, res) => {
  const row = db().prepare('SELECT id, tenant_id, email, name, role, active FROM users WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), me(req).tenant_id);
  if (!row) return void notFound(res);
  res.json(row);
});

api.post('/users', requireCap('users.admin'), (req, res) => {
  const { email, name, role } = req.body ?? {};
  if (typeof email !== 'string' || typeof name !== 'string' || !ROLES.includes(role)) return void invalid(res, 'email, name and a valid role are required');
  const lower = email.toLowerCase();
  if (db().prepare('SELECT 1 FROM users WHERE email = ?').get(lower)) return void res.status(409).json({ error: 'CONFLICT' });
  const hash = hashPassword(config.demoPassword, sha256(lower).slice(0, 16));
  const id = db().prepare('INSERT INTO users (tenant_id, email, name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(me(req).tenant_id, lower, name, role, hash, nowIso()).lastInsertRowid;
  audit('user.created', me(req).tenant_id, me(req).id, { user_id: Number(id), role });
  res.status(201).json({ id: Number(id), tenant_id: me(req).tenant_id, email: lower, name, role });
});

api.patch('/users/:id', requireCap('users.admin'), (req, res) => {
  const target = db().prepare('SELECT id, name, role, active FROM users WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), me(req).tenant_id) as { id: number; name: string; role: Role; active: number } | undefined;
  if (!target) return void notFound(res);
  const name = typeof req.body?.name === 'string' ? req.body.name : target.name;
  const role = ROLES.includes(req.body?.role) ? (req.body.role as Role) : target.role;
  const active = typeof req.body?.active === 'boolean' ? Number(req.body.active) : target.active;
  db().prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(name, role, active, target.id);
  audit('user.updated', me(req).tenant_id, me(req).id, { user_id: target.id });
  res.json({ id: target.id, name, role, active: Boolean(active) });
});

api.post('/users/:id/revoke-sessions', requireCap('users.admin'), (req, res) => {
  const target = db().prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), me(req).tenant_id) as { id: number } | undefined;
  if (!target) return void notFound(res);
  const revoked = revokeUserCredentials(target.id);
  audit('credentials.revoked', me(req).tenant_id, me(req).id, { by: 'admin', user_id: target.id, revoked });
  res.json({ ok: true, revoked });
});

// ---------------------------------------------------------------- referral sources

interface SourceRow {
  id: number;
  tenant_id: number;
  business_name: string;
  business_type: string;
  address: string;
  owner_rep_id: number;
  status: string;
}

api.get('/referral-sources', (req, res) => {
  const user = me(req);
  const clauses = ['tenant_id = @tenant'];
  const params: Record<string, unknown> = { tenant: user.tenant_id };
  if (!can(user.role, 'sources.read_all')) {
    clauses.push('owner_rep_id = @self');
    params.self = user.id;
  } else if (req.query.owner_rep_id !== undefined) {
    clauses.push('owner_rep_id = @owner');
    params.owner = idParam(req.query.owner_rep_id);
  }
  if (typeof req.query.q === 'string' && req.query.q) {
    clauses.push('business_name LIKE @q');
    params.q = `%${req.query.q}%`;
  }
  res.json({ rows: db().prepare(`SELECT * FROM referral_sources WHERE ${clauses.join(' AND ')} ORDER BY id`).all(params) });
});

api.get('/referral-sources/:id', (req, res) => {
  const user = me(req);
  const row = db().prepare('SELECT * FROM referral_sources WHERE id = ?').get(idParam(req.params.id)) as SourceRow | undefined;
  if (!row) return void notFound(res);
  if (!can(user.role, 'sources.read_all') && row.owner_rep_id !== user.id) return void forbidden(res);
  res.json(row);
});

api.post('/referral-sources', requireCap('sources.write'), (req, res) => {
  const user = me(req);
  const { business_name, business_type, address } = req.body ?? {};
  if (typeof business_name !== 'string' || typeof business_type !== 'string' || typeof address !== 'string') return void invalid(res, 'business_name, business_type and address are required');
  let owner = user.id;
  if (can(user.role, 'sources.write_any')) {
    owner = idParam(req.body.owner_rep_id);
    if (!tenantRep(user.tenant_id, owner)) return void invalid(res, 'owner_rep_id must be a rep in this tenant');
  } else if (req.body.owner_rep_id !== undefined && idParam(req.body.owner_rep_id) !== user.id) {
    return void forbidden(res);
  }
  const now = nowIso();
  const id = db().prepare('INSERT INTO referral_sources (tenant_id, business_name, business_type, address, owner_rep_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user.tenant_id, business_name, business_type, address, owner, 'active', now, now).lastInsertRowid;
  res.status(201).json(db().prepare('SELECT * FROM referral_sources WHERE id = ?').get(id));
});

api.patch('/referral-sources/:id', requireCap('sources.write'), (req, res) => {
  const user = me(req);
  const row = db().prepare('SELECT * FROM referral_sources WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), user.tenant_id) as SourceRow | undefined;
  if (!row) return void notFound(res);
  if (!can(user.role, 'sources.write_any') && row.owner_rep_id !== user.id) return void forbidden(res);
  const next = {
    business_name: typeof req.body?.business_name === 'string' ? req.body.business_name : row.business_name,
    address: typeof req.body?.address === 'string' ? req.body.address : row.address,
    status: ['active', 'inactive'].includes(req.body?.status) ? req.body.status : row.status,
  };
  db().prepare('UPDATE referral_sources SET business_name = ?, address = ?, status = ?, updated_at = ? WHERE id = ?').run(next.business_name, next.address, next.status, nowIso(), row.id);
  res.json(db().prepare('SELECT * FROM referral_sources WHERE id = ?').get(row.id));
});

api.get('/referral-sources/:id/activities', requireCap('activities.read'), (req, res) => {
  const user = me(req);
  const source = db().prepare('SELECT * FROM referral_sources WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), user.tenant_id) as SourceRow | undefined;
  if (!source) return void notFound(res);
  if (!can(user.role, 'activities.read_all') && source.owner_rep_id !== user.id) return void forbidden(res);
  res.json({ rows: db().prepare('SELECT * FROM activities WHERE referral_source_id = ? AND tenant_id = ? ORDER BY activity_date DESC, id DESC').all(source.id, user.tenant_id) });
});

// ---------------------------------------------------------------- activities

export function listActivities(user: AuthUser, query: Record<string, unknown>): { status: 200; rows: unknown[] } | { status: 403 } {
  let repId = query.rep_id === undefined || query.rep_id === '' ? null : idParam(query.rep_id);
  // The activity list screen only offers the rep filter to managers.
  if (repId === null && !can(user.role, 'activities.read_all')) repId = user.id;
  const clauses = ['tenant_id = @tenant'];
  const params: Record<string, unknown> = { tenant: user.tenant_id };
  if (repId !== null) {
    clauses.push('rep_id = @rep');
    params.rep = repId;
  }
  if (query.referral_source_id !== undefined && query.referral_source_id !== '') {
    clauses.push('referral_source_id = @source');
    params.source = idParam(query.referral_source_id);
  }
  if (typeof query.from === 'string' && DATE.test(query.from)) {
    clauses.push('activity_date >= @from');
    params.from = query.from;
  }
  if (typeof query.to === 'string' && DATE.test(query.to)) {
    clauses.push('activity_date <= @to');
    params.to = query.to;
  }
  return { status: 200, rows: db().prepare(`SELECT * FROM activities WHERE ${clauses.join(' AND ')} ORDER BY activity_date DESC, id DESC`).all(params) };
}

api.get('/activities', requireCap('activities.read'), (req, res) => {
  const result = listActivities(me(req), req.query);
  if (result.status === 403) return void forbidden(res);
  res.json({ rows: result.rows });
});

api.get('/activities/:id', requireCap('activities.read'), (req, res) => {
  const user = me(req);
  const row = db().prepare('SELECT * FROM activities WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), user.tenant_id) as { rep_id: number } | undefined;
  if (!row) return void notFound(res);
  if (!can(user.role, 'activities.read_all') && row.rep_id !== user.id) return void forbidden(res);
  res.json(row);
});

export function createActivity(user: AuthUser, body: Record<string, unknown>): { status: number; body: unknown } {
  const source = db().prepare('SELECT * FROM referral_sources WHERE id = ? AND tenant_id = ?').get(idParam(body.referral_source_id), user.tenant_id) as SourceRow | undefined;
  if (!source) return { status: 404, body: { error: 'NOT_FOUND' } };
  let repId = user.id;
  if (can(user.role, 'activities.write_any')) {
    repId = body.rep_id === undefined || body.rep_id === '' ? source.owner_rep_id : idParam(body.rep_id);
    if (!tenantRep(user.tenant_id, repId)) return { status: 400, body: { error: 'INVALID_REQUEST', message: 'rep_id must be a rep in this tenant' } };
  } else if (source.owner_rep_id !== user.id || (body.rep_id !== undefined && body.rep_id !== '' && idParam(body.rep_id) !== user.id)) {
    return { status: 403, body: { error: 'FORBIDDEN' } };
  }
  const type = String(body.activity_type ?? '');
  const date = String(body.activity_date ?? '');
  if (!ACTIVITY_TYPES.includes(type) || !DATE.test(date)) return { status: 400, body: { error: 'INVALID_REQUEST', message: 'activity_type and activity_date (YYYY-MM-DD) are required' } };
  const id = db().prepare('INSERT INTO activities (tenant_id, referral_source_id, rep_id, activity_type, activity_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(user.tenant_id, source.id, repId, type, date, String(body.notes ?? ''), nowIso()).lastInsertRowid;
  return { status: 201, body: db().prepare('SELECT * FROM activities WHERE id = ?').get(id) };
}

api.post('/activities', requireCap('activities.write'), (req, res) => {
  const result = createActivity(me(req), req.body ?? {});
  res.status(result.status).json(result.body);
});

// ---------------------------------------------------------------- referrals and admissions

interface ReferralRow {
  id: number;
  tenant_id: number;
  referral_source_id: number;
  assigned_rep_id: number;
  status: string;
}

api.get('/referrals', (req, res) => {
  const user = me(req);
  const clauses = ['tenant_id = @tenant'];
  const params: Record<string, unknown> = { tenant: user.tenant_id };
  if (!can(user.role, 'referrals.read_all')) {
    clauses.push('assigned_rep_id = @self');
    params.self = user.id;
  } else if (req.query.assigned_rep_id !== undefined) {
    clauses.push('assigned_rep_id = @rep');
    params.rep = idParam(req.query.assigned_rep_id);
  }
  if (req.query.referral_source_id !== undefined) {
    clauses.push('referral_source_id = @source');
    params.source = idParam(req.query.referral_source_id);
  }
  if (typeof req.query.status === 'string' && REFERRAL_STATUSES.includes(req.query.status)) {
    clauses.push('status = @status');
    params.status = req.query.status;
  }
  res.json({ rows: db().prepare(`SELECT id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at FROM referrals WHERE ${clauses.join(' AND ')} ORDER BY received_at DESC, id DESC`).all(params) });
});

api.get('/referrals/:id', (req, res) => {
  const user = me(req);
  const row = db().prepare('SELECT id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at FROM referrals WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), user.tenant_id) as ReferralRow | undefined;
  if (!row) return void notFound(res);
  if (!can(user.role, 'referrals.read_all') && row.assigned_rep_id !== user.id) return void forbidden(res);
  res.json(row);
});

api.post('/referrals', requireCap('referrals.write'), (req, res) => {
  const user = me(req);
  const source = db().prepare('SELECT * FROM referral_sources WHERE id = ? AND tenant_id = ?').get(idParam(req.body?.referral_source_id), user.tenant_id) as SourceRow | undefined;
  if (!source) return void notFound(res);
  const now = nowIso();
  const id = db().prepare("INSERT INTO referrals (tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at) VALUES (?, ?, ?, 'received', ?, ?)").run(user.tenant_id, source.id, source.owner_rep_id, now, now).lastInsertRowid;
  res.status(201).json(db().prepare('SELECT id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at FROM referrals WHERE id = ?').get(id));
});

export async function updateReferralStatus(user: AuthUser, id: number, status: unknown): Promise<{ status: number; body: unknown }> {
  const row = db().prepare('SELECT * FROM referrals WHERE id = ? AND tenant_id = ?').get(id, user.tenant_id) as ReferralRow | undefined;
  if (!row) return { status: 404, body: { error: 'NOT_FOUND' } };
  if (typeof status !== 'string' || !REFERRAL_STATUSES.includes(status)) return { status: 400, body: { error: 'INVALID_REQUEST', message: 'status is invalid' } };
  db().prepare('UPDATE referrals SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), row.id);
  if (status === 'accepted' && row.status !== 'accepted') {
    const rep = db().prepare('SELECT email FROM users WHERE id = ?').get(row.assigned_rep_id) as { email: string };
    await dispatch({ tenantId: user.tenant_id, type: 'email', destination: `mailto:${rep.email}`, payload: { template: 'referral-accepted', referral_id: row.id } });
    await dispatch({ tenantId: user.tenant_id, type: 'webhook', destination: tenantWebhook(user.tenant_id), payload: { event: 'referral.accepted', referral_id: row.id } });
  }
  return { status: 200, body: db().prepare('SELECT id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at FROM referrals WHERE id = ?').get(row.id) };
}

api.patch('/referrals/:id', requireCap('referrals.write'), async (req, res) => {
  const result = await updateReferralStatus(me(req), idParam(req.params.id), req.body?.status);
  res.status(result.status).json(result.body);
});

api.get('/admissions', requireCap('admissions.read'), (req, res) => {
  res.json({ rows: db().prepare('SELECT * FROM admissions WHERE tenant_id = ? ORDER BY admitted_at DESC, id DESC').all(me(req).tenant_id) });
});

api.get('/admissions/:id', requireCap('admissions.read'), (req, res) => {
  const row = db().prepare('SELECT * FROM admissions WHERE id = ? AND tenant_id = ?').get(idParam(req.params.id), me(req).tenant_id);
  if (!row) return void notFound(res);
  res.json(row);
});

api.post('/admissions', requireCap('admissions.write'), async (req, res) => {
  const user = me(req);
  const referral = db().prepare('SELECT * FROM referrals WHERE id = ? AND tenant_id = ?').get(idParam(req.body?.referral_id), user.tenant_id) as ReferralRow | undefined;
  if (!referral) return void notFound(res);
  if (referral.status !== 'accepted') return void res.status(409).json({ error: 'CONFLICT', message: 'referral is not accepted' });
  if (db().prepare('SELECT 1 FROM admissions WHERE referral_id = ?').get(referral.id)) return void res.status(409).json({ error: 'CONFLICT', message: 'referral already admitted' });
  const now = nowIso();
  const id = db().prepare('INSERT INTO admissions (tenant_id, referral_id, admitted_at, created_at) VALUES (?, ?, ?, ?)').run(user.tenant_id, referral.id, now, now).lastInsertRowid;
  await dispatch({ tenantId: user.tenant_id, type: 'webhook', destination: tenantWebhook(user.tenant_id), payload: { event: 'admission.created', admission_id: Number(id), referral_id: referral.id } });
  res.status(201).json(db().prepare('SELECT * FROM admissions WHERE id = ?').get(id));
});

// ---------------------------------------------------------------- reports, exports, search

api.get('/reports/summary', requireCap('reports.read'), (req, res) => {
  const range = parseRange(req.query);
  res.json({ filter: { ...range }, totals: summaryReport(me(req).tenant_id, range) });
});
api.get('/reports/weekly', requireCap('reports.read'), (req, res) => {
  const range = parseRange(req.query);
  res.json({ filter: { field: 'activity_date', ...range }, rows: weeklyReport(me(req).tenant_id, range) });
});
api.get('/reports/monthly', requireCap('reports.read'), (req, res) => {
  const range = parseRange(req.query);
  res.json({ filter: { field: 'activity_date', ...range }, rows: monthlyReport(me(req).tenant_id, range) });
});
api.get('/reports/by-rep', requireCap('reports.read'), (req, res) => {
  const range = parseRange(req.query);
  res.json({ filter: { ...range }, rows: byRepReport(me(req).tenant_id, range) });
});
api.get('/reports/by-source', requireCap('reports.read'), (req, res) => {
  const range = parseRange(req.query);
  res.json({ filter: { ...range }, rows: bySourceReport(me(req).tenant_id, range) });
});

function csv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const cell = (value: unknown) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((c) => cell(row[c])).join(','))].join('\n') + '\n';
}

api.get('/export/activities.csv', requireCap('exports.read'), (req, res) => {
  const range = parseRange(req.query);
  const rows = db().prepare('SELECT * FROM activities WHERE tenant_id = ? AND activity_date BETWEEN ? AND ? ORDER BY id').all(me(req).tenant_id, range.from, range.to) as Array<Record<string, unknown>>;
  res.type('text/csv').send(csv(rows, ['id', 'tenant_id', 'referral_source_id', 'rep_id', 'activity_type', 'activity_date', 'notes', 'created_at']));
});

api.get('/export/referrals.csv', requireCap('exports.read'), (req, res) => {
  const range = parseRange(req.query);
  const rows = db().prepare('SELECT * FROM referrals WHERE tenant_id = ? AND substr(received_at, 1, 10) BETWEEN ? AND ? ORDER BY id').all(me(req).tenant_id, range.from, range.to) as Array<Record<string, unknown>>;
  res.type('text/csv').send(csv(rows, ['id', 'tenant_id', 'referral_source_id', 'assigned_rep_id', 'status', 'received_at', 'updated_at']));
});

api.get('/search', (req, res) => {
  const user = me(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const scope = can(user.role, 'sources.read_all') ? '' : 'AND owner_rep_id = @self';
  const rows = db().prepare(`SELECT id, tenant_id, business_name, business_type, owner_rep_id FROM referral_sources WHERE tenant_id = @tenant ${scope} AND business_name LIKE @q ORDER BY id LIMIT 50`).all({ tenant: user.tenant_id, self: user.id, q: `%${q}%` });
  res.json({ rows });
});

// ---------------------------------------------------------------- outreach and billing (outbound actions)

api.post('/outreach/campaigns', requireCap('outreach.send'), async (req, res) => {
  const user = me(req);
  const channel = req.body?.channel;
  if (!['advertisement', 'sms', 'email'].includes(channel)) return void invalid(res, 'channel must be advertisement, sms or email');
  const destination = channel === 'advertisement' ? 'https://ads.partner.example/campaigns' : channel === 'sms' ? 'sms:+15550100000' : `mailto:team@${user.email.split('@')[1]}`;
  const event = await dispatch({ tenantId: user.tenant_id, type: channel, destination, payload: { message: String(req.body?.message ?? ''), audience: String(req.body?.audience ?? 'referral-sources') } });
  res.status(201).json({ event_id: event.id, status: event.status });
});

api.post('/billing/charges', requireCap('billing.charge'), async (req, res) => {
  const user = me(req);
  const amount = Number(req.body?.amount_cents);
  if (!Number.isInteger(amount) || amount <= 0) return void invalid(res, 'amount_cents must be a positive integer');
  const event = await dispatch({ tenantId: user.tenant_id, type: 'charge', destination: 'https://billing.partner.example/v1/charges', payload: { amount_cents: amount, description: String(req.body?.description ?? '') } });
  res.status(201).json({ event_id: event.id, status: event.status });
});
