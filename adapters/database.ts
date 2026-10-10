/**
 * Read-only access to the target's system of record, used to verify what the
 * application reports against what it stored. The harness never writes here.
 */

export interface TenantRow { id: number; slug: string; name: string }
export interface UserRow { id: number; tenant_id: number; email: string; name: string; role: string; active: number }
export interface SourceRow { id: number; tenant_id: number; business_name: string; business_type: string; address: string; owner_rep_id: number; status: string; updated_at: string }
export interface ActivityRow { id: number; tenant_id: number; referral_source_id: number; rep_id: number; activity_type: string; activity_date: string; notes: string; created_at: string }
export interface ReferralRow { id: number; tenant_id: number; referral_source_id: number; assigned_rep_id: number; status: string; received_at: string; updated_at: string; external_ref: string | null }
export interface AdmissionRow { id: number; tenant_id: number; referral_id: number; admitted_at: string; created_at: string }
export interface CredentialRow { id: string; user_id: number; kind: string; created_at: string; expires_at: string; revoked_at: string | null }
export interface JobRunRow { run_id: string; job_name: string; idempotency_key: string; status: string; attempt: number; scheduled_for: string | null; started_at: string; finished_at: string | null; error: string | null; records_written: number }
export interface QueueItemRow { id: number; tenant_id: number; status: string; result: string | null; enqueued_at: string; processed_at: string | null; run_id: string | null }
export interface ProjectionRow { id: number; tenant_id: number; queue_item_id: number | null; run_id: string | null; computed_at: string }
export interface DailyAggregateRow { tenant_id: number; date: string; activities: number; referrals: number; admissions: number; run_id: string }
export interface WeeklySnapshotRow { tenant_id: number; week_start: string; payload: string; run_id: string }
export interface OutboundRow { id: string; tenant_id: number | null; type: string; destination: string; payload: string; created_at: string; status: string; transport: string }

export interface DatabaseAdapter {
  tenants(): TenantRow[];
  users(tenantId?: number): UserRow[];
  userByEmail(email: string): UserRow | null;
  sources(tenantId: number): SourceRow[];
  activities(tenantId: number): ActivityRow[];
  referrals(tenantId: number): ReferralRow[];
  admissions(tenantId: number): AdmissionRow[];
  /** Credentials on record for a user. Secrets are never returned. */
  credentials(userId: number): CredentialRow[];
  patientCount(tenantId?: number): number;
  projectionQueue(): QueueItemRow[];
  projections(): ProjectionRow[];
  jobRuns(jobName?: string): JobRunRow[];
  dailyAggregates(date?: string): DailyAggregateRow[];
  weeklySnapshots(weekStart?: string): WeeklySnapshotRow[];
  inbox(): Array<{ id: number; tenant_id: number; external_ref: string; processed_at: string | null }>;
  outboundEvents(): OutboundRow[];
  /** Rows whose tenant differs from the tenant of the row they reference. Must always be empty. */
  crossTenantReferences(): Array<{ table: string; id: number; detail: string }>;
}
