import { PATIENT_MODULE } from '../../config/feature-flags';
import { PRIMARY_TENANT, ROLES, account } from '../../config/roles';
import { UI } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { pageName, test } from '../lib/fixtures';

/** Stage 05 in a browser: navigation, direct URLs, and pages loaded before the module was switched OFF. */

const T = PRIMARY_TENANT;
const flag = PATIENT_MODULE;
const denial = { cls: CLASSES.moduleDenial, tenants: [T] };
const shown = (page: import('@playwright/test').Page) => pageName(page, UI.pageSelector, UI.pageAttribute);

test.describe('05 module denial · UI', () => {
  test.beforeEach(async ({ target }) => {
    await target.control.setFlag(flag.name, false);
  });
  test.afterEach(async ({ target }) => {
    await target.control.setFlag(flag.name, false);
  });

  for (const role of ROLES) {
    test(`the module is absent from the UI · ${role}`, async ({ page, context, signIn, review }) => {
      await signIn(context, account(T, role));
      await page.goto('/');
      const labels = (await page.locator(UI.navSelector).allInnerTexts()).map((text) => text.trim());
      await review.verifyPage(page, !labels.includes(flag.navLabel), { ...denial, severity: 'Low', key: 'module-denial/ui/navigation', title: 'The patient module is offered in navigation while its flag is OFF', label: role, route: 'navigation', roles: [role], expected: `no "${flag.navLabel}" entry`, actual: `navigation: ${labels.join(', ')}` });

      for (const route of flag.uiRoutes) {
        const response = await page.goto(route);
        const name = await shown(page);
        const text = await page.locator('body').innerText();
        const leaked = flag.dataMarkers.some((marker) => text.includes(marker));
        await review.verifyPage(page, name === 'feature-disabled' && response?.status() === flag.denial.status && !leaked, { ...denial, key: `module-denial/ui${route}`, title: `The patient page ${route} is served while the module flag is OFF`, label: role, route: `GET ${route}`, roles: [role], expected: `HTTP ${flag.denial.status}, feature-disabled page, no module data`, actual: `HTTP ${response?.status() ?? 'n/a'}, page "${name}"${leaked ? ', module data present' : ''}`, signal: 'module-route-served-while-flag-off' });
      }
    });
  }

  test('a page loaded while ON gives nothing once the module is OFF', async ({ page, context, signIn, target, review }) => {
    await signIn(context, account(T, 'executive'));
    await target.control.setFlag(flag.name, true);
    await page.goto('/patients');
    const whileOn = await shown(page);
    await page.goto('/');
    await target.control.setFlag(flag.name, false);

    await page.goBack();
    await page.reload();
    const afterBack = await shown(page);
    const fetched = await page.evaluate(async () => {
      const response = await fetch('/api/patients', { cache: 'default' });
      return { status: response.status, text: await response.text() };
    });
    const leaked = flag.dataMarkers.some((marker) => fetched.text.includes(marker));
    await review.verifyPage(page, whileOn === 'patients' && afterBack === 'feature-disabled' && fetched.status === flag.denial.status && !leaked, { ...denial, key: 'module-denial/cached-page', title: 'A patient page loaded while the module was ON still works after it is switched OFF', label: 'Back, reload and in-page request', route: 'GET /patients', roles: ['executive'], expected: `page served while ON; feature-disabled page and HTTP ${flag.denial.status} from the API once OFF`, actual: `while ON "${whileOn}"; after OFF page "${afterBack}", in-page API request HTTP ${fetched.status}${leaked ? ' with module data' : ''}`, steps: ['Switch the module ON and open the patient list.', 'Navigate away, then switch the module OFF.', 'Press Back and reload.', 'From the open page, request the patient API.'] });
  });
});
