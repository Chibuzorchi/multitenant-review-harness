import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../../config/environment';
import { readJson, runPaths, writeJson } from './run';

/** The run manifest: what was reviewed, with what, and in which state. Every finding refers back to it. */
export interface Manifest {
  run_id: string;
  run_kind: 'initial' | 'retest';
  baseline_run_id: string | null;
  timestamp: string;
  environment_name: string;
  target_base_url: string;
  api_base_url: string;
  outbound_sink_url: string;
  target_mode: string;
  git_sha: string;
  harness_git_sha: string | null;
  docker_image: { reference: string | null; id: string | null; digest: string | null; note: string | null };
  application: { name: string; version: string; reported_build_sha: string };
  node_version: string;
  playwright_version: string;
  browsers: Record<string, { name: string; version: string }>;
  seed: { version: string | null; hash: string | null };
  feature_flags: Record<string, boolean>;
  tenants: Array<{ key: string; id: number; slug: string }>;
  role_accounts: Array<{ tenant: string; role: string; account: string; purpose: string }>;
  configuration_checksum: { algorithm: 'sha256'; value: string; files: string[] };
}

/** One checksum over the configuration the run was driven by, so two runs can be shown to have tested the same rules. */
export function configurationChecksum(): Manifest['configuration_checksum'] {
  const dir = path.join(repoRoot, 'config');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();
  const hash = crypto.createHash('sha256');
  for (const name of files) hash.update(name).update('\0').update(fs.readFileSync(path.join(dir, name)));
  return { algorithm: 'sha256', value: hash.digest('hex'), files: files.map((name) => `config/${name}`) };
}

export function readManifest(runId?: string): Manifest | null {
  return readJson<Manifest>(runPaths.manifest(runId));
}

export function updateManifest(patch: Partial<Manifest>): Manifest {
  const current = readManifest() ?? ({} as Manifest);
  const next = { ...current, ...patch, browsers: { ...(current.browsers ?? {}), ...(patch.browsers ?? {}) } } as Manifest;
  writeJson(runPaths.manifest(), next);
  return next;
}
