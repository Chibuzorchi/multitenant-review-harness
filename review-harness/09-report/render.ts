import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../config/environment';
import { GLOBAL_RULES } from '../../config/permissions';
import { SEVERITIES, SEVERITY_RUBRIC, type FindingStatus } from '../lib/catalogue';
import { readJson } from '../lib/run';
import { blocksRelease, evidenceDir, isOpen, short, type FindingView, type Model, type StageSummary } from './model';

/** Renders the report set from sealed evidence. Nothing here reads the live target. */

const e = (value: unknown) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const date = (iso: string) => iso.slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STATUS_LABEL: Record<FindingStatus, string> = {
  OPEN: 'Open',
  FIXED_PENDING_RETEST: 'Fix claimed, retest pending',
  VERIFIED_FIXED: 'Verified fixed',
  PARTIALLY_FIXED: 'Partially fixed',
  NOT_FIXED: 'Not fixed',
  REGRESSION: 'Regression',
};

const CONTROLS: Array<{ label: string; stage: string }> = [
  { label: 'Tenant isolation', stage: '04-tenant-isolation' },
  { label: 'Role boundaries', stage: '02-role-matrix' },
  { label: 'Sessions and tokens', stage: '03-sessions' },
  { label: 'Patient-module denial', stage: '05-module-denial' },
  { label: 'Reconciliation', stage: '06-reconciliation' },
  { label: 'Scheduled work', stage: '07-scheduled' },
  { label: 'Containment', stage: '08-containment' },
];

interface Facts {
  verdict: { tone: 'bad' | 'good' | 'warn'; headline: string; detail: string };
  blocking: FindingView[];
  open: FindingView[];
  bySeverity: Array<{ severity: string; total: number; open: number }>;
  controls: Array<{ label: string; stage: StageSummary; result: 'PASS' | 'FAIL' | 'NOT RUN'; detail: string }>;
  image: string;
  scope: string;
  retestLine: string;
  executed: StageSummary[];
}

function facts(model: Model): Facts {
  const { summary, findings, manifest } = model;
  const blocking = findings.filter(blocksRelease);
  const open = findings.filter((finding) => isOpen(finding.status));
  const executed = summary.stages.filter((stage) => stage.executed);
  const partial = executed.length < summary.stages.length;
  const failingNow = (stage: StageSummary) => findings.filter((finding) => finding.detection.stage === stage.id && isOpen(finding.status)).map((finding) => finding.id);
  const controls = CONTROLS.map(({ label, stage: id }) => {
    const stage = summary.stages.find((entry) => entry.id === id)!;
    if (!stage.executed) return { label, stage, result: 'NOT RUN' as const, detail: 'Stage not executed in this run' };
    const total = stage.checks.passed + stage.checks.failed;
    if (stage.checks.failed === 0 && stage.tests.failed === 0) return { label, stage, result: 'PASS' as const, detail: `${plural(total, 'check')} passed` };
    const ids = failingNow(stage);
    return { label, stage, result: 'FAIL' as const, detail: `${stage.checks.failed} of ${plural(total, 'check')} failed${ids.length ? ` (${ids.join(', ')})` : ''}` };
  });

  let verdict: Facts['verdict'];
  if (summary.harness_errors.length) verdict = { tone: 'warn', headline: 'Review incomplete', detail: `${plural(summary.harness_errors.length, 'test')} failed for a reason other than a finding. The results below cannot support a release decision until that is resolved.` };
  else if (blocking.length) verdict = { tone: 'bad', headline: 'Not ready for release', detail: `${plural(blocking.length, 'release-blocking finding')} open (${blocking.map((finding) => finding.id).join(', ')}).` };
  else if (open.length) verdict = { tone: 'warn', headline: 'No release-blocking findings open', detail: `${plural(open.length, 'lower-severity finding')} remain open (${open.map((finding) => finding.id).join(', ')}).` };
  else if (partial) verdict = { tone: 'warn', headline: 'No findings open in the stages that were run', detail: `Partial scope: ${executed.length} of ${summary.stages.length} stages were executed.` };
  else verdict = { tone: 'good', headline: 'No findings open', detail: `All ${summary.stages.length} stages executed; ${plural(summary.checks.passed, 'check')} passed.` };

  const image = manifest.docker_image.digest ?? (manifest.docker_image.id ? `${manifest.docker_image.id} (image ID; locally built, no registry digest)` : 'Not applicable: candidate ran as a local process from an export of the commit');
  const scope = `${manifest.application.name} ${manifest.application.version}, environment "${manifest.environment_name}": ${manifest.tenants.length} tenants, ${new Set(manifest.role_accounts.map((account) => account.role)).size} roles, UI and API, background jobs and outbound actions. Patient module flag ${manifest.feature_flags.patient_module ? 'ON' : 'OFF'}.`;

  let retestLine: string;
  if (summary.kind === 'retest' && model.retest) {
    const verified = model.retest.records.filter((record) => record.retest_status === 'VERIFIED_FIXED').length;
    retestLine = `Retest of ${model.retest.baseline_run} (build ${short(model.retest.baseline_sha)}) against build ${short(model.retest.retest_sha)}: ${verified} of ${model.retest.records.length} original findings verified fixed.`;
  } else if (findings.some((finding) => finding.status === 'FIXED_PENDING_RETEST')) {
    retestLine = `A fix has been claimed for ${plural(findings.filter((finding) => finding.status === 'FIXED_PENDING_RETEST').length, 'finding')}. No retest has been executed yet.`;
  } else {
    retestLine = 'No retest has been executed for this run.';
  }

  return {
    verdict,
    blocking,
    open,
    bySeverity: SEVERITIES.map((severity) => ({ severity, total: findings.filter((finding) => finding.severity === severity).length, open: open.filter((finding) => finding.severity === severity).length })),
    controls,
    image,
    scope,
    retestLine,
    executed,
  };
}

// ---- HTML ------------------------------------------------------------------

const CSS = `
:root{--ink:#10243a;--muted:#5a6f85;--line:#d5e3ef;--navy:#0b3d66;--blue:#1668a8;--cyan:#12a5c4;--wash:#f1f8fc;--bad:#a12a3a;--warn:#8a5a00;--good:#0b6b4f}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
.page{max-width:1040px;margin:0 auto;padding:28px 32px 48px}
header.top{border-bottom:3px solid var(--navy);padding-bottom:14px;margin-bottom:18px}
header.top .kicker{color:var(--blue);font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600}
h1{font-size:24px;margin:4px 0 2px;color:var(--navy)}
h2{font-size:17px;color:var(--navy);margin:30px 0 10px;padding-bottom:5px;border-bottom:1px solid var(--line)}
h3{font-size:14.5px;margin:18px 0 6px;color:var(--navy)}
p{margin:6px 0}
.sub{color:var(--muted);font-size:13px}
.verdict{border-left:5px solid var(--blue);background:var(--wash);padding:12px 16px;margin:14px 0}
.verdict strong{display:block;font-size:17px}
.verdict.bad{border-color:var(--bad)}.verdict.bad strong{color:var(--bad)}
.verdict.warn{border-color:var(--warn)}.verdict.warn strong{color:var(--warn)}
.verdict.good{border-color:var(--good)}.verdict.good strong{color:var(--good)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 28px}
.kv{display:grid;grid-template-columns:150px 1fr;gap:2px 10px;font-size:13px}
.kv dt{color:var(--muted)}.kv dd{margin:0;overflow-wrap:anywhere}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{background:var(--wash);color:var(--navy);text-align:left;font-weight:600;border-bottom:2px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top;overflow-wrap:anywhere}
.scroll{overflow-x:auto}
.tag{display:inline-block;border:1px solid var(--line);border-radius:3px;padding:0 6px;font-size:12px;font-weight:600;white-space:nowrap;background:#fff}
.tag.Critical{color:#fff;background:var(--navy);border-color:var(--navy)}
.tag.High{color:#fff;background:var(--blue);border-color:var(--blue)}
.tag.Medium{color:var(--navy);background:#cfeaf3;border-color:#9fd3e3}
.tag.Low,.tag.Informational{color:var(--muted)}
.res{font-weight:700}.res.PASS{color:var(--good)}.res.FAIL{color:var(--bad)}.res.NOT{color:var(--muted)}
.st{font-weight:600}.st.OPEN,.st.NOT_FIXED,.st.REGRESSION{color:var(--bad)}.st.FIXED_PENDING_RETEST,.st.PARTIALLY_FIXED{color:var(--warn)}.st.VERIFIED_FIXED{color:var(--good)}
code,pre{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{background:#f6fafd;border:1px solid var(--line);padding:10px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0}
.finding{border:1px solid var(--line);border-top:3px solid var(--blue);padding:4px 16px 14px;margin:18px 0}
.finding img{max-width:100%;border:1px solid var(--line);margin-top:6px}
ol,ul{margin:4px 0;padding-left:22px}
footer{margin-top:32px;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
@media (max-width:760px){.grid,.cols{grid-template-columns:1fr}.kv{grid-template-columns:1fr}.page{padding:18px 16px 32px}}
@media print{.page{max-width:none;padding:0}.pagebreak{break-after:page}.finding{break-inside:avoid}}
`;

const doc = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${CSS}</style>
</head>
<body><div class="page">
${body}
</div></body>
</html>
`;

const kv = (rows: Array<[string, string]>) => `<dl class="kv">${rows.map(([key, value]) => `<dt>${e(key)}</dt><dd>${value}</dd>`).join('')}</dl>`;
const tag = (severity: string) => `<span class="tag ${e(severity)}">${e(severity)}</span>`;
const status = (value: FindingStatus) => `<span class="st ${value}">${e(STATUS_LABEL[value])}</span>`;

function summaryHtml(model: Model, f: Facts): string {
  const { manifest, summary } = model;
  const kind = summary.kind === 'retest' ? 'Retest report' : 'Release review';
  return `<header class="top">
<div class="kicker">CoPilot Phase-1 Review Harness · ${e(kind)}</div>
<h1>${e(manifest.application.name)} ${e(manifest.application.version)} · build ${e(short(manifest.git_sha))}</h1>
<div class="sub">Run ${e(model.run_id)} · reviewed ${e(date(manifest.timestamp))} · demonstration against a fictional application with synthetic data</div>
</header>
<div class="verdict ${f.verdict.tone}"><strong>${e(f.verdict.headline)}</strong>${e(f.verdict.detail)}</div>
<div class="grid">
${kv([
  ['Candidate', `${e(manifest.application.name)} ${e(manifest.application.version)}`],
  ['Source SHA', `<code>${e(manifest.git_sha)}</code>`],
  ['Image digest', e(f.image)],
  ['Review date', e(date(manifest.timestamp))],
])}
${kv([
  ['Scope', e(f.scope)],
  ['Stages executed', `${f.executed.length} of ${summary.stages.length}${f.executed.length < summary.stages.length ? ` (${e(f.executed.map((stage) => stage.id.slice(0, 2)).join(', '))})` : ''}, plus reporting`],
  ['Tests', `${summary.tests.passed} passed, ${summary.tests.failed} failed${summary.tests.skipped ? `, ${summary.tests.skipped} skipped` : ''} · ${summary.checks.passed + summary.checks.failed} individual checks`],
  ['Release-blocking', f.blocking.length ? `<strong>${f.blocking.length}</strong> open (${e(f.blocking.map((finding) => finding.id).join(', '))})` : 'None open'],
])}
</div>
<div class="cols">
<div>
<h2>Results by control</h2>
<table><thead><tr><th>Control</th><th>Result</th><th>Detail</th></tr></thead><tbody>
${f.controls.map((control) => `<tr><td>${e(control.label)}</td><td><span class="res ${control.result.split(' ')[0]}">${control.result}</span></td><td>${e(control.detail)}</td></tr>`).join('\n')}
</tbody></table>
</div>
<div>
<h2>Findings by severity</h2>
<table><thead><tr><th>Severity</th><th>Found</th><th>Open</th></tr></thead><tbody>
${f.bySeverity.map((row) => `<tr><td>${tag(row.severity)}</td><td>${row.total}</td><td>${row.open}</td></tr>`).join('\n')}
</tbody></table>
<p class="sub">Severity is a five-level qualitative scale defined in this report. It is not a CVSS score. Critical and High block release.</p>
</div>
</div>
<h2>Findings and retest status</h2>
<p>${e(f.retestLine)}</p>
${
  model.findings.length
    ? `<div class="scroll"><table><thead><tr><th>ID</th><th>Severity</th><th>Finding</th><th>Status</th><th>Found in</th><th>Retested in</th></tr></thead><tbody>
${model.findings.map((finding) => `<tr><td>${e(finding.id)}</td><td>${tag(finding.severity)}</td><td>${e(finding.title)}</td><td>${status(finding.status)}</td><td>${e(finding.first_seen_run)}<br><code>${e(short(finding.first_seen_sha))}</code></td><td>${finding.retest_run ? `${e(finding.retest_run)}<br><code>${e(short(finding.retest_sha))}</code>` : 'Not retested'}</td></tr>`).join('\n')}
</tbody></table></div>`
    : '<p>No findings were recorded.</p>'
}
${summary.harness_errors.length ? `<h2>Tests that failed without a finding</h2><ul>${summary.harness_errors.map((error) => `<li><strong>${e(error.stage)}</strong> ${e(error.test)}: ${e(error.message.split('\n')[0])}</li>`).join('')}</ul>` : ''}`;
}

const footer = (model: Model) => `<footer>Evidence: <code>evidence/${e(model.run_id)}/</code> (manifest, per-finding folders, logs, checksums). Generated ${e(model.generated_at)} by harness ${e(short(model.manifest.harness_git_sha))}. ReferralDesk is a fictional application built for this demonstration; all tenants, people and businesses in it are invented. No real system was contacted.</footer>`;

function excerpt(file: string, limit = 2200): string | null {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').trim();
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated; full file in the evidence folder)` : text;
}

function findingHtml(model: Model, finding: FindingView): string {
  const dir = path.join(repoRoot, finding.evidence_dir);
  const request = finding.request_evidence ? excerpt(path.join(dir, finding.request_evidence)) : null;
  const response = finding.response_evidence ? excerpt(path.join(dir, finding.response_evidence)) : null;
  const shot = finding.supporting_artifacts.includes('screenshot.png') && fs.existsSync(path.join(dir, 'screenshot.png')) ? fs.readFileSync(path.join(dir, 'screenshot.png')).toString('base64') : null;
  const files = ['finding.json', finding.request_evidence, finding.response_evidence, ...finding.supporting_artifacts].filter((name): name is string => Boolean(name));
  const retest = model.retest?.records.find((record) => record.finding_id === finding.id);
  return `<section class="finding" id="${e(finding.id)}">
<h3>${e(finding.id)} · ${e(finding.title)}</h3>
<p>${tag(finding.severity)} ${status(finding.status)} · <span class="sub">${e(finding.category)} · detected by stage ${e(finding.detection.stage)} · ${finding.detection.failing_checks} of ${finding.detection.checks_under_key} checks failed</span></p>
${kv([
  ['Affected route or job', `<code>${e(finding.affected_route_or_job)}</code>`],
  ['Affected roles', e(finding.affected_roles.join(', ') || 'not role-specific')],
  ['Affected tenants', e(finding.affected_tenants.join(', ') || 'all')],
  ['Build', `<code>${e(finding.build.git_sha)}</code>`],
  ['First seen', `${e(finding.first_seen_run)} · manifest <code>evidence/${e(finding.first_seen_run)}/manifest.json</code>`],
  ['Retest', finding.retest_run ? `${e(finding.retest_run)} on <code>${e(short(finding.retest_sha))}</code>: ${status(finding.retest_status!)}` : 'Not retested'],
])}
<h3>Preconditions</h3><ul>${finding.preconditions.map((item) => `<li>${e(item)}</li>`).join('')}</ul>
<h3>Reproduction</h3><ol>${finding.reproduction_steps.map((item) => `<li>${e(item)}</li>`).join('')}</ol>
<h3>Expected</h3><p>${e(finding.expected_result)}</p>
<h3>Actual</h3><p>${e(finding.actual_result)}</p>
<h3>Security impact</h3><p>${e(finding.security_impact)}</p>
<h3>Business impact</h3><p>${e(finding.business_impact)}</p>
${request ? `<h3>Request</h3><pre>${e(request)}</pre>` : ''}
${response ? `<h3>Response</h3><pre>${e(response)}</pre>` : ''}
${shot ? `<h3>Screenshot</h3><img alt="Screenshot captured when the check failed for ${e(finding.id)}" src="data:image/png;base64,${shot}">` : ''}
${retest ? `<h3>Retest</h3><p>${e(retest.outcome)}</p>${retest.sample_checks.length ? `<div class="scroll"><table><thead><tr><th>Check</th><th>Original build</th><th>Retested build</th></tr></thead><tbody>${retest.sample_checks.map((check) => `<tr><td>${e(check.label)}</td><td>${e(check.original_actual)}</td><td>${e(check.retest_actual)}</td></tr>`).join('')}</tbody></table></div>` : ''}<p class="sub">Adjacent checks in stage ${e(retest.adjacent_regression.stage)}: ${retest.adjacent_regression.checks_passed} passed, ${retest.adjacent_regression.checks_failed} failed.</p>` : ''}
<h3>Evidence files</h3><p>${files.map((name) => `<code>${e(finding.evidence_dir)}/${e(name)}</code>`).join('<br>')}</p>
<h3>Status history</h3><ul>${finding.history.map((event) => `<li>${e(event.at.slice(0, 19).replace('T', ' '))} UTC · ${e(STATUS_LABEL[event.status])}${event.sha ? ` · build <code>${e(short(event.sha))}</code>` : ''} · ${e(event.note)}</li>`).join('')}</ul>
</section>`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

interface EgressSummary { allowed_destinations: string[]; connections_made_by_application: Record<string, number>; refused_attempts: Record<string, number>; refused_attempts_that_were_self_tests: Record<string, number>; unexpected_external_attempts: unknown[]; sink: { receipts: number; declared_by_tests: number; unintended: number; missing: number }; conclusion: string }

function fullHtml(model: Model, f: Facts): string {
  const { manifest, summary } = model;
  const dir = evidenceDir(model.run_id);
  const matrixFile = path.join(dir, 'role-matrix.csv');
  const matrix = fs.existsSync(matrixFile) ? parseCsv(fs.readFileSync(matrixFile, 'utf8')) : [];
  const failedRows = matrix.slice(1).filter((row) => row[7] === 'FAIL');
  const egress = readJson<EgressSummary>(path.join(dir, 'containment', 'egress-summary.json'));
  const retest = model.retest;
  return `${summaryHtml(model, f)}
<div class="pagebreak"></div>

<h2>1. Build and environment under review</h2>
<p>Every finding in this report refers to this manifest (<code>evidence/${e(model.run_id)}/manifest.json</code>). Results apply to this build, seed and configuration only.</p>
${kv([
  ['Run', `${e(model.run_id)} (${e(summary.kind)}${summary.baseline_run_id ? ` of ${e(summary.baseline_run_id)}` : ''})`],
  ['Timestamp', e(manifest.timestamp)],
  ['Environment', `${e(manifest.environment_name)} (${e(manifest.target_mode)})`],
  ['Target base URL', `<code>${e(manifest.target_base_url)}</code>`],
  ['API base URL', `<code>${e(manifest.api_base_url)}</code>`],
  ['Git SHA', `<code>${e(manifest.git_sha)}</code> (build reported by the application: <code>${e(short(manifest.application.reported_build_sha))}</code>)`],
  ['Docker image', e(manifest.docker_image.digest ?? manifest.docker_image.id ?? 'none') + (manifest.docker_image.note ? `<br><span class="sub">${e(manifest.docker_image.note)}</span>` : '')],
  ['Application version', e(manifest.application.version)],
  ['Node / Playwright', `${e(manifest.node_version)} / ${e(manifest.playwright_version)}`],
  ['Browsers', e(Object.entries(manifest.browsers ?? {}).map(([project, browser]) => `${project}: ${browser.name} ${browser.version}`).join('; ') || 'none recorded')],
  ['Seed', `${e(manifest.seed.version)} · <code>${e(manifest.seed.hash)}</code>`],
  ['Feature flags', e(Object.entries(manifest.feature_flags).map(([name, on]) => `${name}=${on ? 'ON' : 'OFF'}`).join(', '))],
  ['Tenants', e(manifest.tenants.map((tenant) => `${tenant.key} (id ${tenant.id}, ${tenant.slug})`).join('; '))],
  ['Role accounts', `${manifest.role_accounts.length} fictional accounts across ${manifest.tenants.length} tenants (listed in the manifest)`],
  ['Configuration checksum', `<code>${e(manifest.configuration_checksum.value)}</code>`],
  ['Harness', `<code>${e(manifest.harness_git_sha)}</code>`],
])}

<h2>2. Stages</h2>
<div class="scroll"><table><thead><tr><th>Stage</th><th>Purpose</th><th>Tests passed</th><th>Tests failed</th><th>Checks</th><th>Result</th></tr></thead><tbody>
${summary.stages.map((stage) => `<tr><td>${e(stage.id)}</td><td>${e(stage.purpose)}</td><td>${stage.executed ? stage.tests.passed : '–'}</td><td>${stage.executed ? stage.tests.failed : '–'}</td><td>${stage.executed ? `${stage.checks.passed} passed, ${stage.checks.failed} failed` : '–'}</td><td>${!stage.executed ? '<span class="res NOT">NOT RUN</span>' : stage.tests.failed || stage.checks.failed ? '<span class="res FAIL">FAIL</span>' : '<span class="res PASS">PASS</span>'}</td></tr>`).join('\n')}
<tr><td>09-report</td><td>Evidence collation, finding records and the release report.</td><td colspan="3">This document and the files beside it</td><td><span class="res PASS">DONE</span></td></tr>
</tbody></table></div>
<p class="sub">A test contains many checks. A check is one expected-versus-actual comparison; every failing check is attached to a finding.</p>
<p>Rules tested for every role: ${GLOBAL_RULES.map((rule) => `${e(rule.rule)} <span class="sub">(${e(rule.stage)})</span>`).join(' ')}</p>

<h2>3. Findings</h2>
${model.findings.length ? model.findings.map((finding) => findingHtml(model, finding)).join('\n') : '<p>No findings were recorded in this run.</p>'}

<h2>4. Role matrix</h2>
<p>${summary.role_matrix.rows} role-and-operation combinations were exercised through the UI and directly against the API; ${summary.role_matrix.failed} did not match the intended permission model. The full matrix is in <code>reports/role-matrix.csv</code>.</p>
${failedRows.length ? `<div class="scroll"><table><thead><tr>${matrix[0].map((head) => `<th>${e(head)}</th>`).join('')}</tr></thead><tbody>${failedRows.map((row) => `<tr>${row.map((cell) => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}

<h2>5. Containment</h2>
${
  egress
    ? `<p>${e(egress.conclusion)}</p>${kv([
        ['Allowed destinations', e(egress.allowed_destinations.join(', ') || 'loopback only')],
        ['Connections made by the application', e(Object.entries(egress.connections_made_by_application).map(([host, count]) => `${host} ×${count}`).join(', ') || 'none')],
        ['Attempts refused by a guard', e(Object.entries(egress.refused_attempts).map(([name, count]) => `${name}: ${count}`).join(', '))],
        ['Of which deliberate self-tests', e(Object.entries(egress.refused_attempts_that_were_self_tests).map(([name, count]) => `${name}: ${count}`).join(', '))],
        ['Unexpected external attempts', String(egress.unexpected_external_attempts.length)],
        ['Outbound sink', `${egress.sink.receipts} events captured; ${egress.sink.declared_by_tests} declared by tests; ${egress.sink.unintended} unintended; ${egress.sink.missing} missing`],
      ])}`
    : '<p>The whole-run containment assertion was not executed in this run.</p>'
}

<h2>6. Retest</h2>
${
  retest
    ? `<p>${e(f.retestLine)} Original evidence in <code>evidence/${e(retest.baseline_run)}/</code> ${retest.original_evidence.intact ? `is unchanged (${retest.original_evidence.files_verified} files verified against their checksums)` : `<strong>has changed since it was sealed</strong>: ${e(retest.original_evidence.mismatches.join('; '))}`}.</p>
<p>Regression: ${retest.regression.checks_passed} checks passed and ${retest.regression.checks_failed} failed across the whole retest run; ${retest.regression.outside_original_findings_failed} failure(s) outside the original findings${retest.new_findings.length ? ` (new: ${e(retest.new_findings.join(', '))})` : ''}.</p>`
    : `<p>${e(f.retestLine)}</p>`
}

<h2>7. Severity scale</h2>
<table><tbody>${SEVERITIES.map((severity) => `<tr><td>${tag(severity)}</td><td>${e(SEVERITY_RUBRIC[severity])}</td></tr>`).join('')}</tbody></table>

<h2>8. Limits of this review</h2>
<ul>
<li>Results describe the build, seed and configuration in the manifest. A different build needs a new run.</li>
<li>The review tests behaviour from outside the application, with database and log access. It is not a source-code audit, a penetration test of infrastructure, or a load test.</li>
<li>A passing check shows the control held for the cases exercised. It does not prove the absence of every defect.</li>
<li>The target is a fictional stand-in. Running this method against a real system requires the access and information listed in <code>docs/CLIENT_ONBOARDING.md</code>.</li>
</ul>
${footer(model)}`;
}

// ---- Markdown --------------------------------------------------------------

const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mdTable = (head: string[], rows: unknown[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`)].join('\n');

function fullMarkdown(model: Model, f: Facts): string {
  const { manifest, summary } = model;
  const out: string[] = [];
  out.push(`# ${summary.kind === 'retest' ? 'Retest report' : 'Release review'}: ${manifest.application.name} ${manifest.application.version}, build ${short(manifest.git_sha)}`, '');
  out.push(`Run ${model.run_id}, reviewed ${date(manifest.timestamp)}. Demonstration against a fictional application with synthetic data.`, '');
  out.push(`**${f.verdict.headline}.** ${f.verdict.detail}`, '');
  out.push('## Summary', '');
  out.push(mdTable(['Item', 'Value'], [
    ['Candidate', `${manifest.application.name} ${manifest.application.version}`],
    ['Source SHA', `\`${manifest.git_sha}\``],
    ['Image digest', f.image],
    ['Review date', date(manifest.timestamp)],
    ['Scope', f.scope],
    ['Stages executed', `${f.executed.length} of ${summary.stages.length}, plus reporting`],
    ['Tests', `${summary.tests.passed} passed, ${summary.tests.failed} failed (${summary.checks.passed + summary.checks.failed} checks)`],
    ['Release-blocking findings', f.blocking.length ? `${f.blocking.length} open (${f.blocking.map((finding) => finding.id).join(', ')})` : 'None open'],
    ['Retest status', f.retestLine],
  ]), '');
  out.push('### Results by control', '', mdTable(['Control', 'Result', 'Detail'], f.controls.map((control) => [control.label, control.result, control.detail])), '');
  out.push('### Findings by severity', '', mdTable(['Severity', 'Found', 'Open'], f.bySeverity.map((row) => [row.severity, row.total, row.open])), '', 'Severity is a five-level qualitative scale. It is not a CVSS score.', '');
  out.push('## Build and environment', '', mdTable(['Field', 'Value'], [
    ['Run', `${model.run_id} (${summary.kind}${summary.baseline_run_id ? ` of ${summary.baseline_run_id}` : ''})`],
    ['Timestamp', manifest.timestamp],
    ['Environment', `${manifest.environment_name} (${manifest.target_mode})`],
    ['Target base URL', manifest.target_base_url],
    ['API base URL', manifest.api_base_url],
    ['Git SHA', manifest.git_sha],
    ['Docker image', `${manifest.docker_image.digest ?? manifest.docker_image.id ?? 'none'}${manifest.docker_image.note ? ` (${manifest.docker_image.note})` : ''}`],
    ['Application version', manifest.application.version],
    ['Node / Playwright', `${manifest.node_version} / ${manifest.playwright_version}`],
    ['Browsers', Object.entries(manifest.browsers ?? {}).map(([project, browser]) => `${project}: ${browser.name} ${browser.version}`).join('; ')],
    ['Seed', `${manifest.seed.version} ${manifest.seed.hash}`],
    ['Feature flags', Object.entries(manifest.feature_flags).map(([name, on]) => `${name}=${on ? 'ON' : 'OFF'}`).join(', ')],
    ['Tenants', manifest.tenants.map((tenant) => `${tenant.key} (id ${tenant.id})`).join('; ')],
    ['Role accounts', `${manifest.role_accounts.length} fictional accounts (see manifest)`],
    ['Configuration checksum', manifest.configuration_checksum.value],
  ]), '');
  out.push('## Stages', '', mdTable(['Stage', 'Tests passed', 'Tests failed', 'Checks passed', 'Checks failed', 'Result'], summary.stages.map((stage) => [stage.id, stage.executed ? stage.tests.passed : '-', stage.executed ? stage.tests.failed : '-', stage.executed ? stage.checks.passed : '-', stage.executed ? stage.checks.failed : '-', !stage.executed ? 'NOT RUN' : stage.tests.failed || stage.checks.failed ? 'FAIL' : 'PASS'])), '');
  out.push('## Findings', '');
  if (!model.findings.length) out.push('No findings were recorded in this run.', '');
  for (const finding of model.findings) {
    out.push(`### ${finding.id}: ${finding.title}`, '');
    out.push(mdTable(['Field', 'Value'], [
      ['Severity', finding.severity],
      ['Status', STATUS_LABEL[finding.status]],
      ['Category', finding.category],
      ['Affected roles', finding.affected_roles.join(', ') || 'not role-specific'],
      ['Affected tenants', finding.affected_tenants.join(', ') || 'all'],
      ['Affected route or job', finding.affected_route_or_job],
      ['Build', finding.build.git_sha],
      ['First seen', `${finding.first_seen_run} (${short(finding.first_seen_sha)})`],
      ['Retest', finding.retest_run ? `${finding.retest_run} (${short(finding.retest_sha)}): ${STATUS_LABEL[finding.retest_status!]}` : 'Not retested'],
      ['Detected by', `${finding.detection.stage}, ${finding.detection.failing_checks} of ${finding.detection.checks_under_key} checks failed`],
      ['Evidence', `${finding.evidence_dir}/`],
    ]), '');
    out.push('**Preconditions**', '', ...finding.preconditions.map((item) => `- ${item}`), '');
    out.push('**Reproduction**', '', ...finding.reproduction_steps.map((item, index) => `${index + 1}. ${item}`), '');
    out.push(`**Expected:** ${finding.expected_result}`, '', `**Actual:** ${finding.actual_result}`, '');
    out.push(`**Security impact:** ${finding.security_impact}`, '', `**Business impact:** ${finding.business_impact}`, '');
    out.push(`**Evidence files:** ${['finding.json', finding.request_evidence, finding.response_evidence, ...finding.supporting_artifacts].filter(Boolean).join(', ')}`, '');
  }
  out.push('## Role matrix', '', `${summary.role_matrix.rows} role-and-operation combinations exercised; ${summary.role_matrix.failed} did not match the intended permission model. Full matrix: \`reports/role-matrix.csv\`.`, '');
  out.push('## Retest', '', f.retestLine, '');
  if (summary.harness_errors.length) out.push('## Tests that failed without a finding', '', ...summary.harness_errors.map((error) => `- ${error.stage} ${error.test}: ${error.message.split('\n')[0]}`), '');
  out.push('## Limits of this review', '', '- Results describe the build, seed and configuration in the manifest only.', '- This is behavioural testing from outside the application with database and log access. It is not a source-code audit, infrastructure penetration test or load test.', '- A passing check shows the control held for the cases exercised.', '- The target is a fictional stand-in; see docs/CLIENT_ONBOARDING.md for what a real engagement needs.', '');
  return out.join('\n');
}

function retestMarkdown(model: Model, f: Facts): string {
  const out = ['# Retest summary', ''];
  const retest = model.retest;
  if (!retest) {
    out.push(`Run ${model.run_id} is an initial review of build ${short(model.manifest.git_sha)}.`, '', f.retestLine, '');
    const claims = model.cycle?.fix_claims ?? [];
    if (claims.length) out.push('Fixes claimed so far:', '', ...claims.map((claim) => `- ${claim.at.slice(0, 19)}Z build \`${short(claim.sha)}\` for ${claim.findings.join(', ')} (${claim.note})`), '', 'Run `npm run review:retest` to test the claimed build.', '');
    if (model.findings.length) out.push(mdTable(['ID', 'Severity', 'Finding', 'Status'], model.findings.map((finding) => [finding.id, finding.severity, finding.title, STATUS_LABEL[finding.status]])), '');
    return out.join('\n');
  }
  out.push(mdTable(['Item', 'Value'], [
    ['Original run', `${retest.baseline_run} on build \`${retest.baseline_sha}\``],
    ['Retest run', `${retest.retest_run} on build \`${retest.retest_sha}\``],
    ['Fix claim', retest.fix_claim ? `${retest.fix_claim.at.slice(0, 19)}Z: ${retest.fix_claim.note}` : 'None recorded for this build'],
    ['Original evidence', retest.original_evidence.intact ? `Unchanged (${retest.original_evidence.files_verified} files verified against checksums)` : `CHANGED: ${retest.original_evidence.mismatches.join('; ')}`],
    ['Whole-run regression', `${retest.regression.checks_passed} checks passed, ${retest.regression.checks_failed} failed; ${retest.regression.outside_original_findings_failed} failure(s) outside the original findings`],
    ['New findings in retest', retest.new_findings.join(', ') || 'None'],
  ]), '');
  out.push('## Result per original finding', '', mdTable(['ID', 'Severity', 'Finding', 'Before', 'Retest result', 'Originally failing checks', 'Now passing', 'Adjacent checks'], retest.records.map((record) => [record.finding_id, record.severity, record.title, STATUS_LABEL[record.status_before], record.retest_status ? record.retest_status : 'NOT RETESTED', record.originally_failing_checks, record.now_passing, `${record.adjacent_regression.checks_passed} passed, ${record.adjacent_regression.checks_failed} failed`])), '');
  for (const record of retest.records) {
    out.push(`### ${record.finding_id}: ${record.title}`, '', record.outcome, '');
    out.push(`- Original evidence: \`evidence/${record.original_run}/${record.finding_id}/\` (build \`${short(record.original_sha)}\`)`, `- Retest evidence: \`evidence/${record.retest_run}/retest/${record.finding_id}/retest.json\` (build \`${short(record.retest_sha)}\`)`, '');
    if (record.sample_checks.length) out.push(mdTable(['Check', 'Original build', 'Retested build'], record.sample_checks.map((check) => [check.label, check.original_actual, check.retest_actual])), '');
  }
  return out.join('\n');
}

export function render(model: Model): Record<string, string> {
  const f = facts(model);
  const title = `${model.manifest.application.name} ${short(model.manifest.git_sha)} review ${model.run_id}`;
  return {
    'executive-summary.html': doc(`Executive summary · ${title}`, `${summaryHtml(model, f)}\n${footer(model)}`),
    'report.html': doc(`Review report · ${title}`, fullHtml(model, f)),
    'full-review.md': fullMarkdown(model, f),
    'findings.json': JSON.stringify({ run_id: model.run_id, generated_at: model.generated_at, manifest: `evidence/${model.run_id}/manifest.json`, release_blocking_open: f.blocking.map((finding) => finding.id), findings: model.findings }, null, 2) + '\n',
    'retest-summary.md': retestMarkdown(model, f),
  };
}
