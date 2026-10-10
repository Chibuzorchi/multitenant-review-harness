import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RELEASE_BLOCKING, SEVERITIES, STAGES, type FindingStatus, type Severity } from '../lib/catalogue';
import type { CheckRecord } from '../lib/fixtures';
import { readLedger, type Cycle, type LedgerFinding } from '../lib/ledger';
import type { Manifest } from '../lib/manifest';
import { readJson, readJsonl, runPaths } from '../lib/run';

/** Shapes of the sealed evidence files, and the view of them a report is rendered from. */

export interface Finding {
  id: string;
  key: string;
  title: string;
  severity: Severity;
  status: FindingStatus;
  category: string;
  affected_roles: string[];
  affected_tenants: string[];
  affected_route_or_job: string;
  build: { git_sha: string; application: string; version: string; image: string | null };
  run_id: string;
  manifest: string;
  detection: { stage: string; failing_checks: number; checks_under_key: number; signals: string[] };
  preconditions: string[];
  reproduction_steps: string[];
  expected_result: string;
  actual_result: string;
  security_impact: string;
  business_impact: string;
  request_evidence: string | null;
  response_evidence: string | null;
  supporting_artifacts: string[];
  first_seen_run: string;
  first_seen_sha: string;
  retest_run: string | null;
  retest_sha: string | null;
  retest_status: FindingStatus | null;
}

export interface StageSummary {
  id: string;
  title: string;
  purpose: string;
  executed: boolean;
  tests: { passed: number; failed: number; skipped: number };
  checks: { passed: number; failed: number };
  duration_ms: number;
}

export interface RunSummary {
  run_id: string;
  kind: 'initial' | 'retest';
  baseline_run_id: string | null;
  git_sha: string;
  collated_at: string;
  stages: StageSummary[];
  tests: { passed: number; failed: number; skipped: number };
  checks: { passed: number; failed: number };
  findings: string[];
  /** Tests that failed for a reason other than a recorded check: a harness or environment problem, not a finding. */
  harness_errors: Array<{ stage: string; test: string; message: string }>;
  role_matrix: { rows: number; failed: number };
}

export interface RetestRecord {
  finding_id: string;
  key: string;
  title: string;
  severity: Severity;
  original_run: string;
  original_sha: string;
  original_evidence: string;
  retest_run: string;
  retest_sha: string;
  manifest: string;
  status_before: FindingStatus;
  retest_status: FindingStatus | null;
  outcome: string;
  originally_failing_checks: number;
  reexecuted: number;
  now_passing: number;
  now_failing: number;
  sample_checks: Array<{ label: string; route: string; expected: string; original_actual: string; retest_actual: string; ok: boolean; response_status: number | null }>;
  adjacent_regression: { stage: string; checks_passed: number; checks_failed: number; failed_keys: string[] };
}

export interface RetestSummary {
  retest_run: string;
  retest_sha: string;
  baseline_run: string;
  baseline_sha: string;
  fix_claim: { sha: string; at: string; note: string } | null;
  original_evidence: { intact: boolean; files_verified: number; mismatches: string[] };
  records: RetestRecord[];
  new_findings: string[];
  regression: { checks_passed: number; checks_failed: number; outside_original_findings_failed: number };
}

export interface FindingView extends Finding {
  /** Folder holding the sealed evidence, relative to the repository root. */
  evidence_dir: string;
  history: LedgerFinding['history'];
}

export interface Model {
  run_id: string;
  manifest: Manifest;
  summary: RunSummary;
  findings: FindingView[];
  cycle: Cycle | null;
  baseline: { manifest: Manifest; summary: RunSummary } | null;
  retest: RetestSummary | null;
  sealed: boolean;
  generated_at: string;
}

export const evidenceDir = (runId: string) => runPaths.evidence(runId);
export const isSealed = (runId: string) => fs.existsSync(path.join(evidenceDir(runId), 'checksums.sha256'));
export const sha256 = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const stageIndex = (id: string) => STAGES.findIndex((stage) => stage.id === id);
export const severityRank = (severity: Severity) => SEVERITIES.indexOf(severity);
export const isOpen = (status: FindingStatus) => status !== 'VERIFIED_FIXED';
export const blocksRelease = (finding: { severity: Severity; status: FindingStatus }) => isOpen(finding.status) && RELEASE_BLOCKING.includes(finding.severity);
export const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : 'n/a');

export function listFiles(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  }).sort();
}

export function sealedChecks(runId: string): CheckRecord[] {
  return readJsonl<CheckRecord>(path.join(evidenceDir(runId), 'checks.jsonl'));
}

/** Verify a sealed run folder against its checksum file. */
export function verifySeal(runId: string): { intact: boolean; files_verified: number; mismatches: string[] } {
  const dir = evidenceDir(runId);
  const file = path.join(dir, 'checksums.sha256');
  if (!fs.existsSync(file)) return { intact: false, files_verified: 0, mismatches: ['checksums.sha256 is missing'] };
  const mismatches: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const [hash, name] = [line.slice(0, 64), line.slice(66)];
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) mismatches.push(`${name}: missing`);
    else if (sha256(target) !== hash) mismatches.push(`${name}: content changed`);
  }
  const listed = new Set(lines.map((line) => line.slice(66)));
  for (const name of listFiles(dir)) if (name !== 'checksums.sha256' && !listed.has(name)) mismatches.push(`${name}: added after sealing`);
  return { intact: mismatches.length === 0, files_verified: lines.length, mismatches };
}

function readFinding(runId: string, id: string): Finding | null {
  return readJson<Finding>(path.join(evidenceDir(runId), id, 'finding.json'));
}

export function loadModel(runId: string): Model {
  const manifest = readJson<Manifest>(runPaths.manifest(runId));
  const summary = readJson<RunSummary>(path.join(evidenceDir(runId), 'run-summary.json'));
  if (!manifest || !summary) throw new Error(`Run ${runId} has no collated evidence.`);
  const ledger = readLedger();
  const cycleId = summary.kind === 'retest' ? summary.baseline_run_id : runId;
  const cycle = cycleId ? (ledger.cycles[cycleId] ?? null) : null;
  const root = path.resolve(runPaths.evidence(runId), '..', '..');

  // An initial run reports its own findings; a retest reports the whole cycle it belongs to.
  const entries = (cycle?.findings ?? []).filter((entry) => summary.kind === 'retest' || entry.first_seen_run === runId);
  const findings: FindingView[] = [];
  for (const entry of entries) {
    const sealed = readFinding(entry.first_seen_run, entry.id);
    if (!sealed) continue;
    // In the report for a run, show the state as of that run: later retests do not rewrite an earlier run's story.
    const asOf = summary.kind === 'retest' ? entry.history.filter((event) => !event.run_id || event.run_id <= runId) : entry.history;
    const retestEvent = [...asOf].reverse().find((event) => event.run_id && event.run_id !== entry.first_seen_run);
    findings.push({
      ...sealed,
      status: asOf.at(-1)?.status ?? sealed.status,
      retest_run: retestEvent?.run_id ?? null,
      retest_sha: retestEvent?.sha ?? null,
      retest_status: retestEvent?.status ?? null,
      evidence_dir: path.relative(root, path.join(evidenceDir(entry.first_seen_run), entry.id)),
      history: asOf,
    });
  }
  findings.sort((a, b) => a.id.localeCompare(b.id));

  const baselineId = summary.kind === 'retest' ? summary.baseline_run_id : null;
  const baselineManifest = baselineId ? readJson<Manifest>(runPaths.manifest(baselineId)) : null;
  const baselineSummary = baselineId ? readJson<RunSummary>(path.join(evidenceDir(baselineId), 'run-summary.json')) : null;
  return {
    run_id: runId,
    manifest,
    summary,
    findings,
    cycle,
    baseline: baselineManifest && baselineSummary ? { manifest: baselineManifest, summary: baselineSummary } : null,
    retest: readJson<RetestSummary>(path.join(evidenceDir(runId), 'retest', 'retest-summary.json')),
    sealed: isSealed(runId),
    generated_at: new Date().toISOString(),
  };
}
