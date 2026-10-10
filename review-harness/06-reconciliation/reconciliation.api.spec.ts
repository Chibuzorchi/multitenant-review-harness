import { rolesWith } from '../../config/permissions';
import { ACTIVITY_METRICS, ATTRIBUTION, EXPORTS, RANGES, REPORTS, type Metric } from '../../config/reports';
import { TENANTS, account } from '../../config/roles';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { ALTERNATIVE_FIELDS, day, differences, displayedTable, pullSourceRows, recalculate, type Fields } from '../lib/recalc';
import { tenantId } from '../lib/subjects';

/**
 * Stage 06. Every reported figure is recalculated from source rows read
 * directly from the database, using the agreed definitions, and compared with
 * what the application returns. A difference is reported with the rows, the
 * calculation, the displayed value, the expected value and the difference.
 */

const cls = CLASSES.reconciliation;
const readers = rolesWith('reports.read');

const metricOf = (name: string): Metric => (ACTIVITY_METRICS.includes(name) ? 'activities' : name === 'admission_conversion_rate' ? 'admissions' : (name as Metric));
const familyOf = (name: string): string => (ACTIVITY_METRICS.includes(name) ? 'activity-attribution' : name === 'admission_conversion_rate' ? 'conversion-rate' : `${name}-attribution`);

test.describe('06 reconciliation · API', () => {
  for (const tenant of TENANTS) {
    for (const report of REPORTS) {
      test(`${report.id} report reconciles with source rows · tenant ${tenant.key}`, async ({ target, review, credentials, request }) => {
        const tid = tenantId(target, tenant.key);
        const rows = pullSourceRows(target, tid);
        const headers = await credentials.as(account(tenant.key, 'executive'));
        const families = [...new Set(report.metrics.map(familyOf))];

        for (const range of RANGES) {
          const exchange = await target.api.call(request, { method: 'GET', path: `${report.path}?from=${range.from}&to=${range.to}`, headers });
          const displayed = displayedTable(report, exchange.json);
          const expected = recalculate(rows, report, range);

          for (const family of families) {
            const metrics = report.metrics.filter((metric) => familyOf(metric) === family);
            const cells = exchange.status === 200 ? differences(displayed, expected, metrics) : [];
            const ok = exchange.status === 200 && cells.length === 0;
            const metric = metricOf(metrics[0]);
            const agreed = ATTRIBUTION[metric];

            // If the displayed figures are reproduced exactly by attributing rows to a different date field, say which.
            let signal = 'figures-differ-from-source-rows';
            let explanation: string | null = null;
            let sample: unknown[] = [];
            if (!ok && exchange.status === 200) {
              for (const alternative of ALTERNATIVE_FIELDS[metric]) {
                const bucketBy: Fields = { ...ATTRIBUTION, [metric]: alternative };
                const variants: Array<[string, Fields]> = [
                  [`bucketed by ${alternative}, range applied to ${agreed}`, ATTRIBUTION],
                  [`bucketed by and range applied to ${alternative}`, bucketBy],
                ];
                const match = variants.find(([, filterBy]) => differences(displayed, recalculate(rows, report, range, bucketBy, filterBy), metrics).length === 0);
                if (match) {
                  signal = `attributed-by:${alternative}`;
                  explanation = `The displayed figures are reproduced exactly when rows are ${match[0]} instead of ${agreed}.`;
                  const source = metric === 'activities' ? rows.activities : metric === 'referrals' ? rows.referrals : rows.admissions;
                  const bucketOf = (value: string) => (report.bucket === 'month' ? value.slice(0, 7) : value);
                  sample = (source as unknown as Array<Record<string, unknown>>)
                    .filter((row) => day(row[agreed]) >= range.from && day(row[agreed]) <= range.to && bucketOf(day(row[agreed])) !== bucketOf(day(row[alternative])))
                    .slice(0, 12)
                    .map((row) => ({ id: row.id, [agreed]: row[agreed], [alternative]: row[alternative], counted_in: bucketOf(day(row[alternative])), belongs_in: bucketOf(day(row[agreed])) }));
                  break;
                }
              }
            }
            const first = cells[0];
            review.verify(ok, {
              cls,
              key: `reconciliation/${report.id}/${family}`,
              title: family === 'activity-attribution' ? `The ${report.id} report attributes activities to the wrong period` : `The ${report.id} report's ${metrics.join(', ')} figures do not match the source rows`,
              label: `${tenant.key} ${range.id}`,
              route: `GET ${report.path}`,
              roles: readers,
              tenants: [tenant.key],
              expected: `every ${metrics.join('/')} figure equals the count of source rows attributed by ${agreed}, ${range.from} to ${range.to} inclusive`,
              actual: exchange.status !== 200 ? `HTTP ${exchange.status}` : ok ? 'all figures match' : `${cells.length} figure(s) differ; e.g. ${first.metric} for ${first.bucket}: displayed ${first.displayed}, expected ${first.expected} (difference ${first.difference})`,
              preconditions: ['Seeded data set, unmodified.', `Signed in as an executive of tenant ${tenant.key}; every role with report access sees the same figures.`],
              steps: [`GET ${report.path}?from=${range.from}&to=${range.to}.`, `Read the tenant's ${metric} rows directly from the database.`, `Count rows whose ${agreed} date falls in the range, bucketed by ${report.bucket === 'none' ? 'nothing (totals)' : report.bucket} using the same ${agreed} date.`, 'Compare each displayed figure with the recalculated one.'],
              exchange,
              data: {
                range,
                agreed_definition: `${metric} are attributed to ${agreed}; ranges are inclusive; dates are UTC`,
                calculation: `count(${metric} rows where ${range.from} <= date(${agreed}) <= ${range.to}) grouped by ${report.bucket}`,
                source_row_count: metric === 'activities' ? rows.activities.length : metric === 'referrals' ? rows.referrals.length : rows.admissions.length,
                differing_figures: cells.slice(0, 40),
                differing_figure_count: cells.length,
                explanation,
                source_rows_counted_in_the_wrong_bucket: sample,
              },
              signal,
            });
          }
        }
      });
    }

    test(`reports agree with each other and with exports · tenant ${tenant.key}`, async ({ target, review, credentials, request }) => {
      const tid = tenantId(target, tenant.key);
      const rows = pullSourceRows(target, tid);
      const headers = await credentials.as(account(tenant.key, 'operations_manager'));
      for (const range of RANGES) {
        const query = `?from=${range.from}&to=${range.to}`;
        const total = displayedTable(REPORTS[0], (await target.api.call(request, { method: 'GET', path: `${REPORTS[0].path}${query}`, headers })).json).get('total') ?? {};
        const sums: Record<string, Record<string, number>> = {};
        for (const report of REPORTS.filter((entry) => ['weekly', 'monthly', 'by-source'].includes(entry.id))) {
          const table = displayedTable(report, (await target.api.call(request, { method: 'GET', path: `${report.path}${query}`, headers })).json);
          sums[report.id] = Object.fromEntries((['activities', 'referrals', 'admissions'] as const).map((metric) => [metric, [...table.values()].reduce((sum, row) => sum + (row[metric] ?? 0), 0)]));
        }
        const disagreeing = Object.entries(sums).flatMap(([id, sum]) => Object.entries(sum).filter(([metric, value]) => value !== total[metric]).map(([metric, value]) => `${id} ${metric} sums to ${value}, summary shows ${total[metric]}`));
        review.verify(disagreeing.length === 0, { cls, key: 'reconciliation/cross-report/totals', title: 'Reports covering the same period disagree on totals', label: `${tenant.key} ${range.id}`, route: 'GET /api/reports/*', roles: readers, tenants: [tenant.key], expected: 'weekly, monthly and per-source rows each sum to the summary totals', actual: disagreeing.length ? disagreeing.join('; ') : 'all agree', data: { range, summary: total, sums } });

        for (const entry of EXPORTS) {
          const exchange = await target.api.call(request, { method: 'GET', path: `${entry.path}${query}`, headers });
          const [header, ...lines] = exchange.text.trim().split('\n');
          const exported = lines.filter(Boolean).map((line) => Number(line.split(',')[0])).sort((a, b) => a - b);
          const source = (entry.metric === 'activities' ? rows.activities : rows.referrals) as unknown as Array<Record<string, unknown>>;
          const agreed = ATTRIBUTION[entry.metric];
          const expected = source.filter((row) => day(row[agreed]) >= range.from && day(row[agreed]) <= range.to).map((row) => Number(row.id)).sort((a, b) => a - b);
          const same = JSON.stringify(exported) === JSON.stringify(expected);
          review.verify(exchange.status === 200 && same && exported.length === total[entry.metric], { cls, key: `reconciliation/export/${entry.id}`, title: `The ${entry.id} export does not contain exactly the rows the reports count`, label: `${tenant.key} ${range.id}`, route: `GET ${entry.path}`, roles: rolesWith('exports.read'), tenants: [tenant.key], expected: `${expected.length} rows, the same ids as the source rows in range, equal to the summary total`, actual: `HTTP ${exchange.status}, ${exported.length} rows, summary total ${total[entry.metric]}`, data: { range, header, missing_ids: expected.filter((id) => !exported.includes(id)).slice(0, 20), unexpected_ids: exported.filter((id) => !expected.includes(id)).slice(0, 20) } });
        }
      }
    });
  }
});
