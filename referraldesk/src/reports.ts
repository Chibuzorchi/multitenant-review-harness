import { db, getMeta } from './db';

/**
 * Report formulas (all dates UTC, ranges inclusive):
 *   activities  are attributed to activity_date
 *   referrals   are attributed to the date part of received_at
 *   admissions  are attributed to the date part of admitted_at
 * Weeks start on Monday.
 */

export interface Range {
  from: string;
  to: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(query: Record<string, unknown>): Range {
  const from = typeof query.from === 'string' && DATE.test(query.from) ? query.from : getMeta('seed_window_start') ?? '1970-01-01';
  const to = typeof query.to === 'string' && DATE.test(query.to) ? query.to : getMeta('seed_window_end') ?? '9999-12-31';
  return { from, to };
}

export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

type DayCount = { day: string; n: number };

function activityDays(tenantId: number, range: Range): DayCount[] {
  return db()
    .prepare('SELECT activity_date AS day, COUNT(*) AS n FROM activities WHERE tenant_id = ? AND activity_date BETWEEN ? AND ? GROUP BY activity_date')
    .all(tenantId, range.from, range.to) as DayCount[];
}

function referralDays(tenantId: number, range: Range): DayCount[] {
  return db()
    .prepare('SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS n FROM referrals WHERE tenant_id = ? AND substr(received_at, 1, 10) BETWEEN ? AND ? GROUP BY day')
    .all(tenantId, range.from, range.to) as DayCount[];
}

function admissionDays(tenantId: number, range: Range): DayCount[] {
  return db()
    .prepare('SELECT substr(admitted_at, 1, 10) AS day, COUNT(*) AS n FROM admissions WHERE tenant_id = ? AND substr(admitted_at, 1, 10) BETWEEN ? AND ? GROUP BY day')
    .all(tenantId, range.from, range.to) as DayCount[];
}

function bucket(rows: DayCount[], keyOf: (day: string) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) out.set(keyOf(row.day), (out.get(keyOf(row.day)) ?? 0) + row.n);
  return out;
}

export function weeklyReport(tenantId: number, range: Range) {
  const activities = bucket(activityDays(tenantId, range), weekStart);
  const referrals = bucket(referralDays(tenantId, range), weekStart);
  const admissions = bucket(admissionDays(tenantId, range), weekStart);
  const weeks = [...new Set([...activities.keys(), ...referrals.keys(), ...admissions.keys()])].sort();
  return weeks.map((week_start) => ({
    week_start,
    activities: activities.get(week_start) ?? 0,
    referrals: referrals.get(week_start) ?? 0,
    admissions: admissions.get(week_start) ?? 0,
  }));
}

export function monthlyReport(tenantId: number, range: Range) {
  const activityRows = db()
    .prepare(
      `SELECT substr(activity_date, 1, 7) AS month,
              COUNT(*) AS activities,
              SUM(activity_type = 'visit') AS visits,
              SUM(activity_type = 'call') AS calls,
              SUM(activity_type = 'note') AS notes
         FROM activities
        WHERE tenant_id = ? AND substr(activity_date, 1, 10) BETWEEN ? AND ?
        GROUP BY month`,
    )
    .all(tenantId, range.from, range.to) as Array<{ month: string; activities: number; visits: number; calls: number; notes: number }>;
  const byMonth = new Map(activityRows.map((row) => [row.month, row]));
  const referrals = bucket(referralDays(tenantId, range), (day) => day.slice(0, 7));
  const admissions = bucket(admissionDays(tenantId, range), (day) => day.slice(0, 7));
  const months = [...new Set([...byMonth.keys(), ...referrals.keys(), ...admissions.keys()])].sort();
  return months.map((month) => ({
    month,
    activities: byMonth.get(month)?.activities ?? 0,
    visits: byMonth.get(month)?.visits ?? 0,
    calls: byMonth.get(month)?.calls ?? 0,
    notes: byMonth.get(month)?.notes ?? 0,
    referrals: referrals.get(month) ?? 0,
    admissions: admissions.get(month) ?? 0,
  }));
}

export function byRepReport(tenantId: number, range: Range) {
  return db()
    .prepare(
      `SELECT u.id AS rep_id, u.name AS rep_name,
              (SELECT COUNT(*) FROM activities a WHERE a.tenant_id = u.tenant_id AND a.rep_id = u.id AND a.activity_date BETWEEN @from AND @to) AS activities,
              (SELECT COUNT(*) FROM referrals r WHERE r.tenant_id = u.tenant_id AND r.assigned_rep_id = u.id AND substr(r.received_at, 1, 10) BETWEEN @from AND @to) AS referrals,
              (SELECT COUNT(*) FROM admissions m JOIN referrals r ON r.id = m.referral_id
                WHERE m.tenant_id = u.tenant_id AND r.assigned_rep_id = u.id AND substr(m.admitted_at, 1, 10) BETWEEN @from AND @to) AS admissions
         FROM users u
        WHERE u.tenant_id = @tenant AND u.role = 'rep'
        ORDER BY u.id`,
    )
    .all({ tenant: tenantId, from: range.from, to: range.to });
}

export function bySourceReport(tenantId: number, range: Range) {
  return db()
    .prepare(
      `SELECT s.id AS referral_source_id, s.business_name,
              (SELECT COUNT(*) FROM activities a WHERE a.tenant_id = s.tenant_id AND a.referral_source_id = s.id AND a.activity_date BETWEEN @from AND @to) AS activities,
              (SELECT COUNT(*) FROM referrals r WHERE r.tenant_id = s.tenant_id AND r.referral_source_id = s.id AND substr(r.received_at, 1, 10) BETWEEN @from AND @to) AS referrals,
              (SELECT COUNT(*) FROM admissions m JOIN referrals r ON r.id = m.referral_id
                WHERE m.tenant_id = s.tenant_id AND r.referral_source_id = s.id AND substr(m.admitted_at, 1, 10) BETWEEN @from AND @to) AS admissions
         FROM referral_sources s
        WHERE s.tenant_id = @tenant
        ORDER BY s.id`,
    )
    .all({ tenant: tenantId, from: range.from, to: range.to });
}

export function summaryReport(tenantId: number, range: Range) {
  const sum = (rows: DayCount[]) => rows.reduce((total, row) => total + row.n, 0);
  const activities = sum(activityDays(tenantId, range));
  const referrals = sum(referralDays(tenantId, range));
  const admissions = sum(admissionDays(tenantId, range));
  return {
    activities,
    referrals,
    admissions,
    admission_conversion_rate: referrals === 0 ? 0 : Math.round((admissions / referrals) * 10000) / 10000,
  };
}
