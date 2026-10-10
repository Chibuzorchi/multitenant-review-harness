import { environment } from '../../config/environment';
import type { EgressReport, OutboundAdapter, OutboundEvent } from '../outbound';
import { ops } from './ops';

interface OutboxRow { id: string; tenant_id: number | null; type: string; destination: string; payload: string; created_at: string; status: string; transport: string }
interface Receipt { event_id: string; tenant: number | null; type: string; destination: string; payload: unknown; timestamp: string }

export const outbound: OutboundAdapter = {
  types: ['email', 'sms', 'advertisement', 'charge', 'webhook'],
  async outbox() {
    const { rows } = await ops<{ rows: OutboxRow[] }>('GET', '/ops/outbound/events');
    return rows.map((row): OutboundEvent => ({ id: row.id, tenant: row.tenant_id, type: row.type, destination: row.destination, payload: JSON.parse(row.payload), timestamp: row.created_at, status: row.status, transport: row.transport }));
  },
  async received() {
    const res = await fetch(`${environment.sinkUrl}/receipts`);
    const { rows } = (await res.json()) as { rows: Receipt[] };
    return rows.map((row): OutboundEvent => ({ id: row.event_id, tenant: row.tenant, type: row.type, destination: row.destination, payload: row.payload, timestamp: row.timestamp, status: 'received' }));
  },
  async clearReceived() {
    await fetch(`${environment.sinkUrl}/receipts`, { method: 'DELETE' });
  },
  async egress() {
    const raw = await ops<{ blocked: EgressReport['blocked']; allowed: Record<string, number>; allow_hosts: string[] }>('GET', '/ops/egress');
    return { blocked: raw.blocked, allowed: raw.allowed, allowHosts: raw.allow_hosts };
  },
  async egressSelfTest() {
    const body = await ops<{ event_id: string; status: string }>('POST', '/ops/egress/selftest');
    return { eventId: body.event_id, status: body.status };
  },
};
