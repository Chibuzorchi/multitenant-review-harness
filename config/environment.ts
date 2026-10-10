import path from 'node:path';

/**
 * The environment under review. Everything target-specific that is not a
 * secret lives here; secrets are read from the process environment only and
 * are never written to evidence.
 */

const env = process.env;
const root = path.resolve(__dirname, '..');

export interface ReviewEnvironment {
  name: string;
  /** Which adapter set drives the target. See adapters/index.ts. */
  adapter: string;
  baseUrl: string;
  apiBaseUrl: string;
  sinkUrl: string;
  /** The sink's address as the application sees it (differs from sinkUrl when the target runs in containers). */
  sinkInternalUrl: string;
  /** Hosts the harness and browser may talk to. Anything else is blocked and fails the run. */
  allowedHosts: string[];
  databasePath: string;
  logDir: string;
  run: {
    id: string;
    kind: 'initial' | 'retest';
    evidenceRoot: string;
    dir: string;
    workDir: string;
    candidateSha: string;
    candidateImage: string | null;
    baselineRunId: string | null;
  };
  /** Session/token lifetime used for expiry tests, in seconds. */
  shortTtlSeconds: number;
  secrets: { accountPassword: string; operatorKey: string };
}

const runId = env.REVIEW_RUN_ID ?? 'RUN-ADHOC';
const evidenceRoot = path.resolve(root, env.REVIEW_EVIDENCE_ROOT ?? 'evidence');
const baseUrl = env.REVIEW_BASE_URL ?? 'http://127.0.0.1:3000';

export const environment: ReviewEnvironment = {
  name: env.REVIEW_ENV_NAME ?? 'referraldesk-local',
  adapter: env.REVIEW_ADAPTER ?? 'referraldesk',
  baseUrl,
  apiBaseUrl: env.REVIEW_API_BASE_URL ?? `${baseUrl}/api`,
  sinkUrl: env.REVIEW_SINK_URL ?? 'http://127.0.0.1:4010',
  sinkInternalUrl: env.REVIEW_SINK_INTERNAL_URL ?? env.REVIEW_SINK_URL ?? 'http://127.0.0.1:4010',
  allowedHosts: ['localhost', '127.0.0.1', '::1', ...(env.REVIEW_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)],
  databasePath: path.resolve(root, env.REVIEW_DB_PATH ?? 'data/referraldesk.db'),
  logDir: path.resolve(root, env.REVIEW_LOG_DIR ?? 'data/logs'),
  run: {
    id: runId,
    kind: env.REVIEW_KIND === 'retest' ? 'retest' : 'initial',
    evidenceRoot,
    dir: path.join(evidenceRoot, runId),
    workDir: path.resolve(root, env.REVIEW_WORK_DIR ?? '.review-tmp'),
    candidateSha: env.REVIEW_CANDIDATE_SHA ?? 'unknown',
    candidateImage: env.REVIEW_CANDIDATE_IMAGE || null,
    baselineRunId: env.REVIEW_BASELINE_RUN || null,
  },
  shortTtlSeconds: 2,
  secrets: {
    accountPassword: env.REVIEW_ACCOUNT_PASSWORD ?? 'Fictional-Demo-Pass-1',
    operatorKey: env.REVIEW_OPERATOR_KEY ?? 'local-demo-ops-key',
  },
};

export const repoRoot = root;
