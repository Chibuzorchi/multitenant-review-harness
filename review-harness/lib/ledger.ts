import type { FindingStatus, Severity } from './catalogue';
import { readJson, runPaths, writeJson } from './run';

/**
 * The finding ledger: the one mutable record in the evidence store. It tracks
 * each finding's status across runs. Run folders themselves are sealed and are
 * never rewritten; a status change is a new line of history here plus new
 * evidence in the run that justified it.
 */

export interface StatusEvent {
  at: string;
  status: FindingStatus;
  run_id: string | null;
  sha: string | null;
  note: string;
}

export interface LedgerFinding {
  id: string;
  key: string;
  title: string;
  severity: Severity;
  category: string;
  stage: string;
  first_seen_run: string;
  first_seen_sha: string;
  status: FindingStatus;
  retest_run: string | null;
  retest_sha: string | null;
  retest_status: FindingStatus | null;
  history: StatusEvent[];
}

export interface FixClaim {
  at: string;
  sha: string;
  ref: string | null;
  findings: string[];
  note: string;
}

/** One review cycle: an initial run, the fixes claimed against it and the retests of those fixes. */
export interface Cycle {
  baseline_run: string;
  baseline_sha: string;
  findings: LedgerFinding[];
  fix_claims: FixClaim[];
  retests: Array<{ run_id: string; sha: string; at: string }>;
}

export interface Ledger {
  latest_cycle: string | null;
  cycles: Record<string, Cycle>;
}

export function readLedger(): Ledger {
  return readJson<Ledger>(runPaths.ledger()) ?? { latest_cycle: null, cycles: {} };
}

export function writeLedger(ledger: Ledger): void {
  writeJson(runPaths.ledger(), ledger);
}

export function latestCycle(ledger = readLedger()): Cycle | null {
  return ledger.latest_cycle ? (ledger.cycles[ledger.latest_cycle] ?? null) : null;
}

export function setStatus(finding: LedgerFinding, event: StatusEvent): void {
  finding.status = event.status;
  finding.history.push(event);
}
