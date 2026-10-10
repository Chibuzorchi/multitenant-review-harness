import { BYPASS_VARIATIONS, PATIENT_MODULE } from '../../config/feature-flags';
import { PRIMARY_TENANT, ROLES, account } from '../../config/roles';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { tenantId } from '../lib/subjects';

/**
 * Stage 05. The patient module ships switched OFF. This stage proves the
 * server denies it on every route and to every role, that nothing is stored
 * or computed as a side effect, and that work queued while the module was ON
 * does not run once it is OFF.
 */

const T = PRIMARY_TENANT;
const flag = PATIENT_MODULE;
const denial = { cls: CLASSES.moduleDenial, tenants: [T] };
const hasMarker = (text: string) => flag.dataMarkers.some((marker) => text.includes(marker));

test.describe('05 module denial · API', () => {
  test.beforeEach(async ({ target }) => {
    await target.control.setFlag(flag.name, false);
  });
  test.afterEach(async ({ target }) => {
    await target.control.setFlag(flag.name, false);
  });

  test('the release candidate ships with the module OFF', async ({ target, review }) => {
    const state = await target.control.flag(flag.name);
    review.verify(state === flag.requiredState, { ...denial, key: 'module-denial/flag-state', title: 'The patient module flag is not in its required state', label: flag.name, route: 'feature flags', expected: `${flag.name} = ${flag.requiredState}`, actual: `${flag.name} = ${state}` });
  });

  for (const role of ROLES) {
    test(`every module route is denied · ${role}`, async ({ target, review, credentials, request }) => {
      const headers = await credentials.as(account(T, role));
      for (const route of flag.apiRoutes) {
        const exchange = await target.api.call(request, { method: route.method, path: route.path, headers, body: route.body });
        const code = target.api.errorCode(exchange);
        review.verify(exchange.status === flag.denial.status && code === flag.denial.code && !hasMarker(exchange.text), {
          ...denial,
          key: `module-denial/api/${route.id}`,
          title: `The patient module answers on ${route.method} ${route.path} while its flag is OFF`,
          label: role,
          route: `${route.method} ${route.path}`,
          roles: [role],
          expected: `HTTP ${flag.denial.status} ${flag.denial.code}, no module data`,
          actual: `HTTP ${exchange.status} ${code ?? '(no code)'}${hasMarker(exchange.text) ? ', module data present' : ''}`,
          preconditions: [`${flag.name} is OFF.`],
          exchange,
          signal: 'module-route-served-while-flag-off',
        });
      }
    });
  }

  test('request variations do not get past the gate', async ({ target, review, credentials, request }) => {
    const headers = await credentials.as(account(T, 'executive'));
    for (const variation of BYPASS_VARIATIONS) {
      const served: string[] = [];
      for (const route of flag.apiRoutes) {
        if (variation.method && route.method !== 'GET') continue;
        const method = (variation.method ?? route.method) as 'GET' | 'POST' | 'HEAD';
        const path = variation.rewrite ? variation.rewrite(route.path) : route.path;
        const exchange = await target.api.call(request, { method, path, headers: { ...headers, ...variation.headers }, body: route.body });
        if (![401, 403, 404, 405].includes(exchange.status) || hasMarker(exchange.text)) served.push(`${method} ${path} → HTTP ${exchange.status}`);
      }
      review.verify(served.length === 0, { ...denial, key: `module-denial/bypass/${variation.id}`, title: 'A request variation reaches the patient module while its flag is OFF', label: variation.label, route: 'patient module routes', roles: ['executive'], expected: 'every variation refused, no module data', actual: served.length ? served.join('; ') : 'all refused', data: { served }, signal: 'module-route-served-while-flag-off' });
    }
  });

  test('denied requests leave nothing behind', async ({ target, review, credentials, request }) => {
    const db = target.database;
    const before = { patients: db.patientCount(), queue: db.projectionQueue().length, projections: db.projections().length };
    const headers = await credentials.as(account(T, 'executive'));
    for (const route of flag.apiRoutes) await target.api.call(request, { method: route.method, path: route.path, headers, body: route.body });
    const worker = await target.jobs.run(target.jobs.names.patientQueue);
    const after = { patients: db.patientCount(), queue: db.projectionQueue().length, projections: db.projections().length };
    review.verify(JSON.stringify(before) === JSON.stringify(after), { ...denial, key: 'module-denial/no-side-effects', title: 'Denied patient-module requests still store or compute data', label: 'imports, jobs, webhooks and the worker', route: 'patient module routes', expected: 'patient, queue and projection counts unchanged', actual: `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}; worker run ${worker.status}`, data: { before, after, worker } });
  });

  test('a token issued while the module was ON is denied once it is OFF', async ({ target, review, credentials, request }) => {
    await target.control.setFlag(flag.name, true);
    const token = await credentials.fresh(account(T, 'executive'));
    const whileOn = await target.api.call(request, { method: 'GET', path: '/api/patients', headers: token.headers });
    await target.control.setFlag(flag.name, false);
    const whileOff = await target.api.call(request, { method: 'GET', path: '/api/patients', headers: token.headers });
    review.verify(whileOn.status === 200 && whileOff.status === flag.denial.status && target.api.errorCode(whileOff) === flag.denial.code && !hasMarker(whileOff.text), { ...denial, key: 'module-denial/stale-token', title: 'A token issued while the patient module was ON still reaches it after it is switched OFF', label: 'token issued while ON', route: 'GET /api/patients', roles: ['executive'], expected: `HTTP 200 while ON, HTTP ${flag.denial.status} ${flag.denial.code} while OFF`, actual: `HTTP ${whileOn.status} while ON, HTTP ${whileOff.status} while OFF`, exchange: whileOff, steps: ['Switch the module ON.', 'Issue an API token and read the patient list.', 'Switch the module OFF.', 'Repeat the request with the same token.'] });

    await target.auth.logout(request, token.headers);
    const refused: string[] = [];
    for (const route of flag.apiRoutes) {
      const exchange = await target.api.call(request, { method: route.method, path: route.path, headers: token.headers, body: route.body });
      if (exchange.status !== 401 || hasMarker(exchange.text)) refused.push(`${route.method} ${route.path} → HTTP ${exchange.status}`);
    }
    review.verify(refused.length === 0, { ...denial, key: 'module-denial/revoked-credential', title: 'An ended credential receives a patient-module response', label: 'logged-out token', route: 'patient module routes', roles: ['executive'], expected: 'HTTP 401 on every module route', actual: refused.length ? refused.join('; ') : 'all HTTP 401', data: { refused } });
  });

  test('work queued while ON does not run after the module is switched OFF', async ({ target, review, credentials, request }) => {
    const db = target.database;
    const tid = tenantId(target, T);
    const headers = await credentials.as(account(T, 'executive'));
    const worker = target.jobs.names.patientQueue;

    // Positive control: with the module ON, queued work is processed.
    await target.control.setFlag(flag.name, true);
    const first = await target.api.call(request, { method: 'POST', path: flag.queue.enqueueRoute, headers });
    const firstId = (first.json as { queue_item_id?: number } | null)?.queue_item_id ?? -1;
    const firstRun = await target.jobs.run(worker);
    const firstItem = db.projectionQueue().find((item) => item.id === firstId);
    const firstProjection = db.projections().filter((row) => row.queue_item_id === firstId);
    review.verify(first.status === 202 && firstItem?.status === 'done' && firstProjection.length === 1 && firstProjection[0].tenant_id === tid, { cls: CLASSES.baselineMismatch, tenants: [T], key: 'module-denial/positive-control', title: 'The patient queue does not process work while the module is ON, so denial cannot be demonstrated', label: 'queue processes while ON', route: `job ${worker}`, expected: 'enqueue HTTP 202, item done, one projection', actual: `enqueue HTTP ${first.status}, item ${firstItem?.status ?? 'missing'}, ${firstProjection.length} projection(s), run ${firstRun.status}` });

    // The case under review: enabled, queued, disabled, then the worker runs.
    const second = await target.api.call(request, { method: 'POST', path: flag.queue.enqueueRoute, headers });
    const secondId = (second.json as { queue_item_id?: number } | null)?.queue_item_id ?? -1;
    const queuedItem = db.projectionQueue().find((item) => item.id === secondId);
    await target.control.setFlag(flag.name, false);
    const run = await target.jobs.run(worker);
    const item = db.projectionQueue().find((entry) => entry.id === secondId);
    const projections = db.projections().filter((row) => row.queue_item_id === secondId);
    const executed = projections.length > 0 || item?.status === 'done';
    review.verify(second.status === 202 && queuedItem?.status === 'queued' && !executed, {
      ...denial,
      key: 'module-denial/queued-work-executes-after-disable',
      title: 'Patient work queued while the module was ON is executed after the module is switched OFF',
      label: 'enable → queue → disable → worker',
      route: `job ${worker} (queued by POST ${flag.queue.enqueueRoute})`,
      roles: ['executive'],
      expected: 'queued item not processed; no patient projection written while the flag is OFF',
      actual: `queue item ${item?.status ?? 'missing'}${item?.result ? ` (${item.result})` : ''}; ${projections.length} projection(s) written; worker run ${run.status}`,
      preconditions: [`${flag.name} is OFF at the start and at the end.`, 'An executive test account of the tenant.'],
      steps: [`Switch ${flag.name} ON.`, `POST ${flag.queue.enqueueRoute} as the executive; note the queue item id.`, `Switch ${flag.name} OFF.`, `Run the ${worker} worker.`, 'Read the queue item and the patient projection table from the database.'],
      exchange: second,
      data: {
        flag_state_at_execution: await target.control.flag(flag.name),
        queue_item: item ?? null,
        projections_written: projections,
        worker_run: run,
      },
      signal: executed ? 'queued-item-executed-while-flag-off' : 'queue-precondition-not-met',
    });
  });
});
