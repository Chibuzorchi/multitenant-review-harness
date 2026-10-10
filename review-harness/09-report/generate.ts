import fs from 'node:fs';
import path from 'node:path';

/**
 * Stage 09 entry point.
 *
 *   npm run report                 re-render reports for the latest run
 *   npm run report -- --run <id>   a specific run
 *
 * The first time it runs for a review run it collates evidence, evaluates any
 * retest, renders the reports and seals the run folder. After that the run
 * folder is read-only and this command only re-renders `reports/` from it.
 */

const root = path.resolve(__dirname, '..', '..');
const arg = (name: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const evidenceRoot = path.resolve(root, process.env.REVIEW_EVIDENCE_ROOT ?? 'evidence');
const workDir = path.resolve(root, process.env.REVIEW_WORK_DIR ?? '.review-tmp');
const runsIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => /^RUN-/.test(name)) : []);
const runId = arg('run') ?? [...new Set([...runsIn(evidenceRoot), ...runsIn(workDir)])].sort().at(-1);

if (!runId) {
  console.error('[report] No review run found. Run `npm run review` first.');
  process.exit(2);
}

// Restore the environment the run was driven with, so paths and redaction rules match.
const saved = path.join(workDir, runId, 'run-env.json');
if (fs.existsSync(saved)) {
  for (const [key, value] of Object.entries(JSON.parse(fs.readFileSync(saved, 'utf8')) as Record<string, string>)) if (process.env[key] === undefined) process.env[key] = value;
}
process.env.REVIEW_RUN_ID = runId;

void import('./build').then(({ build }) => build(runId, { gate: process.argv.includes('--gate') })).then((code) => process.exit(code));
