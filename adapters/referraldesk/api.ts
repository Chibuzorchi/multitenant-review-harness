import type { APIRequestContext } from '@playwright/test';
import { redactHeaders, redactValue } from '../../review-harness/lib/redact';
import type { ApiAdapter, ApiCall, Exchange } from '../api';

const MAX_ROWS = 5;
const MAX_TEXT = 2000;

/** Keeps evidence small: long row lists are cut to a sample with the true count recorded. */
function compact(body: unknown): { body: unknown; truncated: boolean } {
  if (typeof body === 'string') return body.length > MAX_TEXT ? { body: `${body.slice(0, MAX_TEXT)}…`, truncated: true } : { body, truncated: false };
  const rows = (body as { rows?: unknown[] } | null)?.rows;
  if (Array.isArray(rows) && rows.length > MAX_ROWS) {
    return { body: { ...(body as object), rows: rows.slice(0, MAX_ROWS), _row_count: rows.length, _rows_shown: MAX_ROWS }, truncated: true };
  }
  return { body, truncated: false };
}

export const api: ApiAdapter = {
  async call(request: APIRequestContext, call: ApiCall): Promise<Exchange> {
    const at = new Date().toISOString();
    const headers = { accept: 'application/json', ...(call.headers ?? {}) };
    const response = await request.fetch(call.path, {
      method: call.method,
      headers,
      data: call.body === undefined ? undefined : (call.body as object),
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    const text = call.method === 'HEAD' ? '' : await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const compacted = compact(redactValue(json ?? text));
    return {
      at,
      status: response.status(),
      json,
      text,
      request: { method: call.method, url: response.url(), headers: redactHeaders(headers), body: redactValue(call.body ?? null) },
      response: { status: response.status(), headers: redactHeaders(response.headers()), body: compacted.body, truncated: compacted.truncated },
    };
  },
  errorCode(exchange) {
    const code = (exchange.json as { error?: unknown } | null)?.error;
    return typeof code === 'string' ? code : null;
  },
  classify(status) {
    if (status >= 200 && status < 300) return 'allowed';
    if (status === 401 || status === 403 || status === 404) return 'denied';
    return 'error';
  },
};
