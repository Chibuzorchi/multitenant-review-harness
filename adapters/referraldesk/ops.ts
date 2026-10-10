import { environment } from '../../config/environment';

/** Calls to the target's operator control plane. The operator key is sent as a header and never logged. */
export async function ops<T>(method: string, path: string, body?: unknown, base = environment.baseUrl): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-ops-key': environment.secrets.operatorKey },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Operator call ${method} ${path} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}
