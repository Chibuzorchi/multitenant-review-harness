import crypto from 'node:crypto';
import { config } from './config';
import { db, nowIso } from './db';

/**
 * Outbound dispatcher. Every external-style action (email, SMS, advertisement,
 * charge, webhook) is recorded in the outbox and delivered to the local sink.
 * The intended destination is kept as data; it is never contacted.
 */

export type OutboundType = 'email' | 'sms' | 'advertisement' | 'charge' | 'webhook';

export interface OutboundEvent {
  id: string;
  tenant_id: number | null;
  type: OutboundType;
  destination: string;
  payload: string;
  created_at: string;
  status: string;
  transport: string;
  dedupe_key: string | null;
}

export async function dispatch(input: {
  tenantId: number | null;
  type: OutboundType;
  destination: string;
  payload: unknown;
  dedupeKey?: string;
  transportUrl?: string;
}): Promise<OutboundEvent> {
  const d = db();
  if (input.dedupeKey) {
    const existing = d.prepare('SELECT * FROM outbound_events WHERE dedupe_key = ?').get(input.dedupeKey) as OutboundEvent | undefined;
    if (existing) return existing;
  }
  const id = `evt_${crypto.randomBytes(8).toString('hex')}`;
  const transport = input.transportUrl ?? `${config.sinkUrl}/capture`;
  const createdAt = nowIso();
  d.prepare(
    'INSERT INTO outbound_events (id, tenant_id, type, destination, payload, created_at, status, transport, dedupe_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.tenantId, input.type, input.destination, JSON.stringify(input.payload), createdAt, 'pending', transport, input.dedupeKey ?? null);

  let status = 'captured';
  try {
    const res = await fetch(transport, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        event_id: id,
        tenant: input.tenantId,
        type: input.type,
        destination: input.destination,
        payload: input.payload,
        timestamp: createdAt,
      }),
    });
    if (!res.ok) status = 'failed';
  } catch (err) {
    const text = `${(err as Error).message} ${String(((err as Error).cause as Error | undefined)?.message ?? '')}`;
    status = text.includes('EGRESS_BLOCKED') ? 'blocked' : 'failed';
  }
  d.prepare('UPDATE outbound_events SET status = ? WHERE id = ?').run(status, id);
  return d.prepare('SELECT * FROM outbound_events WHERE id = ?').get(id) as OutboundEvent;
}

export function tenantWebhook(tenantId: number): string {
  return (db().prepare('SELECT webhook_url FROM tenants WHERE id = ?').get(tenantId) as { webhook_url: string }).webhook_url;
}
