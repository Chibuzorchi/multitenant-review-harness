import type { Target } from '../../adapters';
import type { ActivityRow, AdmissionRow, ReferralRow } from '../../adapters/database';
import { ATTRIBUTION, type DateRange, type Metric, type ReportDefinition } from '../../config/reports';

/**
 * Independent recalculation of report figures from source rows. Nothing here
 * calls the application: rows come from the system of record and are counted
 * with the agreed definitions in config/reports.ts.
 */

export interface SourceRows {
  tenantId: number;
  activities: ActivityRow[];
  referrals: ReferralRow[];
  admissions: Array<AdmissionRow & { referral_source_id: number; assigned_rep_id: number }>;
  repIds: number[];
  sourceIds: number[];
}

export type Table = Map<string, Record<string, number>>;
export type Fields = Record<Metric, string>;

export function pullSourceRows(target: Target, tenantId: number): SourceRows {
  const db = target.database;
  const referrals = db.referrals(tenantId);
  const byId = new Map(referrals.map((row) => [row.id, row]));
  return {
    tenantId,
    activities: db.activities(tenantId),
    referrals,
    admissions: db.admissions(tenantId).map((row) => ({ ...row, referral_source_id: byId.get(row.referral_id)?.referral_source_id ?? -1, assigned_rep_id: byId.get(row.referral_id)?.assigned_rep_id ?? -1 })),
    repIds: db.users(tenantId).filter((user) => user.role === 'rep').map((user) => user.id),
    sourceIds: db.sources(tenantId).map((row) => row.id),
  };
}

export const day = (value: unknown): string => String(value ?? '').slice(0, 10);

export function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

const inRange = (date: string, range: DateRange) => date >= range.from && date <= range.to;
const field = (row: object, name: string) => day((row as Record<string, unknown>)[name]);

/**
 * Counts source rows into the buckets of one report. `bucketBy` is the field a
 * row is attributed to; `filterBy` is the field the date range applies to.
 * With the agreed definitions both are ATTRIBUTION.
 */
export function recalculate(rows: SourceRows, report: ReportDefinition, range: DateRange, bucketBy: Fields = ATTRIBUTION, filterBy: Fields = ATTRIBUTION): Table {
  const table: Table = new Map();
  const blank = () => Object.fromEntries(report.metrics.map((metric) => [metric, 0]));
  const add = (key: string, metric: string) => {
    if (!report.metrics.includes(metric)) return;
    if (!table.has(key)) table.set(key, blank());
    table.get(key)![metric] += 1;
  };
  const keyOf = (date: string, repId: number, sourceId: number): string => {
    switch (report.bucket) {
      case 'none':
        return 'total';
      case 'week':
        return weekStart(date);
      case 'month':
        return date.slice(0, 7);
      case 'rep':
        return String(repId);
      case 'source':
        return String(sourceId);
    }
  };
  // Per-rep and per-source reports list every rep or source, including those with nothing in range.
  if (report.bucket === 'rep') for (const id of rows.repIds) table.set(String(id), blank());
  if (report.bucket === 'source') for (const id of rows.sourceIds) table.set(String(id), blank());
  if (report.bucket === 'none') table.set('total', blank());

  for (const row of rows.activities) {
    if (!inRange(field(row, filterBy.activities), range)) continue;
    const key = keyOf(field(row, bucketBy.activities), row.rep_id, row.referral_source_id);
    if (report.bucket === 'rep' && !rows.repIds.includes(row.rep_id)) continue;
    add(key, 'activities');
    add(key, `${row.activity_type}s`);
  }
  for (const row of rows.referrals) {
    if (!inRange(field(row, filterBy.referrals), range)) continue;
    if (report.bucket === 'rep' && !rows.repIds.includes(row.assigned_rep_id)) continue;
    add(keyOf(field(row, bucketBy.referrals), row.assigned_rep_id, row.referral_source_id), 'referrals');
  }
  for (const row of rows.admissions) {
    if (!inRange(field(row, filterBy.admissions), range)) continue;
    if (report.bucket === 'rep' && !rows.repIds.includes(row.assigned_rep_id)) continue;
    add(keyOf(field(row, bucketBy.admissions), row.assigned_rep_id, row.referral_source_id), 'admissions');
  }
  if (report.metrics.includes('admission_conversion_rate')) {
    const total = table.get('total')!;
    total.admission_conversion_rate = total.referrals === 0 ? 0 : Math.round((total.admissions / total.referrals) * 10000) / 10000;
  }
  return table;
}

/** Turns the application's response for a report into the same shape. */
export function displayedTable(report: ReportDefinition, body: unknown): Table {
  const table: Table = new Map();
  const pick = (row: Record<string, unknown>) => Object.fromEntries(report.metrics.map((metric) => [metric, Number(row[metric] ?? 0)]));
  if (report.keyField === null) {
    table.set('total', pick(((body as { totals?: Record<string, unknown> } | null)?.totals ?? {}) as Record<string, unknown>));
    return table;
  }
  for (const row of ((body as { rows?: Array<Record<string, unknown>> } | null)?.rows ?? []) as Array<Record<string, unknown>>) table.set(String(row[report.keyField]), pick(row));
  return table;
}

export interface Cell {
  bucket: string;
  metric: string;
  displayed: number;
  expected: number;
  difference: number;
}

/** Cells that differ, for the given metrics. A bucket missing on one side counts as zero. */
export function differences(displayed: Table, expected: Table, metrics: string[]): Cell[] {
  const cells: Cell[] = [];
  for (const bucket of [...new Set([...displayed.keys(), ...expected.keys()])].sort()) {
    for (const metric of metrics) {
      const shown = displayed.get(bucket)?.[metric] ?? 0;
      const want = expected.get(bucket)?.[metric] ?? 0;
      if (shown !== want) cells.push({ bucket, metric, displayed: shown, expected: want, difference: Math.round((shown - want) * 10000) / 10000 });
    }
  }
  return cells;
}

/** Other date fields a figure could have been attributed to by mistake. */
export const ALTERNATIVE_FIELDS: Record<Metric, string[]> = {
  activities: ['created_at'],
  referrals: ['updated_at'],
  admissions: ['created_at'],
};
