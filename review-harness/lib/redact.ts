import { environment } from '../../config/environment';

/**
 * Evidence hygiene. Nothing that can authenticate is allowed into evidence:
 * credential headers, cookies, passwords and tokens are replaced before any
 * exchange is stored, and stored text is scanned again before a run is sealed.
 */

export const REDACTED = '[REDACTED]';

const SECRET_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-ops-key', 'proxy-authorization', 'x-api-key']);
const SECRET_KEYS = /^(password|passwd|pass|token|access_token|refresh_token|secret|api_key|apikey|session|session_id|authorization|cookie|ops_key)$/i;

/** Patterns for credential material that could appear inside free text. Target token formats are added via REVIEW_SECRET_PATTERNS. */
export function secretPatterns(): RegExp[] {
  const literal = (value: string) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const patterns = [/\brd[st]_[a-f0-9]{16,}\b/g, /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/g];
  for (const secret of [environment.secrets.accountPassword, environment.secrets.operatorKey]) if (secret) patterns.push(literal(secret));
  for (const extra of (process.env.REVIEW_SECRET_PATTERNS ?? '').split('\n').filter(Boolean)) patterns.push(new RegExp(extra, 'g'));
  return patterns;
}

export function redactText(text: string): string {
  let out = text;
  for (const pattern of secretPatterns()) out = out.replace(pattern, REDACTED);
  return out;
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = SECRET_HEADERS.has(name.toLowerCase()) ? REDACTED : redactText(String(value));
  return out;
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value !== 'object' || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = SECRET_KEYS.test(key) ? REDACTED : redactValue(inner, depth + 1);
  return out;
}

/** Returns every secret-pattern hit in the text. Used to gate sealing of a run. */
export function findSecrets(text: string): string[] {
  const hits: string[] = [];
  for (const pattern of secretPatterns()) {
    const match = text.match(pattern);
    if (match) hits.push(`${pattern.source.slice(0, 24)} x${match.length}`);
  }
  return hits;
}
