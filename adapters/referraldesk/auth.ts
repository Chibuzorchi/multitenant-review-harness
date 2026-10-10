import type { APIRequestContext } from '@playwright/test';
import { environment } from '../../config/environment';
import type { AuthAdapter, Identity } from '../auth';

const password = () => environment.secrets.accountPassword;
const opts = { failOnStatusCode: false, maxRedirects: 0 } as const;

export const auth: AuthAdapter = {
  sessionCookie: 'rd_session',

  async issueApiToken(request, account, pw = password()) {
    const res = await request.post('/api/auth/token', { ...opts, data: { email: account.email, password: pw } });
    if (res.status() !== 201) return null;
    const body = (await res.json()) as { token: string; expires_at: string };
    return { headers: { authorization: `Bearer ${body.token}` }, expiresAt: body.expires_at };
  },

  async apiLogin(request, account, pw = password()) {
    const res = await request.post('/api/auth/login', { ...opts, data: { email: account.email, password: pw } });
    return res.status();
  },

  async whoami(request: APIRequestContext, headers = {}) {
    const res = await request.get('/api/me', { ...opts, headers });
    if (res.status() !== 200) return { status: res.status(), identity: null };
    const { user } = (await res.json()) as { user: { id: number; tenant_id: number; email: string; role: string } };
    const identity: Identity = { id: user.id, tenantId: user.tenant_id, email: user.email, role: user.role };
    return { status: 200, identity };
  },

  async logout(request, headers = {}) {
    return (await request.post('/api/auth/logout', { ...opts, headers })).status();
  },

  async revokeOwn(request, headers = {}) {
    return (await request.post('/api/auth/revoke', { ...opts, headers })).status();
  },

  async revokeUser(request, adminHeaders, userId) {
    return (await request.post(`/api/users/${userId}/revoke-sessions`, { ...opts, headers: adminHeaders })).status();
  },

  async uiLogin(page, account, pw = password()) {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(pw);
    await Promise.all([page.waitForLoadState('load'), page.locator('form[action="/login"] button[type="submit"]').click()]);
  },

  async uiLogout(page) {
    await Promise.all([page.waitForURL('**/login'), page.locator('[data-testid="logout"]').click()]);
  },

  async onLoginPage(page) {
    return (await page.locator('main[data-page="login"]').count()) > 0;
  },

  async adoptSession(context, request, account) {
    const status = await auth.apiLogin(request, account);
    if (status !== 200) throw new Error(`Could not sign in ${account.email}: HTTP ${status}`);
    const state = await request.storageState();
    await context.addCookies(state.cookies.filter((cookie) => cookie.name === auth.sessionCookie));
  },
};
