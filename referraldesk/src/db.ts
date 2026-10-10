import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config';

let handle: Database.Database | null = null;

export function db(): Database.Database {
  if (!handle) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    handle = new Database(config.dbPath);
    handle.pragma('journal_mode = DELETE');
    handle.pragma('busy_timeout = 5000');
    handle.pragma('foreign_keys = ON');
    handle.exec(SCHEMA);
  }
  return handle;
}

export const TABLES = [
  'audit_log',
  'outbound_events',
  'job_state',
  'job_locks',
  'job_runs',
  'weekly_report_snapshots',
  'daily_aggregates',
  'referral_inbox',
  'patient_projection_queue',
  'patient_projection',
  'patient_referral_links',
  'patients',
  'sessions',
  'admissions',
  'referrals',
  'activities',
  'referral_sources',
  'users',
  'tenants',
  'settings',
  'meta',
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  webhook_url TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referral_sources (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  business_name TEXT NOT NULL,
  business_type TEXT NOT NULL,
  address TEXT NOT NULL,
  owner_rep_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  referral_source_id INTEGER NOT NULL REFERENCES referral_sources(id),
  rep_id INTEGER NOT NULL REFERENCES users(id),
  activity_type TEXT NOT NULL,
  activity_date TEXT NOT NULL,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_tenant_date ON activities(tenant_id, activity_date);
CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  referral_source_id INTEGER NOT NULL REFERENCES referral_sources(id),
  assigned_rep_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_ref TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS admissions (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  referral_id INTEGER NOT NULL UNIQUE REFERENCES referrals(id),
  admitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tenant_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id),
  synthetic_ref TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_referral_links (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  referral_id INTEGER NOT NULL REFERENCES referrals(id)
);
CREATE TABLE IF NOT EXISTS patient_projection (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  patient_count INTEGER NOT NULL,
  linked_referrals INTEGER NOT NULL,
  queue_item_id INTEGER,
  run_id TEXT,
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS patient_projection_queue (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  requested_by INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  enqueued_at TEXT NOT NULL,
  processed_at TEXT,
  run_id TEXT
);
CREATE TABLE IF NOT EXISTS referral_inbox (
  id INTEGER PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  external_ref TEXT NOT NULL UNIQUE,
  referral_source_id INTEGER NOT NULL,
  assigned_rep_id INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS daily_aggregates (
  tenant_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  activities INTEGER NOT NULL,
  referrals INTEGER NOT NULL,
  admissions INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, date)
);
CREATE TABLE IF NOT EXISTS weekly_report_snapshots (
  tenant_id INTEGER NOT NULL,
  week_start TEXT NOT NULL,
  payload TEXT NOT NULL,
  run_id TEXT NOT NULL,
  PRIMARY KEY (tenant_id, week_start)
);
CREATE TABLE IF NOT EXISTS job_runs (
  run_id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  scheduled_for TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  records_written INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS job_locks (
  job_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_state (
  job_name TEXT PRIMARY KEY,
  last_success_for TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbound_events (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER,
  type TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  transport TEXT NOT NULL,
  dedupe_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  tenant_id INTEGER,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function getSetting(key: string, fallback: string): string {
  const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export function getMeta(key: string): string | null {
  const row = db().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function audit(action: string, tenantId: number | null, userId: number | null, detail?: unknown): void {
  db()
    .prepare('INSERT INTO audit_log (ts, tenant_id, user_id, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(nowIso(), tenantId, userId, action, detail === undefined ? null : JSON.stringify(detail));
}
