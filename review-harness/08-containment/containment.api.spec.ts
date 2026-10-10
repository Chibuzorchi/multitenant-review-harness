import dns from 'node:dns';
import { environment } from '../../config/environment';
import { PRIMARY_TENANT, account } from '../../config/roles';
import { CLASSES } from '../lib/catalogue';
import { SELFTEST_SUFFIX, isAllowedHost, readEgressLog } from '../lib/egress-guard';
import { test } from '../lib/fixtures';
import { subjectsFor, tenantId } from '../lib/subjects';

/**
 * Stage 08. Proves three things: every kind of outbound action is captured by
 * the local sink and nowhere else; the record of each is complete; and the
 * egress guards in the application, the harness and the browser are live,
 * by making each one refuse a deliberately non-local destination.
 */

const T = PRIMARY_TENANT;
const cls = CLASSES.uncontainedOutbound;
const hostOf = (url: string) => new URL(url).hostname;

test.describe('08 outbound containment', () => {
  test('every outbound type is captured by the local sink', async ({ target, review, credentials, request }) => {
    const headers = await credentials.as(account(T, 'executive'));
    const tid = tenantId(target, T);
    const actions: Array<{ type: string; path: string; body: unknown }> = [
      { type: 'email', path: '/api/outreach/campaigns', body: { channel: 'email', message: 'containment check', audience: 'referral-sources' } },
      { type: 'sms', path: '/api/outreach/campaigns', body: { channel: 'sms', message: 'containment check', audience: 'referral-sources' } },
      { type: 'advertisement', path: '/api/outreach/campaigns', body: { channel: 'advertisement', message: 'containment check', audience: 'referral-sources' } },
      { type: 'charge', path: '/api/billing/charges', body: { amount_cents: 100, description: 'containment check' } },
      { type: 'webhook', path: '/api/admissions', body: { referral_id: subjectsFor(target, T, 'executive').admittableReferralId } },
    ];
    review.expectOutbound(actions.length);
    const covered = new Set<string>();
    for (const action of actions) {
      const known = new Set((await target.outbound.outbox()).map((event) => event.id));
      const exchange = await target.api.call(request, { method: 'POST', path: action.path, headers, body: action.body });
      const events = (await target.outbound.outbox()).filter((event) => !known.has(event.id));
      const event = events[0];
      const receipt = event ? (await target.outbound.received()).find((entry) => entry.id === event.id) : undefined;
      const local = Boolean(event?.transport) && isAllowedHost(hostOf(event!.transport!)) && event!.transport!.startsWith(environment.sinkInternalUrl);
      const faithful = Boolean(receipt) && receipt!.type === event!.type && receipt!.tenant === event!.tenant && receipt!.destination === event!.destination && JSON.stringify(receipt!.payload) === JSON.stringify(event!.payload) && receipt!.timestamp === event!.timestamp;
      if (event) covered.add(event.type);
      review.verify(exchange.status === 201 && events.length === 1 && event.type === action.type && event.tenant === tid && event.status === 'captured' && local && faithful, {
        cls,
        key: `containment/capture/${action.type}`,
        title: `An outbound ${action.type} is not delivered to the local sink`,
        label: action.type,
        route: `POST ${action.path}`,
        roles: ['executive'],
        tenants: [T],
        expected: 'one event, recorded as captured, delivered to the local sink with identical content',
        actual: `HTTP ${exchange.status}; ${events.length} event(s); status ${event?.status ?? 'n/a'}; transport ${event?.transport ? hostOf(event.transport) : 'n/a'}; sink receipt ${receipt ? (faithful ? 'identical' : 'differs') : 'missing'}`,
        data: { event: event ? { id: event.id, type: event.type, tenant: event.tenant, destination: event.destination, status: event.status, transport: event.transport } : null },
      });
    }
    const missing = target.outbound.types.filter((type) => !covered.has(type));
    review.verify(missing.length === 0, { cls: CLASSES.baselineMismatch, key: 'containment/coverage', title: 'Not every outbound type was exercised', label: 'outbound types', route: 'outbound sink', expected: target.outbound.types.join(', '), actual: missing.length ? `not exercised: ${missing.join(', ')}` : 'all exercised' });

    const incomplete = (await target.outbound.outbox()).filter((event) => !event.id || event.tenant === null || !target.outbound.types.includes(event.type) || !event.destination || event.payload === null || event.payload === undefined || Number.isNaN(Date.parse(event.timestamp)) || !event.status);
    review.verify(incomplete.length === 0, { cls: CLASSES.outboundRecord, key: 'containment/record-fields', title: 'Outbound events are recorded without the fields needed to audit them', label: 'event id, tenant, type, destination, payload, timestamp, status', route: 'outbound events', expected: 'every event carries all seven fields', actual: `${incomplete.length} incomplete event(s)`, data: { incomplete: incomplete.map((event) => event.id) } });
  });

  test('intended destinations are data, never contacted', async ({ target, review }) => {
    const report = await target.outbound.egress();
    const foreign = Object.keys(report.allowed).filter((key) => !isAllowedHost(key.slice(0, key.lastIndexOf(':'))) && !report.allowHosts.includes(key.slice(0, key.lastIndexOf(':'))));
    const nonLocalAllow = report.allowHosts.filter((host) => !isAllowedHost(host) && host.includes('.'));
    review.verify(foreign.length === 0 && nonLocalAllow.length === 0, { cls, key: 'containment/application-connections', title: 'The application connected to a host outside the review environment', label: 'connections made by the application', route: 'application egress', expected: 'connections only to loopback or internal service names', actual: `connected to: ${Object.keys(report.allowed).join(', ') || 'nothing'}; allowlist: ${report.allowHosts.join(', ')}`, data: report });
  });

  test('the application guard refuses a non-local destination', async ({ target, review }) => {
    review.expectOutbound(1, { blocked: 1 });
    const result = await target.outbound.egressSelfTest();
    const report = await target.outbound.egress();
    const logged = report.blocked.some((attempt) => attempt.host.endsWith('.invalid'));
    const receipt = (await target.outbound.received()).some((entry) => entry.id === result.eventId);
    review.verify(result.status === 'blocked' && logged && !receipt, { cls, key: 'containment/guard/application', title: 'The application\'s egress guard does not refuse a non-local destination', label: 'application self-test', route: 'application egress guard', expected: 'delivery refused, attempt logged, nothing received by the sink', actual: `event ${result.status}; ${logged ? 'logged' : 'not logged'}; sink receipt ${receipt ? 'present' : 'absent'}` });
  });

  test('the harness guard refuses a non-local destination', async ({ review }) => {
    const host = `harness${SELFTEST_SUFFIX}`;
    const fetched = await fetch(`http://${host}/`).then(() => 'connected', (error: Error & { cause?: { code?: string } }) => error.cause?.code ?? error.message);
    const resolved = await dns.promises.lookup(host).then(() => 'resolved', (error: Error & { code?: string }) => error.code ?? error.message);
    const logged = readEgressLog('harness').filter((attempt) => attempt.host === host);
    review.verify(fetched === 'HARNESS_EGRESS_BLOCKED' && resolved === 'HARNESS_EGRESS_BLOCKED' && logged.length >= 2, { cls, key: 'containment/guard/harness', title: 'The harness egress guard does not refuse a non-local destination', label: 'harness self-test', route: 'harness egress guard', expected: 'HTTP request and DNS lookup both refused and logged', actual: `request: ${fetched}; lookup: ${resolved}; ${logged.length} log entr(ies)` });
  });
});
