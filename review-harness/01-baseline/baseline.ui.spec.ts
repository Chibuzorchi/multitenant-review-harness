import { environment } from '../../config/environment';
import { PRIMARY_TENANT, account } from '../../config/roles';
import { UI } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { pageName, test } from '../lib/fixtures';
import { updateManifest } from '../lib/manifest';

const base = { cls: CLASSES.baselineMismatch, route: 'environment' };

test.describe('01 baseline', () => {
  test('the browser reaches the candidate build and can sign in', async ({ page, browser, target, review }, testInfo) => {
    await target.auth.uiLogin(page, account(PRIMARY_TENANT, 'executive'));
    const shown = await pageName(page, UI.pageSelector, UI.pageAttribute);
    await review.verifyPage(page, shown !== null && !(UI.deniedPages as readonly string[]).includes(shown), {
      ...base,
      key: 'baseline/browser-sign-in',
      title: 'A review account cannot sign in through the browser',
      label: testInfo.project.name,
      expected: 'an application page after sign-in',
      actual: `page "${shown}"`,
    });
    const footer = await page.locator('footer').innerText();
    await review.verifyPage(page, footer.includes(environment.run.candidateSha.slice(0, 12)), {
      ...base,
      key: 'baseline/build-identity',
      title: 'The running build is not the candidate under review',
      label: `build shown in the UI (${testInfo.project.name})`,
      expected: `build ${environment.run.candidateSha.slice(0, 12)}`,
      actual: footer.trim(),
    });
    updateManifest({ browsers: { [testInfo.project.name]: { name: browser.browserType().name(), version: browser.version() } } });
  });
});
