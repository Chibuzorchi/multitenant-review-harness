import { CLASSES } from '../lib/catalogue';
import { SELFTEST_SUFFIX, readEgressLog } from '../lib/egress-guard';
import { test } from '../lib/fixtures';

/** Stage 08 in a browser: the browser used for the review cannot reach a non-local host either. */

test.describe('08 outbound containment · browser', () => {
  test('the browser guard refuses a non-local destination', async ({ page, review }) => {
    const host = `browser${SELFTEST_SUFFIX}`;
    // From a blank page, so the request is refused by the guard and not by the application's content-security policy.
    await page.goto('about:blank');
    const subresource = await page.evaluate(async (url) => fetch(url, { mode: 'no-cors' }).then(() => 'connected', () => 'refused'), `http://${host}/pixel`);
    const navigation = await page.goto(`http://${host}/`).then(() => 'connected', () => 'refused');
    const logged = readEgressLog('browser').filter((attempt) => attempt.host === host);
    review.verify(subresource === 'refused' && navigation === 'refused' && logged.length >= 2, { cls: CLASSES.uncontainedOutbound, key: 'containment/guard/browser', title: 'The review browser can reach a non-local destination', label: 'browser self-test', route: 'browser egress guard', expected: 'in-page request and navigation both refused and logged', actual: `in-page request ${subresource}; navigation ${navigation}; ${logged.length} log entr(ies)` });
  });
});
