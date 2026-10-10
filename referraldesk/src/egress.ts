import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

/**
 * Process-wide egress guard. Every TCP connection and DNS lookup made by this
 * process is checked against an allowlist of local destinations. Anything else
 * is refused before a packet or DNS query is sent, and the attempt is logged.
 */

export interface EgressAttempt {
  ts: string;
  kind: 'connect' | 'dns';
  host: string;
  port: number | null;
  blocked: boolean;
  tag?: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::ffff:127.0.0.1']);
const blocked: EgressAttempt[] = [];
const allowedCounts = new Map<string, number>();
let allowHosts = new Set<string>();
let logFile: string | null = null;
let currentTag: string | undefined;
let installed = false;

export function isAllowedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return LOOPBACK.has(h) || allowHosts.has(h);
}

function record(attempt: EgressAttempt): void {
  if (attempt.blocked) {
    blocked.push(attempt);
    if (logFile) fs.appendFileSync(logFile, JSON.stringify(attempt) + '\n');
  } else {
    const key = `${attempt.host}:${attempt.port ?? ''}`;
    allowedCounts.set(key, (allowedCounts.get(key) ?? 0) + 1);
  }
}

function targetOf(args: unknown[]): { host: string; port: number | null } | null {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (typeof first === 'string') return null; // IPC path
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  }
  if (first && typeof first === 'object') {
    const o = first as { host?: string; port?: number | string; path?: string };
    if (o.path) return null;
    return { host: o.host ?? 'localhost', port: o.port === undefined ? null : Number(o.port) };
  }
  return null;
}

export function installEgressGuard(options: { allowHosts: string[]; logDir?: string }): void {
  allowHosts = new Set(options.allowHosts.map((h) => h.toLowerCase()));
  if (options.logDir) {
    fs.mkdirSync(options.logDir, { recursive: true });
    logFile = path.join(options.logDir, 'egress-blocked.jsonl');
  }
  if (installed) return;
  installed = true;

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args);
    if (target) {
      const ok = isAllowedHost(target.host);
      record({ ts: new Date().toISOString(), kind: 'connect', ...target, blocked: !ok, tag: currentTag });
      if (!ok) {
        const err = Object.assign(new Error(`EGRESS_BLOCKED ${target.host}:${target.port ?? ''}`), {
          code: 'EGRESS_BLOCKED',
        });
        process.nextTick(() => this.destroy(err));
        return this;
      }
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  const originalLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    if (!isAllowedHost(hostname)) {
      record({ ts: new Date().toISOString(), kind: 'dns', host: hostname, port: null, blocked: true, tag: currentTag });
      const cb = rest[rest.length - 1];
      const err = Object.assign(new Error(`EGRESS_BLOCKED dns ${hostname}`), { code: 'EGRESS_BLOCKED' });
      if (typeof cb === 'function') process.nextTick(() => (cb as (e: Error) => void)(err));
      return {};
    }
    return (originalLookup as (...a: unknown[]) => unknown)(hostname, ...rest);
  };
}

/** Runs fn with every attempt it makes labelled, so deliberate self-tests can be told apart. */
export async function withEgressTag<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  currentTag = tag;
  try {
    return await fn();
  } finally {
    currentTag = undefined;
  }
}

export function egressReport(): { blocked: EgressAttempt[]; allowed: Record<string, number>; allow_hosts: string[] } {
  return {
    blocked: [...blocked],
    allowed: Object.fromEntries(allowedCounts),
    allow_hosts: [...LOOPBACK, ...allowHosts],
  };
}
