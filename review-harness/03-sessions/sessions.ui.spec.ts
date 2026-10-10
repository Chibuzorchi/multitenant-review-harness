import { environment } from '../../config/environment';
import { PRIMARY_TENANT, account, spareRep } from '../../config/roles';
import { PROTECTED_UI_ROUTES, UI } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { pageName, test } from '../lib/fixtures';
import { sleep } from '../lib/run';
import { subjectsFor, tenantId, userId } from '../lib/subjects';

/**
 * Stage 03, browser surface, run on desktop and on a mobile profile. Covers
 * what a person actually does: sign in, work, sign out, press Back, come back
 * later with an old tab.
 */

const T = PRIMARY_TENANT;
const session = { cls: CLASSES.sessionLifecycle, tenants: [T] };
const shown = (page: import('@playwright/test').Page) => pageName(page, UI.pageSelector, UI.pageAttribute);

test.describe('03 sessions · UI', () => {
  test('sign in, sign out, stale pages and sign in again', async ({ page, target, review }, testInfo) => {
    const who = account(T, 'operations_manager');
    const device = testInfo.project.name;
    await target.auth.uiLogin(page, who);
    await review.verifyPage(page, (await shown(page)) === 'dashboard', { ...session, roles: [who.role], key: 'session/login', title: 'Sign-in does not establish a session for the right user', label: `form sign-in (${device})`, route: 'POST /login', expected: 'the dashboard', actual: `page "${await shown(page)}"` });

    await page.goto('/referral-sources');
    await target.auth.uiLogout(page);
    await review.verifyPage(page, await target.auth.onLoginPage(page), { ...session, roles: [who.role], key: 'session/logout', title: 'A browser session is still accepted after logout', label: `form sign-out (${device})`, route: 'POST /logout', expected: 'the sign-in page', actual: `page "${await shown(page)}"` });

    const reachable: string[] = [];
    for (const route of PROTECTED_UI_ROUTES) {
      await page.goto(route);
      if (!(await target.auth.onLoginPage(page))) reachable.push(route);
    }
    await review.verifyPage(page, reachable.length === 0, { ...session, roles: [who.role], key: 'session/logout', title: 'A browser session is still accepted after logout', label: `protected pages after sign-out (${device})`, route: 'protected UI routes', expected: 'every protected page redirects to sign-in', actual: reachable.length ? `still served: ${reachable.join(', ')}` : 'all redirect' });

    // Back after sign-out must not bring protected content back from the cache.
    await page.goto('/login');
    await page.goBack();
    await page.reload();
    await review.verifyPage(page, await target.auth.onLoginPage(page), { ...session, roles: [who.role], key: 'session/stale-browser-state', title: 'Stale browser state gives access after the session has ended', label: `Back and reload after sign-out (${device})`, route: 'browser history', expected: 'the sign-in page', actual: `page "${await shown(page)}"`, steps: ['Sign in and open a protected page.', 'Sign out.', 'Press Back, then reload.'] });

    await target.auth.uiLogin(page, who);
    await review.verifyPage(page, (await shown(page)) === 'dashboard', { ...session, roles: [who.role], key: 'session/re-entry', title: 'Signing in again after logout fails', label: `form sign-in again (${device})`, route: 'POST /login', expected: 'the dashboard', actual: `page "${await shown(page)}"` });
  });

  test('saved work and the session survive a reload and a browser restart', async ({ page, context, newGuardedContext, target, review }, testInfo) => {
    const who = account(T, 'rep');
    const subjects = subjectsFor(target, T, 'rep');
    const device = testInfo.project.name;
    const note = `persistence check ${environment.run.id} ${device}`;
    await target.auth.uiLogin(page, who);
    await page.goto(`/referral-sources/${subjects.ownSourceId}`);
    const form = page.locator('[data-testid="activity-form"]');
    await form.locator('[name="activity_type"]').selectOption('note');
    await form.locator('[name="activity_date"]').fill('2026-09-16');
    await form.locator('[name="notes"]').fill(note);
    await Promise.all([page.waitForLoadState('load'), form.locator('button[type="submit"]').click()]);
    await page.reload();

    const stored = target.database.activities(tenantId(target, T)).filter((row) => row.notes === note);
    const visible = (await page.locator('[data-testid="activity-table"]').getByText(note).count()) > 0;
    await review.verifyPage(page, stored.length === 1 && stored[0].rep_id === subjects.subjectRep.id && visible, { cls: CLASSES.persistence, tenants: [T], roles: ['rep'], key: 'session/persistence', title: 'Saved work is not preserved', label: `save then reload (${device})`, route: 'POST /referral-sources/:id/activities', expected: 'one stored activity for the rep, shown after reload', actual: `${stored.length} stored, ${visible ? 'shown' : 'not shown'}`, steps: ['Sign in as a rep and open an owned referral source.', 'Log an activity through the form.', 'Reload the page and check the database.'] });

    const restarted = await newGuardedContext({ storageState: await context.storageState() });
    const tab = await restarted.newPage();
    await tab.goto(`/referral-sources/${subjects.ownSourceId}`);
    const stillVisible = (await tab.getByText(note).count()) > 0;
    await review.verifyPage(tab, (await shown(tab)) === 'referral-source' && stillVisible, { cls: CLASSES.persistence, tenants: [T], roles: ['rep'], key: 'session/persistence', title: 'Saved work is not preserved', label: `browser restart with saved state (${device})`, route: 'GET /referral-sources/:id', expected: 'still signed in, saved activity shown', actual: `page "${await shown(tab)}", ${stillVisible ? 'shown' : 'not shown'}` });
  });

  test('saved browser state stops working after sign-out', async ({ page, context, newGuardedContext, target, review }, testInfo) => {
    const who = account(T, 'intake');
    await target.auth.uiLogin(page, who);
    const stale = await context.storageState();
    await target.auth.uiLogout(page);
    const old = await newGuardedContext({ storageState: stale });
    const tab = await old.newPage();
    await tab.goto('/referrals');
    await review.verifyPage(tab, await target.auth.onLoginPage(tab), { ...session, roles: [who.role], key: 'session/stale-browser-state', title: 'Stale browser state gives access after the session has ended', label: `cookie saved before sign-out (${testInfo.project.name})`, route: 'GET /referrals', expected: 'the sign-in page', actual: `page "${await shown(tab)}"`, steps: ['Sign in and copy the browser storage state.', 'Sign out.', 'Open a protected page in a new browser using the copied state.'] });
  });

  test('an expired browser session returns the user to sign-in', async ({ page, target, review }, testInfo) => {
    const previous = await target.control.settings();
    const ttl = environment.shortTtlSeconds;
    try {
      await target.control.setSettings({ sessionTtlSeconds: ttl });
      await target.auth.uiLogin(page, account(T, 'executive'));
      await page.goto('/reports');
      const before = await shown(page);
      await sleep(ttl * 1000 + 1500);
      await page.reload();
      await review.verifyPage(page, before === 'reports' && (await target.auth.onLoginPage(page)), { ...session, roles: ['executive'], key: 'session/browser-session-expiry', title: 'A browser session is still accepted after it expires', label: `reload after expiry (${testInfo.project.name})`, route: 'GET /reports', expected: 'the sign-in page', actual: `before "${before}", after "${await shown(page)}"` });
    } finally {
      await target.control.setSettings(previous);
    }
  });

  test('a form left open cannot be submitted after revocation', async ({ page, target, review, credentials, request }, testInfo) => {
    const who = spareRep(T);
    const id = userId(target, who);
    const tid = tenantId(target, T);
    const device = testInfo.project.name;
    const source = target.database.sources(tid).find((row) => row.owner_rep_id === id);
    test.skip(!source, 'the spare rep owns no referral source in this data set');
    const note = `stale form ${environment.run.id} ${device}`;
    await target.auth.uiLogin(page, who);
    await page.goto(`/referral-sources/${source!.id}`);
    const form = page.locator('[data-testid="activity-form"]');
    await form.locator('[name="activity_date"]').fill('2026-09-17');
    await form.locator('[name="notes"]').fill(note);

    const admin = await credentials.fresh(account(T, 'executive'));
    await target.auth.revokeUser(request, admin.headers, id);
    await Promise.all([page.waitForLoadState('load'), form.locator('button[type="submit"]').click()]);

    const stored = target.database.activities(tid).filter((row) => row.notes === note);
    await review.verifyPage(page, stored.length === 0 && (await target.auth.onLoginPage(page)), { ...session, roles: ['rep'], key: 'session/session-revocation', title: 'A browser session is still accepted after explicit revocation', label: `form submitted after revocation (${device})`, route: 'POST /referral-sources/:id/activities', expected: 'nothing stored, sign-in page shown', actual: `${stored.length} stored, page "${await shown(page)}"`, steps: ['A rep opens a form and fills it in.', 'An administrator revokes the rep.', 'The rep submits the form.'] });
  });
});
