import { rolesWith } from '../../config/permissions';
import { ACTIVITY_METRICS, RANGES, REPORTS, REPORT_UI, type Metric } from '../../config/reports';
import { PRIMARY_TENANT, account } from '../../config/roles';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { differences, pullSourceRows, recalculate, type Table } from '../lib/recalc';
import { tenantId } from '../lib/subjects';

/** Stage 06 in a browser: the figures a manager actually sees on the reports page, against the same recalculation. */

const T = PRIMARY_TENANT;
const cls = CLASSES.reconciliation;
const readers = rolesWith('reports.read');

test.describe('06 reconciliation · UI', () => {
  for (const range of RANGES.filter((entry) => ['full-window', 'calendar-month'].includes(entry.id))) {
    test(`reports page figures reconcile with source rows · ${range.id}`, async ({ page, context, signIn, target, review }) => {
      const rows = pullSourceRows(target, tenantId(target, T));
      await signIn(context, account(T, 'sales_manager'));
      await page.goto(`${REPORT_UI.path}?from=${range.from}&to=${range.to}`);

      const summary = REPORTS.find((report) => report.id === 'summary')!;
      const expectedTotals = recalculate(rows, summary, range).get('total')!;
      for (const metric of ['activities', 'referrals', 'admissions'] as Metric[]) {
        const shown = Number((await page.locator(REPORT_UI.summaryMetric(metric)).innerText()).trim());
        await review.verifyPage(page, shown === expectedTotals[metric], { cls, key: `reconciliation/summary/${metric === 'activities' ? 'activity' : metric}-attribution`, title: `The summary report's ${metric} figures do not match the source rows`, label: `${T} ui ${range.id}`, route: `GET ${REPORT_UI.path}`, roles: readers, tenants: [T], expected: `${expectedTotals[metric]}`, actual: `${shown}`, data: { range, metric, displayed: shown, expected: expectedTotals[metric], difference: shown - expectedTotals[metric] } });
      }

      for (const id of ['monthly', 'weekly'] as const) {
        const report = REPORTS.find((entry) => entry.id === id)!;
        const displayed: Table = new Map();
        for (const row of await page.locator(`${REPORT_UI.table(id)} tbody tr`).all()) {
          const cell = async (column: string) => (await row.locator(`td[data-col="${column}"]`).innerText()).trim();
          displayed.set(await cell(report.keyField!), Object.fromEntries(await Promise.all(report.metrics.map(async (metric) => [metric, Number(await cell(metric))] as const))));
        }
        const expected = recalculate(rows, report, range);
        for (const family of [...new Set(report.metrics.map((metric) => (ACTIVITY_METRICS.includes(metric) ? 'activity' : metric)))]) {
          const metrics = report.metrics.filter((metric) => (ACTIVITY_METRICS.includes(metric) ? 'activity' : metric) === family);
          const cells = differences(displayed, expected, metrics);
          const first = cells[0];
          await review.verifyPage(page, cells.length === 0, {
            cls,
            key: `reconciliation/${id}/${family}-attribution`,
            title: family === 'activity' ? `The ${id} report attributes activities to the wrong period` : `The ${id} report's ${metrics.join(', ')} figures do not match the source rows`,
            label: `${T} ui ${range.id}`,
            route: `GET ${REPORT_UI.path}`,
            roles: readers,
            tenants: [T],
            expected: 'every figure in the table equals the recalculated figure',
            actual: cells.length ? `${cells.length} figure(s) differ; e.g. ${first.metric} for ${first.bucket}: displayed ${first.displayed}, expected ${first.expected} (difference ${first.difference})` : 'all figures match',
            steps: [`Sign in as a sales manager and open ${REPORT_UI.path}?from=${range.from}&to=${range.to}.`, `Read the ${id} table.`, 'Recalculate each figure from the database rows and compare.'],
            data: { range, differing_figures: cells.slice(0, 40) },
            signal: 'figures-differ-from-source-rows',
          });
        }
      }
    });
  }
});
