import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../config/environment';
import { installHarnessEgressGuard } from '../lib/egress-guard';
import { redactText } from '../lib/redact';
import { runPaths } from '../lib/run';
import { collate, scanForSecrets, seal } from './collate';
import { blocksRelease, evidenceDir, isSealed, loadModel } from './model';
import { render } from './render';

installHarnessEgressGuard('report');

export async function build(runId: string, options: { gate: boolean }): Promise<number> {
  const sealed = isSealed(runId);
  if (!sealed) {
    if (!fs.existsSync(runPaths.checks(runId))) {
      console.error(`[report] Run ${runId} has no results to collate.`);
      return 2;
    }
    collate(runId);
  }

  const model = loadModel(runId);
  const outputs = render(model);
  const reports = path.join(repoRoot, 'reports');
  fs.mkdirSync(reports, { recursive: true });
  for (const [name, content] of Object.entries(outputs)) fs.writeFileSync(path.join(reports, name), redactText(content));
  fs.copyFileSync(path.join(evidenceDir(runId), 'role-matrix.csv'), path.join(reports, 'role-matrix.csv'));
  fs.chmodSync(path.join(reports, 'role-matrix.csv'), 0o644);

  if (!sealed) {
    // Keep the reports as they stood at the time of the run alongside its evidence.
    for (const name of [...Object.keys(outputs), 'role-matrix.csv']) {
      fs.mkdirSync(path.join(evidenceDir(runId), 'reports'), { recursive: true });
      fs.copyFileSync(path.join(reports, name), path.join(evidenceDir(runId), 'reports', name));
    }
    const secrets = scanForSecrets(runId);
    if (secrets.length) {
      console.error(`[report] Credential material found in evidence for ${runId}. The run was NOT sealed:\n  ${secrets.join('\n  ')}`);
      return 3;
    }
    const files = seal(runId);
    console.log(`[report] evidence sealed: evidence/${runId}/ (${files} files, checksums.sha256)`);
  }

  const { summary, findings } = model;
  const blocking = findings.filter(blocksRelease);
  console.log(`[report] ${runId} (${summary.kind}) build ${summary.git_sha.slice(0, 12)}: ${summary.tests.passed} tests passed, ${summary.tests.failed} failed; ${summary.checks.passed} checks passed, ${summary.checks.failed} failed`);
  for (const finding of findings) console.log(`[report]   ${finding.id} ${finding.severity.padEnd(8)} ${finding.status.padEnd(20)} ${finding.title}`);
  if (summary.harness_errors.length) console.log(`[report] ${summary.harness_errors.length} test(s) failed without a finding (harness or environment problem); see reports/report.html`);
  console.log(`[report] reports written to reports/ (executive-summary.html, report.html, full-review.md, findings.json, role-matrix.csv, retest-summary.md)`);
  if (summary.harness_errors.length) return 4;
  return options.gate && blocking.length ? 1 : 0;
}
