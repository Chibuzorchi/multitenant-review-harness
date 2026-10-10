import { Router, type Request, type Response } from 'express';
import { checkCredentials, clearSessionCookie, issueCredential, requireUiAuth, revokeSession, setSessionCookie, type AuthUser } from '../auth';
import { config, ROLES } from '../config';
import { audit, db, nowIso } from '../db';
import { patientModuleEnabled } from '../features';
import { can, type Capability } from '../policy';
import { monthlyReport, parseRange, summaryReport, weeklyReport } from '../reports';
import { hashPassword, sha256 } from '../security';
import { esc, layout, table } from '../views';
import { createActivity, listActivities, updateReferralStatus } from './api';

export const ui = Router();

type Row = Record<string, unknown>;
const me = (req: Request): AuthUser => req.auth!.user;

function denied(req: Request, res: Response): void {
  res.status(403).send(layout({ title: 'Not permitted', page: 'forbidden', user: me(req), body: '<h1>Not permitted</h1><p>Your role does not have access to this page.</p>' }));
}

function missing(req: Request, res: Response): void {
  res.status(404).send(layout({ title: 'Not found', page: 'not-found', user: me(req), body: '<h1>Not found</h1>' }));
}

function needs(capability: Capability) {
  return (req: Request, res: Response, next: () => void) => (can(me(req).role, capability) ? next() : denied(req, res));
}

ui.get('/login', (req, res) => {
  if (req.auth?.kind === 'browser') return void res.redirect(303, '/');
  res.send(loginPage());
});

function loginPage(error?: string): string {
  return layout({
    title: 'Sign in',
    page: 'login',
    body: `<div class="card"><h1>Sign in</h1>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post" action="/login"><label>Email<input name="email" type="email" required autocomplete="username"></label><br>
<label>Password<input name="password" type="password" required autocomplete="current-password"></label><br>
<button type="submit">Sign in</button></form></div>`,
  });
}

ui.post('/login', (req, res) => {
  const user = checkCredentials(req.body?.email, req.body?.password);
  if (!user) return void res.status(401).send(loginPage('Email or password is incorrect.'));
  const session = issueCredential(user, 'browser');
  setSessionCookie(res, session.secret, session.expires_at);
  res.redirect(303, '/');
});

ui.post('/logout', (req, res) => {
  if (req.auth) revokeSession(req.auth.sessionId);
  clearSessionCookie(res);
  res.redirect(303, '/login');
});

ui.use(requireUiAuth);

ui.get('/', (req, res) => {
  const user = me(req);
  let body = `<h1>Dashboard</h1><p class="muted">Signed in to tenant ${user.tenant_id} as ${esc(user.role)}.</p>`;
  if (can(user.role, 'reports.read')) {
    const range = parseRange({});
    const totals = summaryReport(user.tenant_id, range);
    body += `<div class="tiles"><div class="tile"><b>${totals.activities}</b>Activities</div><div class="tile"><b>${totals.referrals}</b>Referrals</div><div class="tile"><b>${totals.admissions}</b>Admissions</div></div>
<p class="muted">${range.from} to ${range.to}</p>`;
  }
  res.send(layout({ title: 'Dashboard', page: 'dashboard', user, body }));
});

// ---------------------------------------------------------------- referral sources

ui.get('/referral-sources', (req, res) => {
  const user = me(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const scope = can(user.role, 'sources.read_all') ? '' : 'AND owner_rep_id = @self';
  const rows = db().prepare(`SELECT * FROM referral_sources WHERE tenant_id = @tenant ${scope} AND business_name LIKE @q ORDER BY business_name`).all({ tenant: user.tenant_id, self: user.id, q: `%${q}%` }) as Row[];
  const body = `<h1>Referral sources</h1>
<form class="inline" method="get"><label>Search<input name="q" value="${esc(q)}"></label><button type="submit">Search</button></form>
${table({ columns: [['business_name', 'Business'], ['business_type', 'Type'], ['address', 'Address'], ['owner_rep_id', 'Owner rep'], ['status', 'Status']], rows, link: (row) => `/referral-sources/${row.id}`, rowAttrs: (row) => `data-id="${row.id}" data-owner-rep-id="${row.owner_rep_id}"` })}`;
  res.send(layout({ title: 'Referral sources', page: 'referral-sources', user, body }));
});

function loadSource(user: AuthUser, id: number): Row | 'forbidden' | null {
  const row = db().prepare('SELECT * FROM referral_sources WHERE id = ? AND tenant_id = ?').get(id, user.tenant_id) as Row | undefined;
  if (!row) return null;
  if (!can(user.role, 'sources.read_all') && row.owner_rep_id !== user.id) return 'forbidden';
  return row;
}

ui.get('/referral-sources/:id', (req, res) => {
  const user = me(req);
  const source = loadSource(user, Number(req.params.id));
  if (source === null) return void missing(req, res);
  if (source === 'forbidden') return void denied(req, res);
  let body = `<h1 data-testid="source-name">${esc(source.business_name)}</h1><p class="muted">${esc(source.business_type)} · ${esc(source.address)} · ${esc(source.status)}</p>`;
  const mayRead = can(user.role, 'activities.read_all') || (can(user.role, 'activities.read') && source.owner_rep_id === user.id);
  if (mayRead) {
    const activities = db().prepare('SELECT * FROM activities WHERE referral_source_id = ? AND tenant_id = ? ORDER BY activity_date DESC, id DESC').all(source.id, user.tenant_id) as Row[];
    body += `<h2>Activities</h2>`;
    if (can(user.role, 'activities.write')) {
      body += `<form class="inline" method="post" action="/referral-sources/${source.id}/activities" data-testid="activity-form">
<label>Type<select name="activity_type"><option>visit</option><option>call</option><option>note</option></select></label>
<label>Date<input name="activity_date" type="date" required></label>
<label>Notes<input name="notes" size="40" required></label><button type="submit">Log activity</button></form>`;
    }
    body += table({ columns: [['activity_date', 'Date'], ['activity_type', 'Type'], ['rep_id', 'Rep'], ['notes', 'Notes']], rows: activities, attrs: 'data-testid="activity-table"', rowAttrs: (row) => `data-id="${row.id}" data-rep-id="${row.rep_id}"` });
  }
  res.send(layout({ title: String(source.business_name), page: 'referral-source', user, body }));
});

ui.post('/referral-sources/:id/activities', needs('activities.write'), (req, res) => {
  const result = createActivity(me(req), { ...req.body, referral_source_id: Number(req.params.id) });
  if (result.status === 403) return void denied(req, res);
  if (result.status === 404) return void missing(req, res);
  res.redirect(303, `/referral-sources/${Number(req.params.id)}`);
});

// ---------------------------------------------------------------- activities

ui.get('/activities', needs('activities.read'), (req, res) => {
  const user = me(req);
  const manager = can(user.role, 'activities.read_all');
  // Reps always see their own activity here; the rep filter is offered to managers only.
  const result = listActivities(user, manager ? req.query : {});
  const rows = (result.status === 200 ? result.rows : []) as Row[];
  let filter = '';
  if (manager) {
    const reps = db().prepare("SELECT id, name FROM users WHERE tenant_id = ? AND role = 'rep' ORDER BY name").all(user.tenant_id) as Array<{ id: number; name: string }>;
    filter = `<form class="inline" method="get"><label>Rep<select name="rep_id"><option value="">All reps</option>${reps.map((rep) => `<option value="${rep.id}" ${String(req.query.rep_id) === String(rep.id) ? 'selected' : ''}>${esc(rep.name)}</option>`).join('')}</select></label><button type="submit">Filter</button></form>`;
  }
  const body = `<h1>Activities</h1>${filter}${table({ columns: [['activity_date', 'Date'], ['activity_type', 'Type'], ['rep_id', 'Rep'], ['referral_source_id', 'Source'], ['notes', 'Notes']], rows: rows.slice(0, 300), attrs: 'data-testid="activity-table"', rowAttrs: (row) => `data-id="${row.id}" data-rep-id="${row.rep_id}"` })}`;
  res.send(layout({ title: 'Activities', page: 'activities', user, body }));
});

// ---------------------------------------------------------------- referrals

ui.get('/referrals', (req, res) => {
  const user = me(req);
  const scope = can(user.role, 'referrals.read_all') ? '' : 'AND assigned_rep_id = @self';
  const rows = db().prepare(`SELECT * FROM referrals WHERE tenant_id = @tenant ${scope} ORDER BY received_at DESC, id DESC LIMIT 300`).all({ tenant: user.tenant_id, self: user.id }) as Row[];
  const body = `<h1>Referrals</h1>${table({ columns: [['id', 'Referral'], ['status', 'Status'], ['referral_source_id', 'Source'], ['assigned_rep_id', 'Assigned rep'], ['received_at', 'Received']], rows, link: (row) => `/referrals/${row.id}`, rowAttrs: (row) => `data-id="${row.id}" data-rep-id="${row.assigned_rep_id}"` })}`;
  res.send(layout({ title: 'Referrals', page: 'referrals', user, body }));
});

ui.get('/referrals/:id', (req, res) => {
  const user = me(req);
  const row = db().prepare('SELECT * FROM referrals WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), user.tenant_id) as Row | undefined;
  if (!row) return void missing(req, res);
  if (!can(user.role, 'referrals.read_all') && row.assigned_rep_id !== user.id) return void denied(req, res);
  let body = `<h1>Referral ${row.id}</h1><p>Status: <strong data-testid="referral-status">${esc(row.status)}</strong></p>
<p class="muted">Source ${row.referral_source_id} · assigned rep ${row.assigned_rep_id} · received ${esc(row.received_at)}</p>`;
  if (can(user.role, 'referrals.write')) {
    body += `<form class="inline" method="post" action="/referrals/${row.id}/status" data-testid="status-form"><label>Status<select name="status">${['received', 'in_review', 'accepted', 'declined'].map((s) => `<option ${s === row.status ? 'selected' : ''}>${s}</option>`).join('')}</select></label><button type="submit">Save</button></form>`;
  }
  res.send(layout({ title: `Referral ${row.id}`, page: 'referral', user, body }));
});

ui.post('/referrals/:id/status', needs('referrals.write'), async (req, res) => {
  const result = await updateReferralStatus(me(req), Number(req.params.id), req.body?.status);
  if (result.status === 404) return void missing(req, res);
  res.redirect(303, `/referrals/${Number(req.params.id)}`);
});

// ---------------------------------------------------------------- reports

ui.get('/reports', needs('reports.read'), (req, res) => {
  const user = me(req);
  const range = parseRange(req.query);
  const totals = summaryReport(user.tenant_id, range);
  const body = `<h1>Reports</h1>
<form class="inline" method="get"><label>Activity date from<input type="date" name="from" value="${range.from}"></label><label>Activity date to<input type="date" name="to" value="${range.to}"></label><button type="submit">Apply</button></form>
<div class="tiles" data-report="summary"><div class="tile"><b data-metric="activities">${totals.activities}</b>Activities</div><div class="tile"><b data-metric="referrals">${totals.referrals}</b>Referrals</div><div class="tile"><b data-metric="admissions">${totals.admissions}</b>Admissions</div></div>
<h2>Monthly</h2>${table({ columns: [['month', 'Month'], ['activities', 'Activities'], ['visits', 'Visits'], ['calls', 'Calls'], ['notes', 'Notes'], ['referrals', 'Referrals'], ['admissions', 'Admissions']], rows: monthlyReport(user.tenant_id, range), attrs: 'data-report="monthly"' })}
<h2>Weekly</h2>${table({ columns: [['week_start', 'Week starting'], ['activities', 'Activities'], ['referrals', 'Referrals'], ['admissions', 'Admissions']], rows: weeklyReport(user.tenant_id, range), attrs: 'data-report="weekly"' })}`;
  res.send(layout({ title: 'Reports', page: 'reports', user, body }));
});

// ---------------------------------------------------------------- user administration

ui.get('/admin/users', needs('users.admin'), (req, res) => {
  const user = me(req);
  const rows = db().prepare('SELECT id, email, name, role, active FROM users WHERE tenant_id = ? ORDER BY id').all(user.tenant_id) as Row[];
  const body = `<h1>Users</h1>
<form class="inline" method="post" action="/admin/users"><label>Email<input name="email" type="email" required></label><label>Name<input name="name" required></label>
<label>Role<select name="role">${ROLES.map((role) => `<option>${role}</option>`).join('')}</select></label><button type="submit">Add user</button></form>
${table({ columns: [['email', 'Email'], ['name', 'Name'], ['role', 'Role'], ['active', 'Active']], rows, rowAttrs: (row) => `data-id="${row.id}"` })}`;
  res.send(layout({ title: 'Users', page: 'admin-users', user, body }));
});

ui.post('/admin/users', needs('users.admin'), (req, res) => {
  const user = me(req);
  const email = String(req.body?.email ?? '').toLowerCase();
  if (email && ROLES.includes(req.body?.role) && !db().prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    const id = db().prepare('INSERT INTO users (tenant_id, email, name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)').run(user.tenant_id, email, String(req.body?.name ?? ''), req.body.role, hashPassword(config.demoPassword, sha256(email).slice(0, 16)), nowIso()).lastInsertRowid;
    audit('user.created', user.tenant_id, user.id, { user_id: Number(id) });
  }
  res.redirect(303, '/admin/users');
});

// ---------------------------------------------------------------- patient module

ui.get('/patients', (req, res) => {
  const user = me(req);
  if (!patientModuleEnabled()) {
    return void res.status(403).send(layout({ title: 'Unavailable', page: 'feature-disabled', user, body: '<h1>Unavailable</h1><p>FEATURE_DISABLED</p>' }));
  }
  if (!can(user.role, 'patients.access')) return void denied(req, res);
  const rows = db().prepare('SELECT * FROM patients WHERE tenant_id = ? ORDER BY id').all(user.tenant_id) as Row[];
  res.send(layout({ title: 'Patients', page: 'patients', user, body: `<h1>Patients</h1>${table({ columns: [['synthetic_ref', 'Reference'], ['status', 'Status']], rows, rowAttrs: (row) => `data-id="${row.id}"` })}` }));
});

ui.get('/patients/:id', (req, res) => {
  const user = me(req);
  if (!patientModuleEnabled()) {
    return void res.status(403).send(layout({ title: 'Unavailable', page: 'feature-disabled', user, body: '<h1>Unavailable</h1><p>FEATURE_DISABLED</p>' }));
  }
  if (!can(user.role, 'patients.access')) return void denied(req, res);
  const row = db().prepare('SELECT * FROM patients WHERE id = ? AND tenant_id = ?').get(Number(req.params.id), user.tenant_id) as Row | undefined;
  if (!row) return void missing(req, res);
  res.send(layout({ title: 'Patient', page: 'patient', user, body: `<h1>${esc(row.synthetic_ref)}</h1><p>${esc(row.status)}</p>` }));
});
