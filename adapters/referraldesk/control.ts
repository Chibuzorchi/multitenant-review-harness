import { environment } from '../../config/environment';
import type { ControlAdapter, TimingSettings } from '../control';
import { ops } from './ops';

interface RawSettings { session_ttl_seconds: number; api_token_ttl_seconds: number; job_lock_ttl_seconds: number }
const toSettings = (raw: RawSettings): TimingSettings => ({ sessionTtlSeconds: raw.session_ttl_seconds, apiTokenTtlSeconds: raw.api_token_ttl_seconds, jobLockTtlSeconds: raw.job_lock_ttl_seconds });

export const control: ControlAdapter = {
  async health() {
    const res = await fetch(`${environment.baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, string | null>;
    return { status: String(body.status), application: String(body.application), version: String(body.version), buildSha: String(body.build_sha), environment: String(body.environment), seedVersion: body.seed_version, seedHash: body.seed_hash };
  },
  async reset() {
    const body = await ops<{ seed_version: string; seed_hash: string }>('POST', '/ops/reset');
    return { seedVersion: body.seed_version, seedHash: body.seed_hash };
  },
  async flags() {
    return ops<Record<string, boolean>>('GET', '/ops/feature-flags');
  },
  async flag(name) {
    const all = await control.flags();
    if (!(name in all)) throw new Error(`Unknown feature flag ${name}`);
    return all[name];
  },
  async setFlag(name, enabled) {
    await ops('PUT', `/ops/feature-flags/${name}`, { enabled });
  },
  async settings() {
    return toSettings(await ops<RawSettings>('GET', '/ops/settings'));
  },
  async setSettings(settings) {
    return toSettings(
      await ops<RawSettings>('PUT', '/ops/settings', {
        session_ttl_seconds: settings.sessionTtlSeconds,
        api_token_ttl_seconds: settings.apiTokenTtlSeconds,
        job_lock_ttl_seconds: settings.jobLockTtlSeconds,
      }),
    );
  },
};
