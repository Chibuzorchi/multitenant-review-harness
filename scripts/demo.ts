import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The full demonstration, end to end:
 *
 *   reset -> initial review -> report -> validate seeded-defect detection
 *         -> remediate -> retest -> retest report -> validate the retest
 *
 * Evidence from an earlier demo is moved to evidence-archive/, never deleted.
 */

const root = path.resolve(__dirname, '..');
const started = Date.now();

function step(title: string, script: string, args: string[] = []): void {
  console.log(`\n=== ${title} ===`);
  const result = spawnSync('npm', ['run', '--silent', script, ...(args.length ? ['--', ...args] : [])], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    console.error(`\n[demo] stopped: "${title}" exited with ${result.status ?? result.signal}`);
    process.exit(result.status ?? 1);
  }
}

console.log('=== Reset ===');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const dir of ['evidence', 'reports']) {
  const from = path.join(root, dir);
  if (!fs.existsSync(from)) continue;
  const to = path.join(root, 'evidence-archive', stamp, dir);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  console.log(`[demo] previous ${dir}/ moved to ${path.relative(root, to)}/`);
}
fs.rmSync(path.join(root, '.review-tmp'), { recursive: true, force: true });

step('Seed (deterministic reset of the demo database)', 'seed');
step('Initial review', 'review');
step('Report', 'report');
step('Validate seeded-defect detection', 'validate:findings');
step('Remediate (new build, fix claimed)', 'demo:remediate');
step('Retest', 'review:retest');
step('Retest report', 'report');
step('Validate retest', 'validate:findings', ['--retest']);

console.log(`\n[demo] complete in ${Math.round((Date.now() - started) / 1000)}s`);
console.log('[demo] open reports/executive-summary.html and reports/report.html; evidence is under evidence/');
