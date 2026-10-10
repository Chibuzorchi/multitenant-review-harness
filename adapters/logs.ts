/** Access to the target's logs, for attaching server-side context to findings. */

export interface AccessLogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  tenant_id: number | null;
  user_id: number | null;
  role: string | null;
}

export interface BlockedEgress {
  ts: string;
  kind: string;
  host: string;
  port: number | null;
  tag?: string;
}

export interface LogsAdapter {
  /** Request log entries between two ISO timestamps (inclusive). */
  access(from: string, to: string): AccessLogEntry[];
  /** Outbound connections the application attempted and its egress guard refused. */
  blockedEgress(): BlockedEgress[];
  /** Files to archive with the run: [label, absolute path]. */
  archive(): Array<[string, string]>;
}
