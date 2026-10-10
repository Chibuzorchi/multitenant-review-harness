/** Operator actions an environment owner performs for the review: reset, flags, timing settings. */

export interface TargetHealth {
  status: string;
  application: string;
  version: string;
  buildSha: string;
  environment: string;
  seedVersion: string | null;
  seedHash: string | null;
}

export interface TimingSettings {
  sessionTtlSeconds: number;
  apiTokenTtlSeconds: number;
  jobLockTtlSeconds: number;
}

export interface ControlAdapter {
  health(): Promise<TargetHealth>;
  /** Restore the deterministic seed. Returns the seed version and hash. */
  reset(): Promise<{ seedVersion: string; seedHash: string }>;
  flag(name: string): Promise<boolean>;
  setFlag(name: string, enabled: boolean): Promise<void>;
  flags(): Promise<Record<string, boolean>>;
  settings(): Promise<TimingSettings>;
  setSettings(settings: Partial<TimingSettings>): Promise<TimingSettings>;
}
