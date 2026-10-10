import { environment } from '../config/environment';
import type { ApiAdapter } from './api';
import type { AuthAdapter } from './auth';
import type { ControlAdapter } from './control';
import type { DatabaseAdapter } from './database';
import type { JobsAdapter } from './jobs';
import type { LogsAdapter } from './logs';
import type { OutboundAdapter } from './outbound';

/**
 * Everything the review stages know about the application under review.
 * Stages depend on these interfaces only; ReferralDesk is one implementation.
 */
export interface Target {
  name: string;
  auth: AuthAdapter;
  api: ApiAdapter;
  database: DatabaseAdapter;
  logs: LogsAdapter;
  jobs: JobsAdapter;
  outbound: OutboundAdapter;
  control: ControlAdapter;
}

const REGISTRY: Record<string, () => Target> = {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  referraldesk: () => (require('./referraldesk') as typeof import('./referraldesk')).referraldesk,
};

let cached: Target | null = null;

export function loadTarget(): Target {
  if (!cached) {
    const factory = REGISTRY[environment.adapter];
    if (!factory) throw new Error(`No adapter set registered for "${environment.adapter}". Register one in adapters/index.ts.`);
    cached = factory();
  }
  return cached;
}
