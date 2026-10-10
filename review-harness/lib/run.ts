import fs from 'node:fs';
import path from 'node:path';
import { environment } from '../../config/environment';

/** Locations of a run's working files (scratch) and evidence (kept). */

const work = (runId = environment.run.id) => path.join(environment.run.workDir, runId);

export const runPaths = {
  work,
  evidence: (runId = environment.run.id) => path.join(environment.run.evidenceRoot, runId),
  checks: (runId?: string) => path.join(work(runId), 'checks.jsonl'),
  matrix: (runId?: string) => path.join(work(runId), 'matrix.jsonl'),
  outboundLedger: (runId?: string) => path.join(work(runId), 'outbound-ledger.jsonl'),
  results: (runId?: string) => path.join(work(runId), 'results'),
  playwrightOutput: (runId?: string) => path.join(work(runId), 'pw'),
  stageLog: (runId?: string) => path.join(work(runId), 'stages.jsonl'),
  manifest: (runId?: string) => path.join(environment.run.evidenceRoot, runId ?? environment.run.id, 'manifest.json'),
  ledger: () => path.join(environment.run.evidenceRoot, 'ledger.json'),
};

export function appendJsonl(file: string, record: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
}

export function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

export function readJson<T>(file: string): T | null {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : null;
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
