import fs from 'node:fs';
import path from 'node:path';
import { latestCycle, readLedger } from '../review-harness/lib/ledger';
import { evidenceDir, verifySeal, type Finding, type RetestSummary, type RunSummary } from '../review-harness/09-report/model';
import { readJson } from '../review-harness/lib/run';

/**
 * Proves the harness against the demo target's known defects.
 *
 *   npm run validate:findings               the initial run reported exactly the expected findings, each for the expected reason
 *   npm run validate:findings -- --retest   the latest retest verified every one of them fixed, with nothing new
 *
 * The expectations come from review-harness/internal/expected-defects.json, which
 * no review stage reads. This is a check of the harness, not part of a review.
 */

interface Expected {
  expected_finding_id: string;
  expected_severity: string;
  expected_category: string;
  affected_role: string;
  affected_component: string;
  expected_detection_stage: string;
  expected_key: string;
  expected_signal: string;
}

const root = path.resolve(__dirname, '..');
const problems: string[] = [];
const lines: string[] = [];
const check = (ok: boolean, pass: string, failure: string) => {
  lines.push(`  ${ok ? 'ok  ' : 'FAIL'} ${ok ? pass : failure}`);
  if (!ok) problems.push(failure);
};

const cycle = latestCycle(readLedger());
if (!cycle) {
  console.error('[validate] No initial review run found. Run `npm run review` first.');
  process.exit(2);
}
const expected = (JSON.parse(fs.readFileSync(path.join(root, 'review-harness', 'internal', 'expected-defects.json'), 'utf8')) as { expected: Expected[] }).expected;
const runDir = evidenceDir(cycle.baseline_run);
const summary = readJson<RunSummary>(path.join(runDir, 'run-summary.json'));
if (!summary) {
  console.error(`[validate] ${cycle.baseline_run} has no run summary; the review did not complete.`);
  process.exit(2);
}
const findings = summary.findings.map((id) => readJson<Finding>(path.join(runDir, id, 'finding.json'))).filter((f): f is Finding => f !== null);

console.log(`[validate] ${cycle.baseline_run} (build ${cycle.baseline_sha.slice(0, 12)}): ${findings.length} finding(s) reported, ${expected.length} expected`);
check(summary.stages.every((stage) => stage.executed), 'all stages executed', `stages not executed: ${summary.stages.filter((s) => !s.executed).map((s) => s.id).join(', ')}`);
check(summary.harness_errors.length === 0, 'no harness errors', `${summary.harness_errors.length} harness error(s): a test failed for a reason other than a recorded check`);

for (const want of expected) {
  const found = findings.find((finding) => finding.key === want.expected_key);
  if (!found) {
    check(false, '', `${want.expected_finding_id}: not detected (no finding with key "${want.expected_key}")`);
    continue;
  }
  const reasons: string[] = [];
  if (found.id !== want.expected_finding_id) reasons.push(`id ${found.id}, expected ${want.expected_finding_id}`);
  if (found.severity !== want.expected_severity) reasons.push(`severity ${found.severity}, expected ${want.expected_severity}`);
  if (found.category !== want.expected_category) reasons.push(`category ${found.category}, expected ${want.expected_category}`);
  if (found.detection.stage !== want.expected_detection_stage) reasons.push(`detected in ${found.detection.stage}, expected ${want.expected_detection_stage}`);
  if (!found.affected_roles.includes(want.affected_role)) reasons.push(`role ${want.affected_role} not among affected roles`);
  if (!found.affected_route_or_job.includes(want.affected_component)) reasons.push(`component "${want.affected_component}" not in "${found.affected_route_or_job}"`);
  // The reason: the diagnostic the failing checks recorded, not merely "something failed in that area".
  if (!found.detection.signals.includes(want.expected_signal)) reasons.push(`signal "${want.expected_signal}" not recorded (got ${found.detection.signals.join(', ') || 'none'})`);
  if (found.build.git_sha !== cycle.baseline_sha) reasons.push('finding references a different build than the run');
  check(reasons.length === 0, `${found.id} ${found.severity.padEnd(8)} ${want.expected_detection_stage}  ${want.expected_signal}`, `${want.expected_finding_id}: ${reasons.join('; ')}`);
}

const keys = new Set(expected.map((want) => want.expected_key));
const extra = findings.filter((finding) => !keys.has(finding.key));
check(extra.length === 0, 'no false positives (no finding outside the expected set)', `unexpected finding(s): ${extra.map((f) => `${f.id} ${f.key}`).join(', ')}`);

if (process.argv.includes('--retest')) {
  const last = cycle.retests.at(-1);
  const retest = last ? readJson<RetestSummary>(path.join(evidenceDir(last.run_id), 'retest', 'retest-summary.json')) : null;
  if (!last || !retest) {
    check(false, '', 'no retest run found');
  } else {
    console.log(`[validate] retest ${last.run_id} (build ${last.sha.slice(0, 12)})`);
    check(last.sha !== cycle.baseline_sha, 'retest ran against a new build', 'retest ran against the same build as the original run');
    for (const want of expected) {
      const record = retest.records.find((r) => r.key === want.expected_key);
      const ok = record?.retest_status === 'VERIFIED_FIXED' && record.reexecuted === record.originally_failing_checks && record.now_failing === 0;
      check(ok, `${want.expected_finding_id} VERIFIED_FIXED (${record?.now_passing}/${record?.originally_failing_checks} originally failing checks re-executed and passing)`, `${want.expected_finding_id}: retest status ${record?.retest_status ?? 'not retested'}`);
    }
    check(retest.new_findings.length === 0, 'no new findings on the remediated build', `new finding(s) on the remediated build: ${retest.new_findings.join(', ')}`);
    check(retest.regression.outside_original_findings_failed === 0, `adjacent regression clean (${retest.regression.checks_passed} checks passed)`, `${retest.regression.outside_original_findings_failed} regression check(s) failed`);
    const seal = verifySeal(cycle.baseline_run);
    check(seal.intact, `original evidence intact (${seal.files_verified} files match their checksums)`, `original evidence changed: ${seal.mismatches.join(', ')}`);
  }
}

console.log(lines.join('\n'));
console.log(problems.length ? `[validate] FAILED: ${problems.length} problem(s)` : '[validate] PASSED');
process.exit(problems.length ? 1 : 0);
