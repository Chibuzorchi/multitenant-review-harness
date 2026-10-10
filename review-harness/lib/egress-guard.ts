import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { environment } from '../../config/environment';

/**
 * Egress guard for the harness processes themselves (orchestrator, Playwright
 * runner and workers, report generator). Any TCP connection or DNS lookup to a
 * host outside the allowlist is refused before it leaves the process and is
 * written to the run's egress log. Independent of the target's own guard.
 */

export interface HarnessEgressAttempt {
  ts: string;
  process: string;
  kind: 'connect' | 'dns';
  host: string;
  port: number | null;
  /** True for the deliberate self-tests that prove the guard is live. */
  selftest: boolean;
}

/** Reserved names (RFC 2606) used by self-tests. They can never resolve. */
export const SELFTEST_SUFFIX = '-egress-selftest.invalid';
export const isSelfTestHost = (host: string): boolean => host.toLowerCase().endsWith(SELFTEST_SUFFIX);

export function egressLogPath(name: 'harness' | 'browser'): string {
  return path.join(environment.run.workDir, environment.run.id, `${name}-egress.jsonl`);
}

export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return environment.allowedHosts.includes(h) || h === '0.0.0.0' || h === '::ffff:127.0.0.1';
}

export function logBlocked(name: 'harness' | 'browser', attempt: Omit<HarnessEgressAttempt, 'ts' | 'selftest'>): void {
  const file = egressLogPath(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...attempt, selftest: isSelfTestHost(attempt.host) }) + '\n');
}

function targetOf(args: unknown[]): { host: string; port: number | null } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'string') return null; // IPC path
  if (typeof first === 'number') return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  if (first && typeof first === 'object') {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return null;
    return { host: o.host ?? 'localhost', port: o.port === undefined ? null : Number(o.port) };
  }
  return null;
}

const INSTALLED = Symbol.for('review-harness.egress-guard');

export function installHarnessEgressGuard(processName: string): void {
  const flags = globalThis as unknown as Record<symbol, boolean>;
  if (flags[INSTALLED]) return;
  flags[INSTALLED] = true;

  const blockedError = (what: string) => Object.assign(new Error(`HARNESS_EGRESS_BLOCKED ${what}`), { code: 'HARNESS_EGRESS_BLOCKED' });

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args);
    if (target && !isAllowedHost(target.host)) {
      logBlocked('harness', { process: processName, kind: 'connect', ...target });
      process.nextTick(() => this.destroy(blockedError(`${target.host}:${target.port ?? ''}`)));
      return this;
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const originalLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    if (!isAllowedHost(hostname)) {
      logBlocked('harness', { process: processName, kind: 'dns', host: hostname, port: null });
      const cb = rest[rest.length - 1];
      if (typeof cb === 'function') process.nextTick(() => (cb as (e: Error) => void)(blockedError(`dns ${hostname}`)));
      return {};
    }
    return (originalLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
  };

  const originalPromiseLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = function guardedPromiseLookup(hostname: string, ...rest: unknown[]) {
    if (!isAllowedHost(hostname)) {
      logBlocked('harness', { process: processName, kind: 'dns', host: hostname, port: null });
      return Promise.reject(blockedError(`dns ${hostname}`));
    }
    return (originalPromiseLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
  };
}

export function readEgressLog(name: 'harness' | 'browser'): HarnessEgressAttempt[] {
  const file = egressLogPath(name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HarnessEgressAttempt);
}
