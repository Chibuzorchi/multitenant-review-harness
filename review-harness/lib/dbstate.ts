import crypto from 'node:crypto';
import type { Target } from '../../adapters';

/**
 * A fingerprint of one tenant's records, read straight from the system of
 * record. Comparing two fingerprints shows whether a request that should have
 * been refused changed anything, whatever the response said.
 */

const digest = (rows: unknown[]) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);

export type Fingerprint = Record<string, string | number>;

export function tenantFingerprint(target: Target, tenantId: number): Fingerprint {
  const db = target.database;
  const sources = db.sources(tenantId);
  const activities = db.activities(tenantId);
  const referrals = db.referrals(tenantId);
  const admissions = db.admissions(tenantId);
  const users = db.users(tenantId);
  return {
    referral_sources: sources.length,
    referral_source_state: digest(sources.map((s) => [s.id, s.business_name, s.address, s.owner_rep_id, s.status])),
    activities: activities.length,
    activity_state: digest(activities.map((a) => [a.id, a.rep_id, a.referral_source_id, a.activity_type, a.activity_date])),
    referrals: referrals.length,
    referral_state: digest(referrals.map((r) => [r.id, r.status, r.assigned_rep_id, r.referral_source_id])),
    admissions: admissions.length,
    users: users.length,
    user_state: digest(users.map((u) => [u.id, u.email, u.name, u.role, u.active])),
    revoked_credentials: users.reduce((total, user) => total + db.credentials(user.id).filter((credential) => credential.revoked_at !== null).length, 0),
  };
}

/** Names of the fingerprint fields that differ. */
export function changedFields(before: Fingerprint, after: Fingerprint): string[] {
  return Object.keys(before).filter((field) => before[field] !== after[field]);
}
