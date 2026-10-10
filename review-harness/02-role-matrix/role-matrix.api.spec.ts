import { PERMISSIONS, expectedDecision } from '../../config/permissions';
import { PRIMARY_TENANT, ROLES, ROLE_LABEL, account } from '../../config/roles';
import { OPERATIONS } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { changedFields, tenantFingerprint } from '../lib/dbstate';
import { decideApi, type MatrixLine } from '../lib/decisions';
import { test } from '../lib/fixtures';
import { appendJsonl, runPaths } from '../lib/run';
import { subjectsFor } from '../lib/subjects';

/**
 * Stage 02, API surface. Every role is put against every operation directly,
 * with no UI in the way. The expected outcome comes from config/permissions.ts,
 * never from the application.
 */

for (const role of ROLES) {
  test.describe(`02 role matrix · API · ${role}`, () => {
    for (const op of OPERATIONS) {
      const probe = op.api;
      if (!probe) continue;
      test(op.id, async ({ target, review, credentials, request }) => {
        const who = account(PRIMARY_TENANT, role);
        const subjects = subjectsFor(target, PRIMARY_TENANT, role);
        const expected = expectedDecision(role, op.permission);
        const isWrite = probe.method !== 'GET';
        if (expected === 'allowed') review.expectOutbound(op.outbound ?? 0);

        const before = isWrite && expected === 'denied' ? tenantFingerprint(target, subjects.tenantId) : null;
        const exchange = await target.api.call(request, { method: probe.method, path: probe.path(subjects), headers: await credentials.as(who), body: probe.body?.(subjects) });
        const decision = decideApi(target, probe, exchange.status, exchange.json, subjects);
        const changed = before ? changedFields(before, tenantFingerprint(target, subjects.tenantId)) : [];

        // A refusal has to be a refusal in the database too, not only in the response.
        const ok = decision.outcome === expected && changed.length === 0;
        const signal =
          expected === 'denied' && (decision.outcome === 'allowed' || changed.length > 0)
            ? isWrite
              ? 'denied-role-performed-write'
              : 'denied-role-received-protected-data'
            : decision.outcome === 'error'
              ? 'indeterminate-status'
              : 'allowed-role-refused';

        review.verify(ok, {
          key: expected === 'denied' ? `role-boundary/${op.id}` : `role-boundary/over-restricted/${op.id}`,
          title: expected === 'denied' ? `The server lets a role without permission: ${op.label.toLowerCase()}` : `A role with permission is refused: ${op.label.toLowerCase()}`,
          label: `${role} api`,
          cls: expected === 'allowed' ? CLASSES.roleOverRestricted : isWrite ? CLASSES.roleBoundaryWrite : CLASSES.roleBoundaryRead,
          route: op.route,
          roles: [role],
          tenants: [PRIMARY_TENANT],
          expected: `${expected} (permission ${op.permission}: ${PERMISSIONS[op.permission].join(', ') || 'no role'})`,
          actual: `${decision.outcome} (${decision.detail})${changed.length ? `; database changed: ${changed.join(', ')}` : ''}`,
          preconditions: [`Signed in as the ${ROLE_LABEL[role]} test account of tenant ${PRIMARY_TENANT} with an API token.`, 'The resource addressed belongs to the same tenant.'],
          steps: [`Send ${op.route} directly to the API with the ${role} token (resolved request: ${probe.method} ${probe.path(subjects)}).`, 'Read the status and the body.', 'Check whether the protected data is present, and whether the database changed.'],
          exchange,
          data: changed.length ? { database_fields_changed: changed } : undefined,
          signal,
        });

        const line: MatrixLine = { role, operation: op.id, label: op.label, route: op.route, permission: op.permission, expected, surface: 'api', result: decision.outcome, detail: decision.detail, ok };
        appendJsonl(runPaths.matrix(), line);
      });
    }
  });
}
