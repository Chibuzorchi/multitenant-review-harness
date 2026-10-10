import { environment } from '../../config/environment';
import { PRIMARY_TENANT, ROLES, ROLE_LABEL, account, otherRep, spareRep } from '../../config/roles';
import { PROTECTED_API_ROUTES } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { sleep } from '../lib/run';
import { userId } from '../lib/subjects';

/**
 * Stage 03, API surface. A credential has a lifecycle: issued, used, ended.
 * Each way it can end (logout, expiry, revocation) is tested for both
 * credential types, and the system of record is checked as well as the response.
 */

const T = PRIMARY_TENANT;
const session = { cls: CLASSES.sessionLifecycle, tenants: [T] };

test.describe('03 sessions · API', () => {
  for (const role of ROLES) {
    test(`login, logout and login again · ${role}`, async ({ target, review, newClient }) => {
      const who = account(T, role);
      const client = await newClient();
      const common = { ...session, roles: [role], preconditions: [`${ROLE_LABEL[role]} test account of tenant ${T}.`] };

      const loginStatus = await target.auth.apiLogin(client, who);
      const first = await target.auth.whoami(client);
      review.verify(loginStatus === 200 && first.identity?.email === who.email, { ...common, key: 'session/login', title: 'Sign-in does not establish a session for the right user', label: role, route: 'POST /api/auth/login', expected: 'HTTP 200 and a session for the account', actual: `login HTTP ${loginStatus}, whoami HTTP ${first.status}` });

      const logoutStatus = await target.auth.logout(client);
      const after = await target.auth.whoami(client);
      review.verify(after.status === 401, { ...common, key: 'session/logout', title: 'A browser session is still accepted after logout', label: role, route: 'POST /api/auth/logout', expected: 'HTTP 401 on the next request', actual: `logout HTTP ${logoutStatus}, next request HTTP ${after.status}`, steps: ['Sign in.', 'Log out.', 'Repeat an authenticated request with the same cookie jar.'] });

      const again = await target.auth.apiLogin(client, who);
      const second = await target.auth.whoami(client);
      review.verify(again === 200 && second.identity?.email === who.email, { ...common, key: 'session/re-entry', title: 'Signing in again after logout fails', label: role, route: 'POST /api/auth/login', expected: 'a new working session', actual: `login HTTP ${again}, whoami HTTP ${second.status}` });
    });

    test(`API token is ended by logout · ${role}`, async ({ target, review, credentials, newClient }) => {
      const client = await newClient();
      const token = await credentials.fresh(account(T, role));
      const before = await target.auth.whoami(client, token.headers);
      const logoutStatus = await target.auth.logout(client, token.headers);
      const after = await target.auth.whoami(client, token.headers);
      review.verify(before.status === 200 && after.status === 401, { ...session, roles: [role], key: 'session/api-token-logout', title: 'An API token is still accepted after it is logged out', label: role, route: 'POST /api/auth/logout', expected: 'token valid before, HTTP 401 after', actual: `before HTTP ${before.status}, logout HTTP ${logoutStatus}, after HTTP ${after.status}` });
    });

    test(`explicit revocation ends every credential · ${role}`, async ({ target, review, credentials, newClient }) => {
      const who = account(T, role);
      const id = userId(target, who);
      const browser = await newClient();
      const apiClient = await newClient();
      await target.auth.apiLogin(browser, who);
      const token = await credentials.fresh(who);
      const tokenBefore = await target.auth.whoami(apiClient, token.headers);
      const sessionBefore = await target.auth.whoami(browser);
      const common = {
        ...session,
        roles: [role],
        preconditions: [`${ROLE_LABEL[role]} test account of tenant ${T} holds a browser session and an API token, both working.`],
        steps: ['Sign in to obtain a browser session.', 'Request an API token for the same account.', 'Confirm both credentials are accepted.', 'Call the revoke-all-credentials endpoint from the browser session.', 'Reuse the browser session and the API token.'],
      };

      const revokeStatus = await target.auth.revokeOwn(browser);
      const sessionAfter = await target.auth.whoami(browser);
      review.verify(sessionBefore.status === 200 && sessionAfter.status === 401, { ...common, key: 'session/session-revocation', title: 'A browser session is still accepted after explicit revocation', label: `${role} self-revocation`, route: 'POST /api/auth/revoke', expected: 'HTTP 401 with the revoked session', actual: `revoke HTTP ${revokeStatus}, session then HTTP ${sessionAfter.status}` });

      const reuse = await target.api.call(apiClient, { method: 'GET', path: '/api/me', headers: token.headers });
      const tokenTitle = 'An API token is still accepted after the user\'s credentials are revoked';
      review.verify(tokenBefore.status === 200 && reuse.status === 401, {
        ...common,
        key: 'session/api-token-revocation',
        title: tokenTitle,
        label: `${role} self-revocation`,
        route: 'POST /api/auth/revoke',
        expected: 'HTTP 401 with the revoked API token',
        actual: `revoke HTTP ${revokeStatus}, token then HTTP ${reuse.status}`,
        exchange: reuse,
        signal: reuse.status === 200 ? 'api-token-accepted-after-revocation' : 'unexpected-status',
      });

      const accepted: string[] = [];
      for (const route of PROTECTED_API_ROUTES) {
        const probe = await target.api.call(apiClient, { method: 'GET', path: route, headers: token.headers });
        if (probe.status !== 401) accepted.push(`${route} → HTTP ${probe.status}`);
      }
      review.verify(accepted.length === 0, {
        ...common,
        key: 'session/api-token-revocation',
        title: tokenTitle,
        label: `${role} token reuse on protected routes`,
        route: 'POST /api/auth/revoke',
        expected: `HTTP 401 on all ${PROTECTED_API_ROUTES.length} protected routes`,
        actual: accepted.length ? `${accepted.length} route(s) still answered: ${accepted.slice(0, 4).join('; ')}` : 'all refused',
        data: { routes_still_served: accepted },
        signal: 'api-token-accepted-after-revocation',
      });

      const live = target.database.credentials(id).filter((credential) => credential.revoked_at === null && credential.expires_at > new Date().toISOString());
      review.verify(live.length === 0, {
        ...common,
        key: live.some((credential) => credential.kind !== 'browser') || live.length === 0 ? 'session/api-token-revocation' : 'session/session-revocation',
        title: tokenTitle,
        label: `${role} credentials on record`,
        route: 'POST /api/auth/revoke',
        expected: 'no unrevoked, unexpired credential on record for the user',
        actual: `${live.length} live credential(s): ${[...new Set(live.map((credential) => credential.kind))].join(', ') || 'none'}`,
        data: { live_credentials: live.map((credential) => ({ kind: credential.kind, created_at: credential.created_at, expires_at: credential.expires_at, revoked_at: credential.revoked_at })) },
        signal: 'api-token-accepted-after-revocation',
      });
    });
  }

  test('invalid credentials are refused', async ({ target, review, newClient }) => {
    const client = await newClient();
    const who = account(T, 'rep');
    const login = await target.auth.apiLogin(client, who, 'not-the-password');
    const token = await target.auth.issueApiToken(client, who, 'not-the-password');
    const unknown = await target.auth.apiLogin(client, { ...who, email: 'nobody@unknown-tenant.example' });
    review.verify(login === 401 && token === null && unknown === 401, { ...session, key: 'session/invalid-credentials', title: 'Sign-in accepts invalid credentials', label: 'wrong password and unknown account', route: 'POST /api/auth/login', expected: 'HTTP 401 and no token', actual: `login HTTP ${login}, token ${token ? 'issued' : 'refused'}, unknown account HTTP ${unknown}` });
  });

  test('sessions and API tokens expire', async ({ target, review, credentials, newClient }) => {
    const previous = await target.control.settings();
    const ttl = environment.shortTtlSeconds;
    try {
      await target.control.setSettings({ sessionTtlSeconds: ttl, apiTokenTtlSeconds: ttl });
      const who = account(T, 'sales_manager');
      const browser = await newClient();
      const apiClient = await newClient();
      await target.auth.apiLogin(browser, who);
      const token = await credentials.fresh(who);
      const sessionBefore = await target.auth.whoami(browser);
      const tokenBefore = await target.auth.whoami(apiClient, token.headers);
      await sleep(ttl * 1000 + 1500);
      const sessionAfter = await target.auth.whoami(browser);
      const tokenAfter = await target.auth.whoami(apiClient, token.headers);
      const steps = [`Set the session and token lifetime to ${ttl} seconds.`, 'Sign in and request a token; confirm both work.', `Wait ${ttl + 1.5} seconds without making requests.`, 'Reuse each credential.'];
      review.verify(sessionBefore.status === 200 && sessionAfter.status === 401, { ...session, roles: [who.role], key: 'session/browser-session-expiry', title: 'A browser session is still accepted after it expires', label: 'expired session', route: 'GET /api/me', expected: 'HTTP 200 before expiry, HTTP 401 after', actual: `before HTTP ${sessionBefore.status}, after HTTP ${sessionAfter.status}`, steps });
      review.verify(tokenBefore.status === 200 && tokenAfter.status === 401, { ...session, roles: [who.role], key: 'session/api-token-expiry', title: 'An API token is still accepted after it expires', label: 'expired token', route: 'GET /api/me', expected: 'HTTP 200 before expiry, HTTP 401 after', actual: `before HTTP ${tokenBefore.status}, after HTTP ${tokenAfter.status}`, steps });
    } finally {
      await target.control.setSettings(previous);
    }
  });

  test('an administrator can revoke another user, and only that user', async ({ target, review, credentials, newClient }) => {
    const victim = spareRep(T);
    const bystander = otherRep(T);
    const admin = await credentials.fresh(account(T, 'executive'));
    const browser = await newClient();
    const apiClient = await newClient();
    await target.auth.apiLogin(browser, victim);
    const victimToken = await credentials.fresh(victim);
    const bystanderToken = await credentials.fresh(bystander);
    const before = await target.auth.whoami(apiClient, victimToken.headers);

    const status = await target.auth.revokeUser(apiClient, admin.headers, userId(target, victim));
    const sessionAfter = await target.auth.whoami(browser);
    const reuse = await target.api.call(apiClient, { method: 'GET', path: '/api/me', headers: victimToken.headers });
    const bystanderAfter = await target.auth.whoami(apiClient, bystanderToken.headers);
    const adminAfter = await target.auth.whoami(apiClient, admin.headers);
    const common = { ...session, roles: ['rep'], route: 'POST /api/users/:id/revoke-sessions', preconditions: ['A rep holds a browser session and an API token.', 'An executive of the same tenant revokes that rep.'], steps: ['The rep signs in and requests an API token.', 'The executive calls the administrative revocation endpoint for the rep.', 'The rep reuses the browser session and the API token.'] };

    review.verify(sessionAfter.status === 401, { ...common, key: 'session/session-revocation', title: 'A browser session is still accepted after explicit revocation', label: 'administrative revocation', expected: 'HTTP 401 with the revoked session', actual: `revoke HTTP ${status}, session then HTTP ${sessionAfter.status}` });
    review.verify(before.status === 200 && reuse.status === 401, {
      ...common,
      key: 'session/api-token-revocation',
      title: 'An API token is still accepted after the user\'s credentials are revoked',
      label: 'administrative revocation',
      expected: 'HTTP 401 with the revoked API token',
      actual: `revoke HTTP ${status}, token then HTTP ${reuse.status}`,
      exchange: reuse,
      signal: reuse.status === 200 ? 'api-token-accepted-after-revocation' : 'unexpected-status',
    });
    review.verify(bystanderAfter.status === 200 && adminAfter.status === 200, { ...common, key: 'session/revocation-scope', title: 'Revoking one user ends other users\' credentials', label: 'other users unaffected', expected: 'other users\' tokens still valid', actual: `peer rep HTTP ${bystanderAfter.status}, administrator HTTP ${adminAfter.status}`, cls: CLASSES.persistence });
  });

  test('protected routes refuse missing and forged credentials', async ({ target, review, newClient }) => {
    const client = await newClient();
    const attempts: Array<[string, Record<string, string>]> = [
      ['no credentials', {}],
      ['forged bearer token', { authorization: 'Bearer forged-token-value-0000000000000000' }],
      ['forged session cookie', { cookie: `${target.auth.sessionCookie}=forged-session-value-0000000000` }],
    ];
    for (const [label, headers] of attempts) {
      const served: string[] = [];
      for (const route of PROTECTED_API_ROUTES) {
        const probe = await target.api.call(client, { method: 'GET', path: route, headers });
        if (probe.status !== 401) served.push(`${route} → HTTP ${probe.status}`);
      }
      review.verify(served.length === 0, { cls: CLASSES.unauthenticatedAccess, key: 'session/unauthenticated-access', title: 'A protected route answers without a valid credential', label, route: 'protected API routes', expected: `HTTP 401 on all ${PROTECTED_API_ROUTES.length} routes`, actual: served.length ? served.slice(0, 4).join('; ') : 'all refused', data: { served } });
    }
  });

  test('the session cookie is not readable by scripts', async ({ target, review, newClient }) => {
    const client = await newClient();
    await target.auth.apiLogin(client, account(T, 'intake'));
    const cookie = (await client.storageState()).cookies.find((entry) => entry.name === target.auth.sessionCookie);
    review.verify(Boolean(cookie?.httpOnly) && cookie?.sameSite !== 'None', { ...session, severity: 'Low', key: 'session/cookie-attributes', title: 'The session cookie lacks protective attributes', label: 'HttpOnly and SameSite', route: 'POST /api/auth/login', expected: 'HttpOnly, SameSite Lax or Strict', actual: cookie ? `HttpOnly ${cookie.httpOnly}, SameSite ${cookie.sameSite}` : 'no session cookie set' });
  });
});
