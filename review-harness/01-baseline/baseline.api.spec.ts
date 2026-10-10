import { environment } from '../../config/environment';
import { FEATURE_FLAGS } from '../../config/feature-flags';
import { ROLES, TENANTS, allAccounts } from '../../config/roles';
import { CLASSES } from '../lib/catalogue';
import { test } from '../lib/fixtures';
import { isAllowedHost } from '../lib/egress-guard';
import { configurationChecksum, updateManifest } from '../lib/manifest';
import { subjectsFor, tenantId, tenantKeys, victimOf } from '../lib/subjects';

/**
 * Stage 01. Nothing later in the review means anything unless the build, data
 * and environment under test are the ones the review was scoped for. A failure
 * here stops the run.
 */

const base = { cls: CLASSES.baselineMismatch, route: 'environment' };

test.describe('01 baseline', () => {
  test('the target is healthy and is the candidate build', async ({ target, review }) => {
    const health = await target.control.health();
    review.verify(health.status === 'ok', { ...base, key: 'baseline/health', title: 'The target is not healthy', label: 'health endpoint', expected: 'status ok', actual: `status ${health.status}` });
    review.verify(health.buildSha === environment.run.candidateSha, {
      ...base,
      key: 'baseline/build-identity',
      title: 'The running build is not the candidate under review',
      label: 'reported build SHA',
      expected: `build ${environment.run.candidateSha}`,
      actual: `build ${health.buildSha}`,
    });
  });

  test('the seed is deterministic and resets cleanly', async ({ target, review }) => {
    const first = await target.control.reset();
    const second = await target.control.reset();
    review.verify(first.seedHash === second.seedHash && first.seedVersion === second.seedVersion, {
      ...base,
      key: 'baseline/seed-determinism',
      title: 'Two resets of the test data produce different data',
      label: 'seed hash after two resets',
      expected: 'identical seed version and hash',
      actual: `${first.seedVersion}/${first.seedHash.slice(0, 12)} then ${second.seedVersion}/${second.seedHash.slice(0, 12)}`,
    });
  });

  test('exactly the scoped tenants exist', async ({ target, review }) => {
    const found = target.database.tenants().map((tenant) => tenant.slug).sort();
    const scoped = TENANTS.map((tenant) => tenant.slug).sort();
    review.verify(JSON.stringify(found) === JSON.stringify(scoped), { ...base, key: 'baseline/tenants', title: 'The tenants in the environment are not the tenants in scope', label: 'tenant list', expected: scoped.join(', '), actual: found.join(', ') });
  });

  test('every role account authenticates as the expected role and tenant', async ({ target, review, credentials, newClient }) => {
    const client = await newClient();
    for (const account of allAccounts()) {
      const headers = await credentials.as(account);
      const { identity } = await target.auth.whoami(client, headers);
      const ok = identity?.email === account.email && identity.role === account.role && identity.tenantId === tenantId(target, account.tenant);
      review.verify(ok, {
        ...base,
        key: 'baseline/accounts',
        title: 'A review account does not have the role or tenant the review assumes',
        label: `${account.tenant} ${account.email}`,
        roles: [account.role],
        tenants: [account.tenant],
        expected: `${account.role} in tenant ${account.tenant}`,
        actual: identity ? `${identity.role} in tenant id ${identity.tenantId}` : 'not authenticated',
      });
    }
  });

  test('the data needed by every stage is present', async ({ target, review }) => {
    for (const key of tenantKeys()) {
      let problem: string | null = null;
      try {
        for (const role of ROLES) subjectsFor(target, key, role);
        victimOf(target, key);
      } catch (error) {
        problem = (error as Error).message;
      }
      review.verify(problem === null, { ...base, key: 'baseline/test-data', title: 'Records the review depends on are missing', label: `tenant ${key}`, tenants: [key], expected: 'own, peer and cross-tenant records resolvable', actual: problem ?? 'resolved' });
    }
    const dangling = target.database.crossTenantReferences();
    review.verify(dangling.length === 0, {
      ...base,
      key: 'baseline/data-integrity',
      title: 'Seeded records reference rows in another tenant',
      label: 'cross-tenant references in the system of record',
      expected: 'none',
      actual: `${dangling.length}`,
      data: dangling.slice(0, 10),
    });
  });

  test('feature flags are in the state the release requires', async ({ target, review }) => {
    const flags = await target.control.flags();
    for (const flag of FEATURE_FLAGS) {
      review.verify(flags[flag.name] === flag.requiredState, { ...base, key: `baseline/flag/${flag.name}`, title: 'A feature flag is not in its release state', label: flag.name, expected: String(flag.requiredState), actual: String(flags[flag.name]) });
    }
  });

  test('outbound actions are contained before anything is exercised', async ({ target, review }) => {
    const egress = await target.outbound.egress();
    const foreign = egress.allowHosts.filter((host) => !isAllowedHost(host));
    review.verify(foreign.length === 0, {
      cls: CLASSES.uncontainedOutbound,
      route: 'egress allowlist',
      key: 'containment/allowlist',
      title: 'The application may connect to hosts outside the review environment',
      label: 'application egress allowlist',
      expected: `only ${environment.allowedHosts.join(', ')}`,
      actual: egress.allowHosts.join(', '),
    });
    let sinkReachable = true;
    try {
      await target.outbound.received();
    } catch {
      sinkReachable = false;
    }
    review.verify(sinkReachable, { ...base, key: 'baseline/sink', title: 'The outbound sink is not reachable', label: 'local sink', expected: 'reachable', actual: sinkReachable ? 'reachable' : 'unreachable' });
  });

  test('record the run manifest', async ({ target }) => {
    const health = await target.control.health();
    const flags = await target.control.flags();
    const image = environment.run.candidateImage;
    updateManifest({
      run_id: environment.run.id,
      run_kind: environment.run.kind,
      baseline_run_id: environment.run.baselineRunId,
      timestamp: new Date().toISOString(),
      environment_name: environment.name,
      target_base_url: environment.baseUrl,
      api_base_url: environment.apiBaseUrl,
      outbound_sink_url: environment.sinkUrl,
      target_mode: process.env.REVIEW_TARGET_MODE ?? 'external',
      git_sha: environment.run.candidateSha,
      harness_git_sha: process.env.REVIEW_HARNESS_SHA || null,
      docker_image: {
        reference: process.env.REVIEW_CANDIDATE_IMAGE_REF || null,
        id: image,
        digest: process.env.REVIEW_CANDIDATE_IMAGE_DIGEST || null,
        note: image
          ? process.env.REVIEW_CANDIDATE_IMAGE_DIGEST
            ? null
            : 'Locally built image that was never pushed to a registry: it has an image ID but no repository digest.'
          : 'The candidate ran as a local process from an export of the commit, not as a container, so there is no image to identify. The git SHA identifies the build.',
      },
      application: { name: health.application, version: health.version, reported_build_sha: health.buildSha },
      node_version: process.version,
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      playwright_version: (require('@playwright/test/package.json') as { version: string }).version,
      seed: { version: health.seedVersion, hash: health.seedHash },
      feature_flags: flags,
      tenants: TENANTS.map((tenant) => ({ key: tenant.key, id: tenantId(target, tenant.key), slug: tenant.slug })),
      role_accounts: allAccounts().map((account) => ({ tenant: account.tenant, role: account.role, account: account.email, purpose: account.purpose })),
      configuration_checksum: configurationChecksum(),
    });
  });
});
