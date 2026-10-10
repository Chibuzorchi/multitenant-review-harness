import path from 'node:path';
import { test as base, expect, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { loadTarget, type Target } from '../../adapters';
import type { ApiToken } from '../../adapters/auth';
import type { Exchange } from '../../adapters/api';
import { environment } from '../../config/environment';
import type { Account } from '../../config/roles';
import { CLASSES, type FindingClass, type Severity } from './catalogue';
import { isAllowedHost, logBlocked } from './egress-guard';
import { redactValue } from './redact';
import { appendJsonl, runPaths, sleep } from './run';

export interface CheckDetail {
  /** Stable finding key. Every failing check with the same key belongs to one finding. */
  key: string;
  /** Finding title, written as the defect it would be if the check failed. */
  title: string;
  /** What distinguishes this check from others under the same key. */
  label: string;
  cls: FindingClass;
  severity?: Severity;
  route: string;
  roles?: string[];
  tenants?: string[];
  expected: string;
  actual: string;
  preconditions?: string[];
  steps?: string[];
  exchange?: Exchange;
  /** Structured supporting data (source rows, calculations, database observations). */
  data?: unknown;
  /** Machine-readable reason, set only when the check fails for that specific reason. */
  signal?: string;
}

export interface CheckRecord {
  id: string;
  run_id: string;
  stage: string;
  project: string;
  test: string;
  ok: boolean;
  at: string;
  key: string;
  title: string;
  label: string;
  category: string;
  severity: Severity;
  route: string;
  roles: string[];
  tenants: string[];
  expected: string;
  actual: string;
  preconditions: string[];
  steps: string[];
  security_impact: string;
  business_impact: string;
  signal: string | null;
  exchange: { at: string; request: Exchange['request']; response: Exchange['response'] } | null;
  data: unknown;
  output_dir: string;
  screenshot: string | null;
}

export interface OutboundLedgerLine {
  run_id: string;
  stage: string;
  project: string;
  test: string;
  declared: number;
  declared_blocked: number;
  event_ids: string[];
  blocked_event_ids: string[];
  receipt_ids: string[];
  ok: boolean;
}

export const stageOf = (info: TestInfo): string => path.basename(path.dirname(info.file));

export class Review {
  private declared = 0;
  private declaredBlocked = 0;
  private shots = 0;

  constructor(
    private readonly info: TestInfo,
    readonly stage: string,
  ) {}

  /** Record a check (pass or fail) and soft-assert it, so one failure never hides the checks after it. */
  verify(ok: boolean, detail: CheckDetail, screenshot: string | null = null): boolean {
    const record: CheckRecord = {
      id: `${this.stage}:${detail.key}:${detail.label}`,
      run_id: environment.run.id,
      stage: this.stage,
      project: this.info.project.name,
      test: this.info.titlePath.slice(1).join(' > '),
      ok,
      at: new Date().toISOString(),
      key: detail.key,
      title: detail.title,
      label: detail.label,
      category: detail.cls.category,
      severity: detail.severity ?? detail.cls.severity,
      route: detail.route,
      roles: detail.roles ?? [],
      tenants: detail.tenants ?? [],
      expected: detail.expected,
      actual: detail.actual,
      preconditions: detail.preconditions ?? [],
      steps: detail.steps ?? [],
      security_impact: detail.cls.securityImpact,
      business_impact: detail.cls.businessImpact,
      signal: ok ? null : (detail.signal ?? null),
      // Full exchanges are kept for failures; a pass keeps the request line and status.
      exchange: detail.exchange
        ? ok
          ? { at: detail.exchange.at, request: { ...detail.exchange.request, headers: {}, body: null }, response: { status: detail.exchange.status, headers: {}, body: null, truncated: true } }
          : { at: detail.exchange.at, request: detail.exchange.request, response: detail.exchange.response }
        : null,
      data: ok ? null : redactValue(detail.data ?? null),
      output_dir: this.info.outputDir,
      screenshot,
    };
    appendJsonl(runPaths.checks(), record);
    expect.soft(ok, `[${detail.key}] ${detail.label} — expected: ${detail.expected}; actual: ${detail.actual}`).toBe(true);
    return ok;
  }

  /** As verify, and captures the page at the moment a check fails. */
  async verifyPage(page: Page, ok: boolean, detail: CheckDetail): Promise<boolean> {
    let screenshot: string | null = null;
    if (!ok) {
      screenshot = this.info.outputPath(`check-failure-${++this.shots}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {
        screenshot = null;
      });
    }
    return this.verify(ok, detail, screenshot);
  }

  /** Declare outbound events this test intends to cause. Anything beyond the declaration fails the test. */
  expectOutbound(count: number, options: { blocked?: number } = {}): void {
    this.declared += count;
    this.declaredBlocked += options.blocked ?? 0;
  }

  get outboundDeclaration(): { declared: number; blocked: number } {
    return { declared: this.declared, blocked: this.declaredBlocked };
  }
}

const tokenCache = new Map<string, ApiToken>();

export interface Credentials {
  /** Headers for a shared, cached API token of the account. Do not revoke it. */
  as(account: Account): Promise<Record<string, string>>;
  /** A new API token that the test owns and may revoke or let expire. */
  fresh(account: Account): Promise<ApiToken>;
}

interface Fixtures {
  target: Target;
  review: Review;
  credentials: Credentials;
  /** A new API client with an empty cookie jar. */
  newClient: () => Promise<APIRequestContext>;
  /** A new browser context with the egress guard attached. */
  newGuardedContext: (options?: Parameters<import('@playwright/test').Browser['newContext']>[0]) => Promise<BrowserContext>;
  /** Give a browser context a signed-in session without driving the login form. */
  signIn: (context: BrowserContext, account: Account) => Promise<void>;
}

/** Refuse and log any browser request to a host outside the review environment. */
export async function guardContext(context: BrowserContext, project: string): Promise<void> {
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!/^https?:$/.test(url.protocol) || isAllowedHost(url.hostname)) return route.fallback();
    logBlocked('browser', { process: project, kind: 'connect', host: url.hostname, port: url.port ? Number(url.port) : null });
    return route.abort('blockedbyclient');
  });
}

export const test = base.extend<Fixtures>({
   
  target: async ({}, use) => {
    await use(loadTarget());
  },

  review: [
    async ({ target }, use, testInfo) => {
      const stage = stageOf(testInfo);
      const review = new Review(testInfo, stage);
      const outboxBefore = new Set(target.database.outboundEvents().map((event) => event.id));
      const receiptsBefore = new Set((await target.outbound.received()).map((event) => event.id));

      await use(review);

      const { declared, blocked } = review.outboundDeclaration;
      const fresh = target.database.outboundEvents().filter((event) => !outboxBefore.has(event.id));
      const sent = fresh.filter((event) => event.status !== 'blocked');
      let receipts: string[] = [];
      // Delivery to the sink is asynchronous in some targets; allow it a moment to settle.
      for (let attempt = 0; attempt < 10; attempt++) {
        receipts = (await target.outbound.received()).map((event) => event.id).filter((id) => !receiptsBefore.has(id));
        if (receipts.length >= sent.length) break;
        await sleep(100);
      }
      const sentIds = sent.map((event) => event.id).sort();
      const receiptIds = [...new Set(receipts)].sort();
      const countOk = fresh.length === declared && fresh.length - sent.length === blocked;
      const sinkOk = JSON.stringify(sentIds) === JSON.stringify(receiptIds);
      const line: OutboundLedgerLine = {
        run_id: environment.run.id,
        stage,
        project: testInfo.project.name,
        test: testInfo.titlePath.slice(1).join(' > '),
        declared,
        declared_blocked: blocked,
        event_ids: sentIds,
        blocked_event_ids: fresh.filter((event) => event.status === 'blocked').map((event) => event.id),
        receipt_ids: receiptIds,
        ok: countOk && sinkOk,
      };
      appendJsonl(runPaths.outboundLedger(), line);
      const summary = fresh.map((event) => ({ id: event.id, tenant: event.tenant_id, type: event.type, destination: event.destination, status: event.status, transport: event.transport }));
      if (!countOk) {
        review.verify(false, {
          key: 'containment/unexpected-outbound',
          title: 'An action produced outbound events the test did not intend',
          label: `${line.test} [${line.project}]`,
          cls: CLASSES.uncontainedOutbound,
          route: 'outbound events',
          expected: `${declared} outbound event(s), of which ${blocked} refused by the egress guard`,
          actual: `${fresh.length} outbound event(s), of which ${fresh.length - sent.length} refused`,
          steps: ['Record the outbound event ids before the test.', 'Run the test.', 'Compare the new outbound events with the number the test declared.'],
          data: { events: summary },
          signal: 'undeclared-outbound-event',
        });
      } else if (!sinkOk) {
        review.verify(false, {
          key: 'containment/sink-mismatch',
          title: 'Outbound events recorded by the application do not match what the local sink received',
          label: `${line.test} [${line.project}]`,
          cls: CLASSES.uncontainedOutbound,
          route: 'outbound sink',
          expected: `sink receipts for exactly the ${sentIds.length} event(s) the application recorded as sent`,
          actual: `${receiptIds.length} receipt(s)`,
          data: { events: summary, receipt_ids: receiptIds },
          signal: 'sink-receipts-differ-from-outbox',
        });
      }
    },
    { auto: true },
  ],

  credentials: async ({ target, request }, use) => {
    await use({
      async as(account) {
        let token = tokenCache.get(account.email);
        if (!token) {
          token = (await target.auth.issueApiToken(request, account)) ?? undefined;
          if (!token) throw new Error(`Could not obtain an API token for ${account.email}`);
          tokenCache.set(account.email, token);
        }
        return token.headers;
      },
      async fresh(account) {
        const token = await target.auth.issueApiToken(request, account);
        if (!token) throw new Error(`Could not obtain an API token for ${account.email}`);
        return token;
      },
    });
  },

  newClient: async ({ playwright }, use) => {
    const clients: APIRequestContext[] = [];
    await use(async () => {
      const client = await playwright.request.newContext({ baseURL: environment.baseUrl });
      clients.push(client);
      return client;
    });
    await Promise.all(clients.map((client) => client.dispose()));
  },

  context: async ({ context }, use, testInfo) => {
    await guardContext(context, testInfo.project.name);
    await use(context);
  },

  newGuardedContext: async ({ browser, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor }, use, testInfo) => {
    const contexts: BrowserContext[] = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({ ...contextOptions, baseURL: environment.baseUrl, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, ...options });
      await guardContext(context, testInfo.project.name);
      contexts.push(context);
      return context;
    });
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  },

  signIn: async ({ target, newClient }, use) => {
    await use(async (context, account) => {
      await target.auth.adoptSession(context, await newClient(), account);
    });
  },
});

export { expect };

/** The value of main[data-page] for the page currently shown, or null. */
export async function pageName(page: Page, selector: string, attribute: string): Promise<string | null> {
  const main = page.locator(selector).first();
  return (await main.count()) > 0 ? main.getAttribute(attribute) : null;
}
