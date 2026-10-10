import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { latestCycle, readLedger, setStatus, writeLedger } from '../review-harness/lib/ledger';

/**
 * Records a fix claim against the latest initial review run.
 *
 *   npm run demo:remediate                          build the demo fix commit from remediation/patches and claim it
 *   npm run demo:remediate -- --only 1,3            apply only some patches (demonstrates PARTIALLY/NOT_FIXED outcomes)
 *   npm run demo:remediate -- --claim --sha <sha>   claim a fix a developer has already committed
 *       [--findings FIND-001,FIND-003] [--note "..."]
 *
 * The demo fix is built as a new commit on top of the reviewed SHA and stored on
 * the branch named in remediation/manifest.json. The working tree and the
 * current branch are not touched. Nothing here marks a finding as fixed: a claim
 * only moves it to FIXED_PENDING_RETEST. Only a retest run can verify it.
 */

const root = path.resolve(__dirname, '..');
const log = (message: string) => console.log(`[remediate] ${message}`);

function fail(message: string): never {
  console.error(`[remediate] ${message}`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function git(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

interface PatchEntry {
  file: string;
  finding_key: string;
  summary: string;
}

const ledger = readLedger();
const cycle = latestCycle(ledger) ?? fail('No initial review run found. Run `npm run review` first.');
const at = new Date().toISOString();
let sha: string;
let ref: string | null = null;
let claimed: string[];
let note: string;

if (process.argv.includes('--claim')) {
  sha = git(['rev-parse', '--verify', `${arg('sha') ?? fail('--claim needs --sha <sha>')}^{commit}`]);
  const wanted = arg('findings')?.split(',').map((id) => id.trim());
  claimed = cycle.findings.filter((finding) => finding.status !== 'VERIFIED_FIXED' && (!wanted || wanted.includes(finding.id))).map((finding) => finding.id);
  const unknown = (wanted ?? []).filter((id) => !cycle.findings.some((finding) => finding.id === id));
  if (unknown.length) fail(`Not findings of ${cycle.baseline_run}: ${unknown.join(', ')}`);
  note = arg('note') ?? 'Fix claimed by the development team.';
} else {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'remediation', 'manifest.json'), 'utf8')) as { branch: string; patches: PatchEntry[] };
  const only = arg('only')?.split(',').map((n) => Number(n.trim()));
  const patches = manifest.patches.filter((_, index) => !only || only.includes(index + 1));
  if (!patches.length) fail('No patches selected.');

  // Build the fix commit in a scratch index so the working tree is never modified.
  const scratch = path.join(root, '.review-tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const index = { GIT_INDEX_FILE: path.join(scratch, 'remediate.index') };
  fs.rmSync(index.GIT_INDEX_FILE, { force: true });
  git(['read-tree', cycle.baseline_sha], index);
  for (const patch of patches) {
    try {
      git(['apply', '--cached', path.join('remediation', patch.file)], index);
    } catch {
      fail(`${patch.file} does not apply to the reviewed build ${cycle.baseline_sha.slice(0, 12)}.`);
    }
    log(`applied ${patch.file}: ${patch.summary}`);
  }
  const tree = git(['write-tree'], index);
  fs.rmSync(index.GIT_INDEX_FILE, { force: true });
  const message = [`Remediate findings from ${cycle.baseline_run}`, '', ...patches.map((patch) => `- ${patch.summary}`)].join('\n');
  sha = git(['commit-tree', tree, '-p', cycle.baseline_sha, '-m', message]);
  ref = `refs/heads/${manifest.branch}`;
  git(['update-ref', ref, sha]);

  const keys = new Set(patches.map((patch) => patch.finding_key));
  claimed = cycle.findings.filter((finding) => keys.has(finding.key) && finding.status !== 'VERIFIED_FIXED').map((finding) => finding.id);
  note = `Demo remediation: ${patches.length} of ${manifest.patches.length} patches applied on top of ${cycle.baseline_sha.slice(0, 12)}.`;
}

if (sha === cycle.baseline_sha) fail('The claimed fix is the same commit as the reviewed build.');
for (const finding of cycle.findings) {
  if (claimed.includes(finding.id)) setStatus(finding, { at, status: 'FIXED_PENDING_RETEST', run_id: null, sha, note: 'Fix claimed; not yet retested.' });
}
cycle.fix_claims.push({ at, sha, ref, findings: claimed, note });
writeLedger(ledger);

log(`fix commit ${sha.slice(0, 12)}${ref ? ` on ${ref.replace('refs/heads/', '')}` : ''} (reviewed build was ${cycle.baseline_sha.slice(0, 12)})`);
log(`${claimed.length} finding(s) now FIXED_PENDING_RETEST: ${claimed.join(', ') || 'none'}`);
log('run `npm run review:retest` to verify the claim');
