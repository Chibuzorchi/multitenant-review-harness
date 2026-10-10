import { TENANT_PAIRS, account } from '../../config/roles';
import { UI } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { pageName, test } from '../lib/fixtures';
import { victimOf } from '../lib/subjects';

/**
 * Stage 04 in a browser: the same cross-tenant request made the way a curious
 * signed-in user would make it, by editing the address bar.
 */

const [attackerKey, victimKey] = TENANT_PAIRS[0];

test.describe('04 tenant isolation · browser', () => {
  test(`tenant ${attackerKey} executive edits the address bar to a tenant ${victimKey} record`, async ({ page, context, signIn, target, review }) => {
    const victim = victimOf(target, victimKey);
    await signIn(context, account(attackerKey, 'executive'));
    const common = { cls: CLASSES.crossTenantRead, roles: ['executive'], tenants: [attackerKey, victimKey], preconditions: [`Signed in to the browser as the executive of tenant ${attackerKey}.`] };

    await page.goto(`/referral-sources/${victim.sourceId}`);
    const shown = await pageName(page, UI.pageSelector, UI.pageAttribute);
    const text = await page.locator('body').innerText();
    await review.verifyPage(page, shown !== 'referral-source' && !text.includes(victim.sourceName), { ...common, key: 'tenant-isolation/GET /referral-sources/:id (page)', title: 'A user of one tenant can open another tenant\'s referral source page', label: `${attackerKey}→${victimKey} executive page`, route: 'GET /referral-sources/:id', expected: 'a not-found page without the record', actual: `page "${shown}"${text.includes(victim.sourceName) ? ', record shown' : ''}` });

    const response = await page.goto(`/api/referral-sources/${victim.sourceId}`);
    const body = await page.locator('body').innerText();
    const leaked = body.includes(victim.sourceName) || body.includes(`"tenant_id":${victim.tenantId}`);
    await review.verifyPage(page, !leaked, {
      ...common,
      key: 'tenant-isolation/GET /api/referral-sources/:id',
      title: 'A user of one tenant can read another tenant\'s data through GET /api/referral-sources/:id',
      label: `${attackerKey}→${victimKey} executive browser-direct`,
      route: 'GET /api/referral-sources/:id',
      expected: 'no victim-tenant data in the response',
      actual: `HTTP ${response?.status() ?? 'n/a'}; ${leaked ? 'response contains victim-tenant data' : 'no victim-tenant data'}`,
      steps: [`Sign in to the browser as the executive of tenant ${attackerKey}.`, `Navigate directly to /api/referral-sources/${victim.sourceId}, a record of tenant ${victimKey}.`, 'Read the response shown by the browser.'],
      signal: 'victim-tenant-data-in-response',
    });
  });
});
