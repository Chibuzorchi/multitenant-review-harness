import type { APIRequestContext } from '@playwright/test';

/** Thin, target-neutral HTTP layer. Every exchange is returned in a form that is safe to store as evidence. */

export interface ApiCall {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE' | 'HEAD';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Exchange {
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown; truncated: boolean };
  at: string;
  /** Parsed JSON body, or null when the response is not JSON. */
  json: unknown;
  /** Raw response text (not stored in evidence; use for assertions). */
  text: string;
  status: number;
}

export interface ApiAdapter {
  call(request: APIRequestContext, call: ApiCall): Promise<Exchange>;
  /** Machine-readable error code of a failed response, if the target has one. */
  errorCode(exchange: Exchange): string | null;
  /** How the target expresses a decision in HTTP terms. */
  classify(status: number): 'allowed' | 'denied' | 'error';
}
