import type { APIRequestContext, BrowserContext, Page } from '@playwright/test';
import type { Account } from '../config/roles';

/** How the harness authenticates against the target. Implement this for each application under review. */

export interface ApiToken {
  /** Headers that authenticate a request with this token. Never written to evidence. */
  headers: Record<string, string>;
  expiresAt: string | null;
}

export interface Identity {
  id: number;
  tenantId: number;
  email: string;
  role: string;
}

export interface AuthAdapter {
  /** Name of the browser session cookie, used when transplanting sessions between contexts. */
  readonly sessionCookie: string;
  /** Exchange account credentials for an API token. Returns null when the credentials are rejected. */
  issueApiToken(request: APIRequestContext, account: Account, password?: string): Promise<ApiToken | null>;
  /** Establish a browser-style (cookie) session inside the given request context. Returns the HTTP status. */
  apiLogin(request: APIRequestContext, account: Account, password?: string): Promise<number>;
  /** Who the server believes the caller is; status is the raw HTTP status. */
  whoami(request: APIRequestContext, headers?: Record<string, string>): Promise<{ status: number; identity: Identity | null }>;
  /** End the calling credential only. */
  logout(request: APIRequestContext, headers?: Record<string, string>): Promise<number>;
  /** Explicitly revoke every credential of the calling user. */
  revokeOwn(request: APIRequestContext, headers?: Record<string, string>): Promise<number>;
  /** Administrative revocation of another user's credentials. */
  revokeUser(request: APIRequestContext, adminHeaders: Record<string, string>, userId: number): Promise<number>;
  /** Interactive sign-in through the login form. */
  uiLogin(page: Page, account: Account, password?: string): Promise<void>;
  uiLogout(page: Page): Promise<void>;
  /** True when the page is showing the sign-in form rather than application content. */
  onLoginPage(page: Page): Promise<boolean>;
  /** Give a browser context an authenticated session without driving the form. */
  adoptSession(context: BrowserContext, request: APIRequestContext, account: Account): Promise<void>;
}
