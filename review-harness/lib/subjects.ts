import type { Target } from '../../adapters';
import { ROLES, TENANTS, account, otherRep, spareRep, tenantSlug, type Account, type Role } from '../../config/roles';
import type { Attacker, Subjects, Victim } from '../../config/routes';
import { environment } from '../../config/environment';

/**
 * Resolves the concrete records each test acts on from the target's data.
 * Nothing here is hard-coded to an identifier: the harness discovers "own",
 * "other rep" and "other tenant" records from the system of record.
 */

const cache = new Map<string, unknown>();
function memo<T>(key: string, build: () => T): T {
  if (!cache.has(key)) cache.set(key, build());
  return cache.get(key) as T;
}

function need<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`Baseline data is missing: ${what}`);
  return value;
}

export function tenantId(target: Target, tenantKey: string): number {
  return memo(`tenant:${tenantKey}`, () => need(target.database.tenants().find((t) => t.slug === tenantSlug(tenantKey)), `tenant ${tenantSlug(tenantKey)}`).id);
}

export function userId(target: Target, who: Account): number {
  return memo(`user:${who.email}`, () => need(target.database.userByEmail(who.email), `user ${who.email}`).id);
}

export function subjectsFor(target: Target, tenantKey: string, role: Role): Subjects {
  return memo(`subjects:${tenantKey}:${role}`, () => {
    const db = target.database;
    const tid = tenantId(target, tenantKey);
    const actor = need(db.userByEmail(account(tenantKey, role).email), `account for ${role}`);
    const subject = userId(target, account(tenantKey, 'rep'));
    const other = userId(target, otherRep(tenantKey));
    const spare = userId(target, spareRep(tenantKey));
    const sources = db.sources(tid);
    const activities = db.activities(tid);
    const referrals = db.referrals(tid);
    const admitted = new Set(db.admissions(tid).map((a) => a.referral_id));
    const otherSource = need(sources.find((s) => s.owner_rep_id === other), 'a referral source owned by the other rep');
    // Each role that may record admissions gets its own accepted, not-yet-admitted referral.
    const admittable = referrals.filter((r) => r.status === 'accepted' && !admitted.has(r.id));
    return {
      tenantId: tid,
      actor: { id: actor.id, email: actor.email },
      subjectRep: { id: subject },
      otherRep: { id: other },
      spareRep: { id: spare },
      ownSourceId: need(sources.find((s) => s.owner_rep_id === subject), 'a referral source owned by the subject rep').id,
      otherSourceId: otherSource.id,
      otherSourceName: otherSource.business_name,
      ownActivityId: need(activities.find((a) => a.rep_id === subject), 'an activity by the subject rep').id,
      otherActivityId: need(activities.find((a) => a.rep_id === other), 'an activity by the other rep').id,
      assignedReferralId: need(referrals.find((r) => r.assigned_rep_id === subject && r.status === 'received') ?? referrals.find((r) => r.assigned_rep_id === subject), 'a referral assigned to the subject rep').id,
      otherReferralId: need(referrals.find((r) => r.assigned_rep_id === other), 'a referral assigned to the other rep').id,
      admittableReferralId: need(admittable[ROLES.indexOf(role)], 'an accepted referral without an admission').id,
      unique: `${role.replace(/_/g, '-')}-${environment.run.id.toLowerCase()}`,
    };
  });
}

export function victimOf(target: Target, tenantKey: string): Victim {
  return memo(`victim:${tenantKey}`, () => {
    const db = target.database;
    const tid = tenantId(target, tenantKey);
    const sources = db.sources(tid);
    const activities = db.activities(tid);
    const referrals = db.referrals(tid);
    const admissions = db.admissions(tid);
    const admitted = new Set(admissions.map((a) => a.referral_id));
    // Business names are not unique across tenants. The victim source must have a name no other tenant uses,
    // otherwise a correct response containing the attacker's own same-named source would look like a leak.
    const elsewhere = new Set(db.tenants().filter((tenant) => tenant.id !== tid).flatMap((tenant) => db.sources(tenant.id).map((s) => s.business_name)));
    // A source with both activities and referrals, so list and filter probes have something to leak.
    const source = need(
      sources.find((s) => !elsewhere.has(s.business_name) && activities.some((a) => a.referral_source_id === s.id) && referrals.some((r) => r.referral_source_id === s.id)),
      `a source with activities and referrals in tenant ${tenantKey}`,
    );
    const user = need(db.userByEmail(spareRep(tenantKey).email), 'victim spare rep');
    return {
      tenantId: tid,
      sourceId: source.id,
      sourceName: source.business_name,
      sourceIds: sources.map((s) => s.id),
      repId: source.owner_rep_id,
      activityId: need(activities.find((a) => a.referral_source_id === source.id), 'victim activity').id,
      referralId: need(referrals.find((r) => r.referral_source_id === source.id), 'victim referral').id,
      acceptedReferralId: need(referrals.find((r) => r.status === 'accepted' && !admitted.has(r.id)), 'victim accepted referral').id,
      admissionId: need(admissions[0], 'victim admission').id,
      userId: user.id,
      userEmail: user.email,
    };
  });
}

export function attackerOf(target: Target, tenantKey: string): Attacker {
  const s = subjectsFor(target, tenantKey, 'rep');
  return { tenantId: s.tenantId, ownSourceId: s.ownSourceId };
}

export const tenantKeys = (): string[] => TENANTS.map((t) => t.key);
