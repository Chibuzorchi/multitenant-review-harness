/** Visibility of everything the target tried to send outside itself. */

export interface OutboundEvent {
  id: string;
  tenant: number | null;
  type: string;
  destination: string;
  payload: unknown;
  timestamp: string;
  status: string;
  /** Where the application actually delivered it. */
  transport?: string;
}

export interface EgressReport {
  blocked: Array<{ ts: string; kind: string; host: string; port: number | null; tag?: string }>;
  allowed: Record<string, number>;
  allowHosts: string[];
}

export interface OutboundAdapter {
  /** The application's own record of outbound events. */
  outbox(): Promise<OutboundEvent[]>;
  /** What the local sink actually received. */
  received(): Promise<OutboundEvent[]>;
  clearReceived(): Promise<void>;
  /** The application's egress guard report. */
  egress(): Promise<EgressReport>;
  /** Ask the application to attempt a non-local delivery, to prove the guard refuses it. */
  egressSelfTest(): Promise<{ eventId: string; status: string }>;
  /** Outbound types the sink is expected to capture. */
  readonly types: string[];
}
