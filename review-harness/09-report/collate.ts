import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { loadTarget } from '../../adapters';
import { environment } from '../../config/environment';
import { STAGES, type FindingStatus, type Severity } from '../lib/catalogue';
import type { MatrixLine } from '../lib/decisions';
import type { CheckRecord } from '../lib/fixtures';
import { readLedger, setStatus, writeLedger, type Cycle, type LedgerFinding } from '../lib/ledger';
import type { Manifest } from '../lib/manifest';
import { findSecrets, redactText, redactValue } from '../lib/redact';
import { readJson, readJsonl, runPaths, writeJson } from '../lib/run';
import { evidenceDir, listFiles, sealedChecks, severityRank, sha256, short, stageIndex, verifySeal, type Finding, type RetestRecord, type RetestSummary, type RunSummary, type StageSummary } from './model';

/**
 * Turns the raw output of a review run into sealed evidence: finding folders,
 * the role matrix, archived logs and, for a retest, a verdict per original
 * finding. Only artifacts that were really captured are written.
 */

const strip = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, '');
const csv = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, redactText(text));
}

// ---- Playwright results ----------------------------------------------------

interface PwSuite { title: string; suites?: PwSuite[]; specs?: Array<{ title: string; tests: Array<{ projectName: string; status: string; results: Array<{ errors?: Array<{ message?: string }> }> }> }> }
interface PwReport { suites?: PwSuite[]; errors?: Array<{ message?: string }>; stats?: { expected: number; unexpected: number; skipped: number; flaky: number; duration: number } }

function stageSummaries(runId: string, checks: CheckRecord[]): { stages: StageSummary[]; harnessErrors: RunSummary['harness_errors'] } {
  const harnessErrors: RunSummary['harness_errors'] = [];
  const invocations = readJsonl<{ stage: string; invocation: string }>(runPaths.stageLog(runId));
  const stages = STAGES.filter((stage) => stage.id !== '09-report').map((stage): StageSummary => {
    const mine = invocations.filter((entry) => entry.stage === stage.id);
    const summary: StageSummary = { id: stage.id, title: stage.title, purpose: stage.purpose, executed: mine.length > 0, tests: { passed: 0, failed: 0, skipped: 0 }, checks: { passed: 0, failed: 0 }, duration_ms: 0 };
    for (const entry of mine) {
      const report = readJson<PwReport>(path.join(runPaths.results(runId), `${entry.invocation}.json`));
      if (!report?.stats) {
        harnessErrors.push({ stage: stage.id, test: '(runner)', message: 'The test runner produced no result file for this stage.' });
        continue;
      }
      summary.tests.passed += report.stats.expected + report.stats.flaky;
      summary.tests.failed += report.stats.unexpected;
      summary.tests.skipped += report.stats.skipped;
      summary.duration_ms += Math.round(report.stats.duration);
      for (const error of report.errors ?? []) harnessErrors.push({ stage: stage.id, test: '(runner)', message: strip(error.message ?? 'unknown error').slice(0, 600) });
      const walk = (suite: PwSuite, trail: string[]) => {
        for (const spec of suite.specs ?? []) {
          for (const test of spec.tests) {
            if (test.status !== 'unexpected') continue;
            // A failure made only of recorded checks is a finding. Anything else is a problem with the harness or environment.
            const stray = test.results.flatMap((result) => result.errors ?? []).map((error) => strip(error.message ?? '')).filter((message) => !/^Error: \[[^\]]+\] /.test(message));
            for (const message of stray) harnessErrors.push({ stage: stage.id, test: [...trail, spec.title, `[${test.projectName}]`].join(' > '), message: message.slice(0, 600) });
          }
        }
        for (const child of suite.suites ?? []) walk(child, [...trail, child.title]);
      };
      for (const suite of report.suites ?? []) walk(suite, []);
    }
    const stageChecks = checks.filter((check) => check.stage === stage.id);
    summary.checks = { passed: stageChecks.filter((check) => check.ok).length, failed: stageChecks.filter((check) => !check.ok).length };
    return summary;
  });
  return { stages, harnessErrors };
}

// ---- Role matrix -----------------------------------------------------------

function roleMatrix(runId: string): { text: string; rows: number; failed: number } {
  const lines = readJsonl<MatrixLine>(runPaths.matrix(runId));
  const groups = new Map<string, MatrixLine[]>();
  for (const line of lines) {
    const key = `${line.role}\u0000${line.operation}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  const out = ['role,operation,route,expected,actual,UI result,API result,status'];
  let failed = 0;
  for (const group of groups.values()) {
    const api = group.filter((line) => line.surface === 'api');
    const ui = group.filter((line) => line.surface === 'ui');
    const direct = group.filter((line) => line.surface === 'browser-direct');
    const server = [...api, ...direct];
    const describe = (list: MatrixLine[]) => (list.length ? [...new Set(list.map((line) => `${line.result} (${line.detail})`))].join('; ') : 'not applicable');
    // "actual" is what the server lets the role do, whatever the UI shows.
    const results = (server.length ? server : ui).map((line) => line.result);
    const actual = results.includes('allowed') ? 'allowed' : results.includes('error') ? 'error' : 'denied';
    const ok = group.every((line) => line.ok);
    if (!ok) failed++;
    const first = api[0] ?? group[0];
    out.push([first.role, first.operation, first.route, first.expected, actual, describe(ui), describe(server), ok ? 'PASS' : 'FAIL'].map(csv).join(','));
  }
  return { text: out.join('\n') + '\n', rows: groups.size, failed };
}

// ---- Finding folders -------------------------------------------------------

const TEXT_ENTRY = /\.(trace|network|json|txt|html|css|js|stacks|md)$/i;

/** Playwright traces record headers, cookies and typed values. Rewrite the archive with credentials removed. */
function sanitiseTrace(source: string, destination: string): void {
  const zip = new AdmZip(source);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const data = entry.getData();
    if (!TEXT_ENTRY.test(entry.entryName) && data.subarray(0, 512).includes(0)) continue;
    const original = data.toString('utf8');
    const cleaned = redactText(original).replace(/("name":"(?:cookie|set-cookie|authorization|x-ops-key)","value":")(?:[^"\\]|\\.)*"/gi, '$1[REDACTED]"');
    if (cleaned !== original) zip.updateFile(entry.entryName, Buffer.from(cleaned, 'utf8'));
  }
  zip.writeZip(destination);
}

function firstExisting(dirs: string[], pattern: RegExp): string | null {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const hit = fs.readdirSync(dir).filter((name) => pattern.test(name)).sort()[0];
    if (hit) return path.join(dir, hit);
  }
  return null;
}

function reproduction(check: CheckRecord, manifest: Manifest): string[] {
  if (check.steps.length) return check.steps;
  const steps = [`Start build ${short(manifest.git_sha)} with seed ${manifest.seed.version} (${short(manifest.seed.hash)}) and the feature flags recorded in the manifest.`];
  const who = `${check.roles.length ? check.roles[0] : 'a signed-in user'}${check.tenants.length ? ` of tenant ${check.tenants[0]}` : ''}`;
  if (check.exchange) {
    const url = new URL(check.exchange.request.url);
    steps.push(`Authenticate as ${who}.`);
    steps.push(`Send ${check.exchange.request.method} ${url.pathname}${url.search}${check.exchange.request.body ? ' with the body in request.json' : ''}.`);
  } else {
    steps.push(`Run the check "${check.label}" (${check.test}) against ${check.route}${check.roles.length ? ` as ${who}` : ''}.`);
  }
  steps.push(`Expected: ${check.expected}.`);
  steps.push(`Observed: ${check.actual}.`);
  return steps;
}

function writeFinding(runId: string, id: string, status: FindingStatus, failing: CheckRecord[], underKey: number, manifest: Manifest): Finding {
  const dir = path.join(evidenceDir(runId), id);
  fs.mkdirSync(dir, { recursive: true });
  const primary = failing.find((check) => check.exchange && check.signal) ?? failing.find((check) => check.exchange) ?? failing[0];
  const artifacts: string[] = [];

  if (primary.exchange) {
    writeJson(path.join(dir, 'request.json'), redactValue({ check: primary.label, at: primary.exchange.at, ...primary.exchange.request }));
    writeJson(path.join(dir, 'response.json'), redactValue({ check: primary.label, at: primary.exchange.at, ...primary.exchange.response }));
  }

  writeJson(path.join(dir, 'observations.json'), {
    finding: id,
    failing_checks: failing.length,
    shown: Math.min(failing.length, 40),
    checks: failing.slice(0, 40).map((check) => redactValue({ id: check.id, test: check.test, project: check.project, at: check.at, label: check.label, route: check.route, roles: check.roles, tenants: check.tenants, expected: check.expected, actual: check.actual, signal: check.signal, request: check.exchange ? `${check.exchange.request.method} ${check.exchange.request.url}` : null, response_status: check.exchange?.response.status ?? null, data: check.data })),
  });
  artifacts.push('observations.json');

  // Browser artifacts exist only where a browser test failed; prefer the test that took a screenshot at the failing check.
  const withShot = failing.find((check) => check.screenshot && fs.existsSync(check.screenshot));
  const browserDirs = [...new Set(failing.filter((check) => check.project !== 'api').map((check) => check.output_dir))];
  const dirs = [...new Set([...(withShot ? [withShot.output_dir] : []), ...browserDirs, ...failing.map((check) => check.output_dir)])];
  const screenshot = withShot?.screenshot ?? firstExisting(browserDirs, /\.png$/);
  if (screenshot) {
    fs.copyFileSync(screenshot, path.join(dir, 'screenshot.png'));
    artifacts.push('screenshot.png');
  }
  const video = firstExisting(dirs, /\.webm$/);
  if (video) {
    fs.copyFileSync(video, path.join(dir, 'video.webm'));
    artifacts.push('video.webm');
  }
  const trace = firstExisting(dirs, /^trace\.zip$/);
  if (trace) {
    sanitiseTrace(trace, path.join(dir, 'trace.zip'));
    artifacts.push('trace.zip');
  }

  // Server-side view of the failing requests, taken from the application's own access log.
  const target = loadTarget();
  const lines = [`# ${id} · ${primary.title}`, `# run ${runId} · build ${manifest.git_sha}`, '', '## Harness check log'];
  for (const check of failing.slice(0, 40)) lines.push(`${check.at} FAIL [${check.project}] ${check.label} | ${check.route} | expected: ${check.expected} | actual: ${check.actual}${check.signal ? ` | signal: ${check.signal}` : ''}`);
  if (failing.length > 40) lines.push(`… ${failing.length - 40} further failing check(s) recorded in ../checks.jsonl`);
  lines.push('', '## Application access log (the requests above, as the server recorded them)');
  let matched = 0;
  for (const check of failing.filter((entry) => entry.exchange).slice(0, 40)) {
    const at = Date.parse(check.exchange!.at);
    const pathname = new URL(check.exchange!.request.url).pathname;
    for (const entry of target.logs.access(new Date(at - 500).toISOString(), new Date(at + 3000).toISOString()).filter((line) => line.path.split('?')[0] === pathname && line.method === check.exchange!.request.method).slice(0, 1)) {
      lines.push(JSON.stringify(entry));
      matched++;
    }
  }
  if (!matched) lines.push('(no matching access-log entries: this finding was observed through the database or a background job rather than an HTTP request)');
  writeText(path.join(dir, 'logs.txt'), lines.join('\n') + '\n');
  artifacts.push('logs.txt');

  const routes = [...new Set(failing.map((check) => check.route))];
  const finding: Finding = {
    id,
    key: primary.key,
    title: primary.title,
    severity: failing.map((check) => check.severity).sort((a, b) => severityRank(a) - severityRank(b))[0],
    status,
    category: primary.category,
    affected_roles: [...new Set(failing.flatMap((check) => check.roles))],
    affected_tenants: [...new Set(failing.flatMap((check) => check.tenants))].sort(),
    affected_route_or_job: routes.slice(0, 4).join('; ') + (routes.length > 4 ? `; and ${routes.length - 4} more` : ''),
    build: { git_sha: manifest.git_sha, application: manifest.application.name, version: manifest.application.version, image: manifest.docker_image.digest ?? manifest.docker_image.id },
    run_id: runId,
    manifest: '../manifest.json',
    detection: { stage: primary.stage, failing_checks: failing.length, checks_under_key: underKey, signals: [...new Set(failing.map((check) => check.signal).filter((signal): signal is string => Boolean(signal)))] },
    preconditions: primary.preconditions.length ? primary.preconditions : [`Build ${short(manifest.git_sha)} running in environment "${manifest.environment_name}".`, `Deterministic seed ${manifest.seed.version} (${short(manifest.seed.hash)}).`, `Feature flags: ${Object.entries(manifest.feature_flags).map(([name, on]) => `${name}=${on ? 'ON' : 'OFF'}`).join(', ')}.`, 'Fictional seed accounts listed in the manifest (role_accounts).'],
    reproduction_steps: reproduction(primary, manifest),
    expected_result: primary.expected,
    actual_result: failing.length > 1 ? `${primary.actual} (${failing.length} checks failed under this finding; see observations.json)` : primary.actual,
    security_impact: primary.security_impact,
    business_impact: primary.business_impact,
    request_evidence: primary.exchange ? 'request.json' : null,
    response_evidence: primary.exchange ? 'response.json' : null,
    supporting_artifacts: artifacts,
    first_seen_run: runId,
    first_seen_sha: manifest.git_sha,
    retest_run: null,
    retest_sha: null,
    retest_status: null,
  };
  writeJson(path.join(dir, 'finding.json'), redactValue(finding));
  return finding;
}

function ledgerEntry(finding: Finding, note: string): LedgerFinding {
  return {
    id: finding.id,
    key: finding.key,
    title: finding.title,
    severity: finding.severity as Severity,
    category: finding.category,
    stage: finding.detection.stage,
    first_seen_run: finding.first_seen_run,
    first_seen_sha: finding.first_seen_sha,
    status: finding.status,
    retest_run: null,
    retest_sha: null,
    retest_status: null,
    history: [{ at: new Date().toISOString(), status: finding.status, run_id: finding.run_id, sha: finding.first_seen_sha, note }],
  };
}

function groupFailing(checks: CheckRecord[]): Array<[string, CheckRecord[]]> {
  const groups = new Map<string, CheckRecord[]>();
  for (const check of checks.filter((entry) => !entry.ok)) groups.set(check.key, [...(groups.get(check.key) ?? []), check]);
  return [...groups.entries()].sort((a, b) => stageIndex(a[1][0].stage) - stageIndex(b[1][0].stage) || a[1][0].at.localeCompare(b[1][0].at));
}

// ---- Retest ----------------------------------------------------------------

function evaluateRetest(runId: string, manifest: Manifest, checks: CheckRecord[], cycle: Cycle, newFindings: string[]): RetestSummary {
  const now = new Map(checks.map((check) => [check.id, check]));
  const originalKeys = new Set(cycle.findings.filter((entry) => entry.first_seen_run !== runId).map((entry) => entry.key));
  const records: RetestRecord[] = [];
  const baselineChecks = new Map<string, CheckRecord[]>();
  const checksOf = (run: string) => baselineChecks.get(run) ?? (baselineChecks.set(run, sealedChecks(run)), baselineChecks.get(run)!);

  for (const entry of cycle.findings.filter((item) => item.first_seen_run !== runId)) {
    const original = checksOf(entry.first_seen_run).filter((check) => check.key === entry.key && !check.ok);
    const reexecuted = original.filter((check) => now.has(check.id));
    const underKey = checks.filter((check) => check.key === entry.key);
    const failing = underKey.filter((check) => !check.ok);
    const passing = reexecuted.filter((check) => now.get(check.id)!.ok);
    let verdict: FindingStatus | null;
    let outcome: string;
    if (reexecuted.length < original.length) {
      // Never report a retest that did not happen.
      verdict = null;
      outcome = `Not retested: ${original.length - reexecuted.length} of the ${original.length} originally failing check(s) were not executed in this run. Status left unchanged.`;
    } else if (failing.length === 0) {
      verdict = 'VERIFIED_FIXED';
      outcome = `All ${original.length} originally failing check(s) were re-executed against build ${short(manifest.git_sha)} and now pass.`;
    } else if (passing.length > 0) {
      verdict = 'PARTIALLY_FIXED';
      outcome = `${passing.length} of ${original.length} originally failing check(s) now pass; ${failing.length} check(s) under this finding still fail.`;
    } else {
      verdict = 'NOT_FIXED';
      outcome = `The originally failing check(s) still fail against build ${short(manifest.git_sha)}.`;
    }
    const stageChecks = checks.filter((check) => check.stage === entry.stage && check.key !== entry.key);
    const record: RetestRecord = {
      finding_id: entry.id,
      key: entry.key,
      title: entry.title,
      severity: entry.severity,
      original_run: entry.first_seen_run,
      original_sha: entry.first_seen_sha,
      original_evidence: `../../../${entry.first_seen_run}/${entry.id}/finding.json`,
      retest_run: runId,
      retest_sha: manifest.git_sha,
      manifest: '../../manifest.json',
      status_before: entry.status,
      retest_status: verdict,
      outcome,
      originally_failing_checks: original.length,
      reexecuted: reexecuted.length,
      now_passing: passing.length,
      now_failing: failing.length,
      sample_checks: reexecuted.slice(0, 8).map((check) => {
        const current = now.get(check.id)!;
        return { label: check.label, route: check.route, expected: check.expected, original_actual: check.actual, retest_actual: current.actual, ok: current.ok, response_status: current.exchange?.response.status ?? null };
      }),
      adjacent_regression: { stage: entry.stage, checks_passed: stageChecks.filter((check) => check.ok).length, checks_failed: stageChecks.filter((check) => !check.ok).length, failed_keys: [...new Set(stageChecks.filter((check) => !check.ok).map((check) => check.key))] },
    };
    writeJson(path.join(evidenceDir(runId), 'retest', entry.id, 'retest.json'), redactValue(record));
    records.push(record);
    if (verdict) {
      entry.retest_run = runId;
      entry.retest_sha = manifest.git_sha;
      entry.retest_status = verdict;
      setStatus(entry, { at: new Date().toISOString(), status: verdict, run_id: runId, sha: manifest.git_sha, note: outcome });
    }
  }

  const baselineSeal = verifySeal(cycle.baseline_run);
  const claim = [...cycle.fix_claims].reverse().find((entry) => entry.sha === manifest.git_sha) ?? null;
  cycle.retests.push({ run_id: runId, sha: manifest.git_sha, at: new Date().toISOString() });
  const summary: RetestSummary = {
    retest_run: runId,
    retest_sha: manifest.git_sha,
    baseline_run: cycle.baseline_run,
    baseline_sha: cycle.baseline_sha,
    fix_claim: claim ? { sha: claim.sha, at: claim.at, note: claim.note } : null,
    original_evidence: baselineSeal,
    records,
    new_findings: newFindings,
    regression: { checks_passed: checks.filter((check) => check.ok).length, checks_failed: checks.filter((check) => !check.ok).length, outside_original_findings_failed: checks.filter((check) => !check.ok && !originalKeys.has(check.key)).length },
  };
  writeJson(path.join(evidenceDir(runId), 'retest', 'retest-summary.json'), summary);
  return summary;
}

// ---- Entry points ----------------------------------------------------------

export function collate(runId: string): RunSummary {
  const dir = evidenceDir(runId);
  const manifest = readJson<Manifest>(runPaths.manifest(runId));
  if (!manifest) throw new Error(`Run ${runId} has no manifest: the baseline stage did not complete, so there is nothing that can be reported as evidence.`);
  const checks = readJsonl<CheckRecord>(runPaths.checks(runId));

  const { stages, harnessErrors } = stageSummaries(runId, checks);
  const matrix = roleMatrix(runId);
  writeText(path.join(dir, 'role-matrix.csv'), matrix.text);

  const ledger = readLedger();
  const groups = groupFailing(checks);
  const count = (key: string) => checks.filter((check) => check.key === key).length;
  const created: Finding[] = [];
  let cycle: Cycle;

  if (manifest.run_kind === 'retest' && manifest.baseline_run_id && ledger.cycles[manifest.baseline_run_id]) {
    cycle = ledger.cycles[manifest.baseline_run_id];
    const known = new Set(cycle.findings.map((entry) => entry.key));
    let next = Math.max(0, ...cycle.findings.map((entry) => Number(entry.id.slice(5)))) + 1;
    const baseline = sealedChecks(cycle.baseline_run);
    for (const [key, failing] of groups.filter(([groupKey]) => !known.has(groupKey))) {
      // Something that passed on the original build and fails on the fixed build was broken by the fix.
      const passedBefore = baseline.some((check) => check.key === key) && baseline.filter((check) => check.key === key).every((check) => check.ok);
      const finding = writeFinding(runId, `FIND-${String(next++).padStart(3, '0')}`, passedBefore ? 'REGRESSION' : 'OPEN', failing, count(key), manifest);
      created.push(finding);
      cycle.findings.push(ledgerEntry(finding, passedBefore ? `Passed in ${cycle.baseline_run}; fails in retest ${runId}.` : `First observed in retest ${runId}.`));
    }
    evaluateRetest(runId, manifest, checks, cycle, created.map((finding) => finding.id));
  } else {
    cycle = { baseline_run: runId, baseline_sha: manifest.git_sha, findings: [], fix_claims: [], retests: [] };
    groups.forEach(([key, failing], index) => {
      const finding = writeFinding(runId, `FIND-${String(index + 1).padStart(3, '0')}`, 'OPEN', failing, count(key), manifest);
      created.push(finding);
      cycle.findings.push(ledgerEntry(finding, `Detected in ${runId}.`));
    });
    ledger.cycles[runId] = cycle;
    ledger.latest_cycle = runId;
  }
  writeLedger(ledger);

  // The full check log, without machine-local paths.
  fs.writeFileSync(path.join(dir, 'checks.jsonl'), checks.map((check) => JSON.stringify(redactValue({ ...check, output_dir: undefined, screenshot: undefined }))).join('\n') + '\n');

  // Logs kept with the run.
  const target = loadTarget();
  const work = runPaths.work(runId);
  const logFiles: Array<[string, string]> = [
    ...target.logs.archive(),
    ['application-stdout.txt', path.join(environment.logDir, 'application-stdout.txt')],
    ['sink-stdout.txt', path.join(environment.logDir, 'sink-stdout.txt')],
    ['containers-stdout.txt', path.join(environment.logDir, 'containers-stdout.txt')],
    ['sink-receipts.jsonl', process.env.REVIEW_SINK_LOG ?? ''],
    ['harness-egress-blocked.jsonl', path.join(work, 'harness-egress.jsonl')],
    ['browser-egress-blocked.jsonl', path.join(work, 'browser-egress.jsonl')],
    ['outbound-declarations.jsonl', path.join(work, 'outbound-ledger.jsonl')],
    ['stages.jsonl', path.join(work, 'stages.jsonl')],
    ...(fs.existsSync(work) ? fs.readdirSync(work).filter((name) => /^stage-.*\.txt$/.test(name)).map((name): [string, string] => [`runner-${name}`, path.join(work, name)]) : []),
  ];
  for (const [name, source] of logFiles) if (source && fs.existsSync(source)) writeText(path.join(dir, 'logs', name), strip(fs.readFileSync(source, 'utf8')));

  const total = (pick: (stage: StageSummary) => number) => stages.reduce((sum, stage) => sum + pick(stage), 0);
  const summary: RunSummary = {
    run_id: runId,
    kind: manifest.run_kind,
    baseline_run_id: manifest.baseline_run_id,
    git_sha: manifest.git_sha,
    collated_at: new Date().toISOString(),
    stages,
    tests: { passed: total((stage) => stage.tests.passed), failed: total((stage) => stage.tests.failed), skipped: total((stage) => stage.tests.skipped) },
    checks: { passed: checks.filter((check) => check.ok).length, failed: checks.filter((check) => !check.ok).length },
    findings: created.map((finding) => finding.id),
    harness_errors: harnessErrors,
    role_matrix: { rows: matrix.rows, failed: matrix.failed },
  };
  writeJson(path.join(dir, 'run-summary.json'), summary);
  return summary;
}

/** Scan everything about to be sealed, including the inside of trace archives, for credential material. */
export function scanForSecrets(runId: string): string[] {
  const dir = evidenceDir(runId);
  const hits: string[] = [];
  for (const name of listFiles(dir)) {
    const file = path.join(dir, name);
    if (/\.zip$/.test(name)) {
      for (const entry of new AdmZip(file).getEntries()) {
        if (entry.isDirectory) continue;
        for (const hit of findSecrets(entry.getData().toString('latin1'))) hits.push(`${name}!${entry.entryName}: ${hit}`);
      }
    } else if (!/\.(png|webm)$/.test(name)) {
      for (const hit of findSecrets(fs.readFileSync(file, 'utf8'))) hits.push(`${name}: ${hit}`);
    }
  }
  return hits;
}

/** Write the checksum list and make every file in the run folder read-only. */
export function seal(runId: string): number {
  const dir = evidenceDir(runId);
  const files = listFiles(dir).filter((name) => name !== 'checksums.sha256');
  fs.writeFileSync(path.join(dir, 'checksums.sha256'), files.map((name) => `${sha256(path.join(dir, name))}  ${name}`).join('\n') + '\n');
  for (const name of [...files, 'checksums.sha256']) fs.chmodSync(path.join(dir, name), 0o444);
  return files.length;
}
