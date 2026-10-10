import { ROLES, TENANT_PAIRS, account, spareRep } from '../../config/roles';
import { ENTITY_SWEEP, ISOLATION_PROBES } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { changedFields, tenantFingerprint } from '../lib/dbstate';
import { test } from '../lib/fixtures';
import { attackerOf, victimOf } from '../lib/subjects';

/**
 * Stage 04. Every role of one tenant requests another tenant's records through
 * every place an identifier can be supplied. A check passes only when the
 * response discloses nothing of the victim tenant and, for writes, the victim
 * tenant's records are unchanged in the database.
 */

test.describe('04 tenant isolation · API', () => {
  for (const [attackerKey, victimKey] of TENANT_PAIRS) {
    for (const role of ROLES) {
      test(`tenant ${attackerKey} ${role} cannot reach tenant ${victimKey}`, async ({ target, review, credentials, request }) => {
        const victim = victimOf(target, victimKey);
        const attacker = attackerOf(target, attackerKey);
        const headers = await credentials.as(account(attackerKey, role));
        const preconditions = [`Signed in as the ${role} test account of tenant ${attackerKey}.`, `Identifiers of tenant ${victimKey} records are known to the caller (identifiers are sequential integers).`];

        for (const probe of ISOLATION_PROBES) {
          const before = probe.write ? tenantFingerprint(target, victim.tenantId) : null;
          const victimToken = probe.write === 'sessions' ? await credentials.fresh(spareRep(victimKey)) : null;
          const exchange = await target.api.call(request, { method: probe.method, path: probe.path(victim, attacker), headers, body: probe.body?.(victim, attacker) });
          const leaks = exchange.status < 400 && probe.leaks(exchange.json, exchange.text, victim);

          let effect: string[] = [];
          if (before) {
            effect = changedFields(before, tenantFingerprint(target, victim.tenantId));
            const dangling = target.database.crossTenantReferences();
            if (dangling.length) effect.push(`${dangling.length} cross-tenant reference(s): ${dangling.slice(0, 3).map((row) => `${row.table}#${row.id}`).join(', ')}`);
            if (victimToken && (await target.auth.whoami(request, victimToken.headers)).status !== 200) effect.push('victim credential no longer valid');
          }
          const ok = !leaks && effect.length === 0;
          const write = Boolean(probe.write);
          review.verify(ok, {
            cls: write ? CLASSES.crossTenantWrite : CLASSES.crossTenantRead,
            key: `tenant-isolation/${probe.route}`,
            title: write ? `A user of one tenant can change another tenant's data through ${probe.route}` : `A user of one tenant can read another tenant's data through ${probe.route}`,
            label: `${attackerKey}→${victimKey} ${role} ${probe.id}`,
            route: probe.route,
            roles: [role],
            tenants: [attackerKey, victimKey],
            expected: write ? 'request refused or scoped to the caller\'s tenant; victim tenant unchanged' : 'no victim-tenant data in the response',
            actual: `HTTP ${exchange.status}; ${leaks ? 'response contains victim-tenant data' : 'no victim-tenant data'}${effect.length ? `; database effect: ${effect.join(', ')}` : ''}`,
            preconditions,
            steps: [`Obtain an API token as the ${role} of tenant ${attackerKey}.`, `${probe.method} ${probe.path(victim, attacker)} (${probe.label}; vector: ${probe.vector}).`, write ? 'Compare the victim tenant\'s records in the database before and after.' : 'Inspect the response for records whose tenant is the victim tenant.'],
            exchange,
            data: { vector: probe.vector, victim_tenant_id: victim.tenantId, attacker_tenant_id: attacker.tenantId, database_effect: effect },
            signal: leaks ? 'victim-tenant-data-in-response' : 'cross-tenant-write-effect',
          });
        }

        for (const sweep of ENTITY_SWEEP) {
          const served: Array<{ id: number; status: number }> = [];
          const ids = sweep.ids(victim);
          let sample = null;
          for (const id of ids) {
            const exchange = await target.api.call(request, { method: 'GET', path: sweep.path(id), headers });
            if (exchange.status < 400 && (exchange.json as { tenant_id?: unknown } | null)?.tenant_id === victim.tenantId) {
              served.push({ id, status: exchange.status });
              sample ??= exchange;
            }
          }
          review.verify(served.length === 0, {
            cls: CLASSES.crossTenantRead,
            key: `tenant-isolation/${sweep.route}`,
            title: `A user of one tenant can read another tenant's data through ${sweep.route}`,
            label: `${attackerKey}→${victimKey} ${role} entity-id-sweep`,
            route: sweep.route,
            roles: [role],
            tenants: [attackerKey, victimKey],
            expected: `none of the victim tenant's ${ids.length} records served`,
            actual: `${served.length} of ${ids.length} served`,
            preconditions,
            steps: [`Obtain an API token as the ${role} of tenant ${attackerKey}.`, `Request ${sweep.route} once for each of the ${ids.length} identifiers belonging to tenant ${victimKey}.`, 'Count the responses that return a record of the victim tenant.'],
            exchange: sample ?? undefined,
            data: { vector: 'entity-id-sweep', identifiers_tried: ids.length, identifiers_served: served.length, first_served: served.slice(0, 10).map((entry) => entry.id) },
            signal: 'victim-tenant-data-in-response',
          });
        }
      });
    }
  }

  // The probes above only mean something if they can tell data from no data.
  for (const [, victimKey] of TENANT_PAIRS) {
    test(`positive control: tenant ${victimKey}'s own executive sees the probed data`, async ({ target, review, credentials, request }) => {
      const victim = victimOf(target, victimKey);
      const attacker = attackerOf(target, victimKey);
      const headers = await credentials.as(account(victimKey, 'executive'));
      const blind: string[] = [];
      const probes = ISOLATION_PROBES.filter((probe) => probe.method === 'GET' && ['url-path-id', 'nested-id', 'list-filter', 'export'].includes(probe.vector));
      for (const probe of probes) {
        const exchange = await target.api.call(request, { method: 'GET', path: probe.path(victim, attacker), headers });
        if (!(exchange.status === 200 && probe.leaks(exchange.json, exchange.text, victim))) blind.push(`${probe.id} (HTTP ${exchange.status})`);
      }
      review.verify(blind.length === 0, { cls: CLASSES.baselineMismatch, key: 'tenant-isolation/positive-control', title: 'Tenant-isolation probes cannot recognise tenant data when it is legitimately returned', label: `tenant ${victimKey} executive`, route: 'isolation probes', tenants: [victimKey], roles: ['executive'], expected: `all ${probes.length} read probes recognise the tenant's own data`, actual: blind.length ? `not recognised: ${blind.join(', ')}` : 'all recognised', data: { blind } });
    });
  }
});
