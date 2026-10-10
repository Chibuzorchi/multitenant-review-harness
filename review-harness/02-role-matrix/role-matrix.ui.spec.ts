import { PERMISSIONS, expectedDecision } from '../../config/permissions';
import { PRIMARY_TENANT, ROLES, ROLE_LABEL, account } from '../../config/roles';
import { NAVIGATION, OPERATIONS, UI } from '../../config/routes';
import { CLASSES } from '../lib/catalogue';
import { decideApi, type MatrixLine, type Outcome } from '../lib/decisions';
import { pageName, test } from '../lib/fixtures';
import { appendJsonl, runPaths } from '../lib/run';
import { subjectsFor } from '../lib/subjects';

/**
 * Stage 02, browser surface. The same matrix through the UI, plus the request a
 * curious user makes next: typing the API address into a signed-in browser.
 * A control that only exists in the page is recorded as a failure.
 */

const denied = UI.deniedPages as readonly string[];

for (const role of ROLES) {
  test.describe(`02 role matrix · UI · ${role}`, () => {
    for (const op of OPERATIONS) {
      if (!op.ui && !(op.browserDirect && op.api)) continue;
      test(op.id, async ({ page, context, signIn, target, review }) => {
        const who = account(PRIMARY_TENANT, role);
        const subjects = subjectsFor(target, PRIMARY_TENANT, role);
        const expected = expectedDecision(role, op.permission);
        await signIn(context, who);
        const common = {
          route: op.route,
          roles: [role],
          tenants: [PRIMARY_TENANT],
          expected: `${expected} (permission ${op.permission}: ${PERMISSIONS[op.permission].join(', ') || 'no role'})`,
          preconditions: [`Signed in to the browser as the ${ROLE_LABEL[role]} test account of tenant ${PRIMARY_TENANT}.`],
        };
        const key = expected === 'denied' ? `role-boundary/${op.id}` : `role-boundary/over-restricted/${op.id}`;
        const title = expected === 'denied' ? `The server lets a role without permission: ${op.label.toLowerCase()}` : `A role with permission is refused: ${op.label.toLowerCase()}`;
        const cls = expected === 'allowed' ? CLASSES.roleOverRestricted : CLASSES.roleBoundaryRead;

        if (op.ui) {
          await page.goto(op.ui.path(subjects));
          const shown = await pageName(page, UI.pageSelector, UI.pageAttribute);
          const proof = op.ui.proves?.(subjects);
          let result: Outcome = 'error';
          let detail = `page "${shown}"`;
          if (shown === op.ui.page) {
            const present = proof ? (await page.locator(proof).count()) > 0 : true;
            result = present ? 'allowed' : 'denied';
            if (!present) detail += ', protected content not rendered';
          } else if (shown !== null && denied.includes(shown)) {
            result = 'denied';
          }
          const ok = result === expected;
          await review.verifyPage(page, ok, {
            ...common,
            key,
            title,
            cls,
            label: `${role} ui`,
            actual: `${result} (${detail})`,
            steps: [`Open ${op.ui.path(subjects)} in the signed-in browser.`, 'Read which page is served and whether the protected content is rendered.'],
            signal: expected === 'denied' && result === 'allowed' ? 'denied-role-received-protected-data' : result === 'error' ? 'indeterminate-status' : 'allowed-role-refused',
          });
          const line: MatrixLine = { role, operation: op.id, label: op.label, route: op.route, permission: op.permission, expected, surface: 'ui', result, detail, ok };
          appendJsonl(runPaths.matrix(), line);
        }

        if (op.browserDirect && op.api) {
          const response = await page.goto(op.api.path(subjects));
          const status = response?.status() ?? 0;
          const text = (await response?.text().catch(() => '')) ?? '';
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          const decision = decideApi(target, op.api, status, json, subjects);
          const ok = decision.outcome === expected;
          await review.verifyPage(page, ok, {
            ...common,
            key,
            title,
            cls,
            label: `${role} browser-direct`,
            actual: `${decision.outcome} (${decision.detail})`,
            steps: [`With the same signed-in browser, type the API address ${op.api.path(subjects)} into the address bar.`, 'Read the response shown by the browser.'],
            signal: expected === 'denied' && decision.outcome === 'allowed' ? 'denied-role-received-protected-data' : decision.outcome === 'error' ? 'indeterminate-status' : 'allowed-role-refused',
          });
          const line: MatrixLine = { role, operation: op.id, label: op.label, route: op.route, permission: op.permission, expected, surface: 'browser-direct', result: decision.outcome, detail: decision.detail, ok };
          appendJsonl(runPaths.matrix(), line);
        }
      });
    }

    test('navigation shows only what the role may use', async ({ page, context, signIn, review }) => {
      await signIn(context, account(PRIMARY_TENANT, role));
      await page.goto('/');
      const hrefs = await page.locator(UI.navSelector).evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      for (const entry of NAVIGATION) {
        const expected = expectedDecision(role, entry.permission) === 'allowed';
        const visible = hrefs.includes(entry.href);
        await review.verifyPage(page, visible === expected, {
          key: `role-boundary/navigation/${entry.label.toLowerCase()}`,
          title: `Navigation to "${entry.label}" does not match the permission model`,
          label: role,
          cls: CLASSES.navigationMismatch,
          route: `navigation: ${entry.href}`,
          roles: [role],
          tenants: [PRIMARY_TENANT],
          expected: expected ? 'link shown' : 'link hidden',
          actual: visible ? 'link shown' : 'link hidden',
          steps: ['Open the dashboard.', 'Read the main navigation.'],
        });
      }
    });
  });
}
