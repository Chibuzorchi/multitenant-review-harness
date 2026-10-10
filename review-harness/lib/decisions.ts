import type { Target } from '../../adapters';
import type { ApiProbe, Subjects } from '../../config/routes';

export type Outcome = 'allowed' | 'denied' | 'error';

export interface Decision {
  outcome: Outcome;
  detail: string;
}

/**
 * What the server actually decided. A 2xx on its own is not proof of access:
 * where the catalogue supplies a predicate, the protected data has to be in
 * the response.
 */
export function decideApi(target: Target, probe: ApiProbe, status: number, json: unknown, subjects: Subjects): Decision {
  const outcome = target.api.classify(status);
  const code = (json as { error?: unknown } | null)?.error;
  const suffix = typeof code === 'string' ? ` ${code}` : '';
  if (outcome === 'allowed' && probe.proves && !probe.proves(json, subjects)) return { outcome: 'denied', detail: `HTTP ${status}, protected data absent` };
  return { outcome, detail: `HTTP ${status}${suffix}` };
}

export interface MatrixLine {
  role: string;
  operation: string;
  label: string;
  route: string;
  permission: string;
  expected: Outcome;
  surface: 'api' | 'ui' | 'browser-direct';
  result: Outcome;
  detail: string;
  ok: boolean;
}
