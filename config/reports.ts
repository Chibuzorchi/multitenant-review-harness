/**
 * Report definitions as agreed with the product owner: which date each metric
 * is attributed to and how it is bucketed. Stage 06 recalculates every figure
 * from source rows using these definitions and compares it with what the
 * application displays.
 */

export type Metric = 'activities' | 'referrals' | 'admissions';

/** The source-row field each metric is attributed to. All dates are UTC; ranges are inclusive. */
export const ATTRIBUTION: Record<Metric, string> = {
  activities: 'activity_date',
  referrals: 'received_at',
  admissions: 'admitted_at',
};

export const WEEK_STARTS_ON = 'monday';

export interface ReportDefinition {
  id: 'summary' | 'weekly' | 'monthly' | 'by-rep' | 'by-source';
  path: string;
  bucket: 'none' | 'week' | 'month' | 'rep' | 'source';
  /** Name of the bucket key in each returned row. */
  keyField: string | null;
  metrics: string[];
}

export const REPORTS: ReportDefinition[] = [
  { id: 'summary', path: '/api/reports/summary', bucket: 'none', keyField: null, metrics: ['activities', 'referrals', 'admissions', 'admission_conversion_rate'] },
  { id: 'weekly', path: '/api/reports/weekly', bucket: 'week', keyField: 'week_start', metrics: ['activities', 'referrals', 'admissions'] },
  { id: 'monthly', path: '/api/reports/monthly', bucket: 'month', keyField: 'month', metrics: ['activities', 'visits', 'calls', 'notes', 'referrals', 'admissions'] },
  { id: 'by-rep', path: '/api/reports/by-rep', bucket: 'rep', keyField: 'rep_id', metrics: ['activities', 'referrals', 'admissions'] },
  { id: 'by-source', path: '/api/reports/by-source', bucket: 'source', keyField: 'referral_source_id', metrics: ['activities', 'referrals', 'admissions'] },
];

/** Metrics derived from activity rows share one attribution rule, so they share one finding key. */
export const ACTIVITY_METRICS = ['activities', 'visits', 'calls', 'notes'];

export interface DateRange {
  id: string;
  label: string;
  from: string;
  to: string;
}

/** Ranges chosen to exercise month and week boundaries, not just the happy path. */
export const RANGES: DateRange[] = [
  { id: 'full-window', label: 'Full seeded window', from: '2026-07-01', to: '2026-09-30' },
  { id: 'calendar-month', label: 'One calendar month', from: '2026-08-01', to: '2026-08-31' },
  { id: 'cross-month', label: 'Range crossing a month boundary', from: '2026-07-20', to: '2026-08-10' },
  { id: 'single-week', label: 'One Monday-to-Sunday week', from: '2026-09-07', to: '2026-09-13' },
];

export const EXPORTS = [
  { id: 'activities', path: '/api/export/activities.csv', metric: 'activities' as Metric },
  { id: 'referrals', path: '/api/export/referrals.csv', metric: 'referrals' as Metric },
];

/** Where the same figures are displayed in the UI. */
export const REPORT_UI = {
  path: '/reports',
  summaryMetric: (metric: Metric) => `[data-report="summary"] [data-metric="${metric}"]`,
  table: (report: 'monthly' | 'weekly') => `table[data-report="${report}"]`,
};
