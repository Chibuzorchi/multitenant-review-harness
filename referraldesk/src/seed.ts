import { config } from './config';
import { db, TABLES } from './db';
import { hashPassword, sha256 } from './security';

/**
 * Deterministic seed. All names, businesses and addresses are invented; the
 * "ZZ" state code, 00xxx postcodes and .example domains do not exist.
 */

export const SEED_VERSION = 'rd-seed-v1';
export const SEED_WINDOW = { start: '2026-07-01', end: '2026-09-30' };
const PRNG_SEED = 0x5eed2026;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TENANTS = [
  { slug: 'harbor-ridge', name: 'Harbor Ridge Care Partners' },
  { slug: 'juniper-valley', name: 'Juniper Valley Home Services' },
  { slug: 'lakeshore-meridian', name: 'Lakeshore Meridian Agency' },
];

const FIRST = ['Avery', 'Blake', 'Casey', 'Devon', 'Ellis', 'Finley', 'Gray', 'Harper', 'Indra', 'Jules', 'Kiran', 'Lane', 'Morgan', 'Noor', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum'];
const LAST = ['Ashdown', 'Brightwater', 'Calloway', 'Dunmore', 'Everhart', 'Fenwick', 'Greaves', 'Holloway', 'Ironwood', 'Jessop', 'Kestrel', 'Larkspur', 'Merriweather', 'Northcott', 'Oakhurst', 'Pennington', 'Quillfeather', 'Ravenscroft', 'Stonebridge', 'Thornbury'];
const PLACES = ['Marrowfield', 'Quillhaven', 'Thistlewick', 'Ospreyfen', 'Dunlarrow', 'Wexcombe', 'Hollowmere', 'Pellridge', 'Starling Gap', 'Brackenmoor', 'Calderwyn', 'Emberlea', 'Fallowby', 'Greystoke Fen', 'Ivelmouth', 'Kettering Vale'];
const STREETS = ['Lantern Row', 'Millrace Lane', 'Orchard Parade', 'Signal Hill Road', 'Copperleaf Way', 'Tidewater Court', 'Foxglove Terrace', 'Granary Street'];
const TYPES: Array<{ type: string; label: string }> = [
  { type: 'hospital', label: 'Regional Hospital' },
  { type: 'clinic', label: 'Family Clinic' },
  { type: 'facility', label: 'Skilled Care Facility' },
  { type: 'physician_office', label: 'Physician Group' },
  { type: 'community_organisation', label: 'Community Outreach Centre' },
];
const NOTES = [
  'Dropped off updated service brochure.',
  'Spoke with the discharge coordinator about turnaround times.',
  'Left voicemail for the office manager.',
  'Reviewed referral paperwork process with front desk.',
  'Scheduled a lunch-and-learn for next month.',
  'Follow-up on last week\'s introduction.',
  'Confirmed preferred contact method is phone.',
  'Discussed capacity for the coming fortnight.',
];

function dayString(base: string, offsetDays: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function stamp(date: string, hour: number, minute: number): string {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

export interface SeedResult {
  seed_version: string;
  seed_hash: string;
  window: typeof SEED_WINDOW;
  counts: Record<string, number>;
}

export function runSeed(): SeedResult {
  const d = db();
  const rand = mulberry32(PRNG_SEED);
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const windowDays = 92;

  const tx = d.transaction(() => {
    d.pragma('defer_foreign_keys = ON');
    for (const table of TABLES) d.exec(`DELETE FROM ${table}`);

    const insTenant = d.prepare('INSERT INTO tenants (id, slug, name, webhook_url) VALUES (?, ?, ?, ?)');
    const insUser = d.prepare('INSERT INTO users (tenant_id, email, name, role, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)');
    const insSource = d.prepare('INSERT INTO referral_sources (tenant_id, business_name, business_type, address, owner_rep_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insActivity = d.prepare('INSERT INTO activities (tenant_id, referral_source_id, rep_id, activity_type, activity_date, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insReferral = d.prepare('INSERT INTO referrals (tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
    const insAdmission = d.prepare('INSERT INTO admissions (tenant_id, referral_id, admitted_at, created_at) VALUES (?, ?, ?, ?)');
    const insInbox = d.prepare('INSERT INTO referral_inbox (tenant_id, external_ref, referral_source_id, assigned_rep_id, received_at) VALUES (?, ?, ?, ?, ?)');
    const insPatient = d.prepare('INSERT INTO patients (tenant_id, synthetic_ref, status, created_at) VALUES (?, ?, ?, ?)');
    const insLink = d.prepare('INSERT INTO patient_referral_links (tenant_id, patient_id, referral_id) VALUES (?, ?, ?)');

    TENANTS.forEach((tenant, index) => {
      const tenantId = index + 1;
      insTenant.run(tenantId, tenant.slug, tenant.name, `https://hooks.${tenant.slug}.example/referraldesk`);
      const createdAt = stamp('2026-05-04', 9, 0);
      const addUser = (local: string, role: string): number => {
        const email = `${local}@${tenant.slug}.example`;
        const name = `${pick(FIRST)} ${pick(LAST)}`;
        const salt = sha256(`${PRNG_SEED}:${email}`).slice(0, 16);
        return Number(insUser.run(tenantId, email, name, role, hashPassword(config.demoPassword, salt), createdAt).lastInsertRowid);
      };
      addUser('executive', 'executive');
      addUser('ops.manager', 'operations_manager');
      addUser('sales.manager', 'sales_manager');
      addUser('intake', 'intake');
      const repCount = int(8, 15);
      const reps: number[] = [];
      for (let r = 1; r <= repCount; r++) reps.push(addUser(`rep${String(r).padStart(2, '0')}`, 'rep'));

      // Referral sources: the first two reps always own at least three each so reviews have stable subjects.
      const sourceCount = int(40, 80);
      const sourcesByRep = new Map<number, number[]>(reps.map((id) => [id, []]));
      const usedNames = new Set<string>();
      for (let s = 0; s < sourceCount; s++) {
        const kind = pick(TYPES);
        let name = `${pick(PLACES)} ${kind.label}`;
        for (let attempt = 0; usedNames.has(name) && attempt < 8; attempt++) name = `${pick(PLACES)} ${kind.label}`;
        if (usedNames.has(name)) name = `${name} ${s + 1}`;
        usedNames.add(name);
        const owner = s < 6 ? reps[s % 2] : pick(reps);
        const address = `${int(10, 990)} ${pick(STREETS)}, ${pick(PLACES)}, ZZ 00${int(100, 999)}`;
        const created = stamp(dayString('2026-05-04', int(0, 40)), int(9, 16), int(0, 59));
        const id = Number(insSource.run(tenantId, `${name} (fictional)`, kind.type, address, owner, rand() < 0.9 ? 'active' : 'inactive', created, created).lastInsertRowid);
        sourcesByRep.get(owner)!.push(id);
      }
      const allSources = [...sourcesByRep.entries()].flatMap(([rep, ids]) => ids.map((id) => ({ id, rep })));

      // Activities: weekday field work, with roughly a third logged one to three days late.
      for (let day = 0; day < windowDays; day++) {
        const date = dayString(SEED_WINDOW.start, day);
        const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
        if (weekday === 0 || weekday === 6) continue;
        for (const rep of reps) {
          const owned = sourcesByRep.get(rep)!;
          if (owned.length === 0) continue;
          const n = rand() < 0.25 ? 0 : rand() < 0.7 ? 1 : 2;
          for (let k = 0; k < n; k++) {
            const roll = rand();
            const type = roll < 0.45 ? 'visit' : roll < 0.8 ? 'call' : 'note';
            const lag = rand() < 0.65 ? 0 : int(1, 3);
            insActivity.run(tenantId, pick(owned), rep, type, date, pick(NOTES), stamp(dayString(date, lag), int(9, 17), int(0, 59)));
          }
        }
      }

      // Referrals and admissions.
      const accepted: Array<{ id: number; updated: string }> = [];
      for (let day = 0; day < windowDays; day++) {
        const date = dayString(SEED_WINDOW.start, day);
        const n = rand() < 0.3 ? 0 : int(1, 4);
        for (let k = 0; k < n; k++) {
          const source = pick(allSources);
          const received = stamp(date, int(8, 18), int(0, 59));
          const age = windowDays - day;
          const roll = rand();
          let status: string;
          if (age <= 5) status = roll < 0.6 ? 'received' : 'in_review';
          else status = roll < 0.55 ? 'accepted' : roll < 0.75 ? 'declined' : roll < 0.9 ? 'in_review' : 'received';
          const updated = status === 'received' ? received : stamp(dayString(date, int(0, 4)), int(9, 17), int(0, 59));
          const id = Number(insReferral.run(tenantId, source.id, source.rep, status, received, updated).lastInsertRowid);
          if (status === 'accepted') accepted.push({ id, updated });
        }
      }
      const admitted: number[] = [];
      for (const referral of accepted) {
        if (rand() >= 0.7) continue;
        const admittedDate = dayString(referral.updated.slice(0, 10), int(1, 6));
        if (admittedDate > SEED_WINDOW.end) continue;
        const at = stamp(admittedDate, int(9, 16), int(0, 59));
        insAdmission.run(tenantId, referral.id, at, at);
        admitted.push(referral.id);
      }

      // Pending partner-feed items for the referral-sync job.
      for (let i = 1; i <= 12; i++) {
        const source = pick(allSources);
        insInbox.run(tenantId, `EXT-${tenant.slug}-${String(i).padStart(4, '0')}`, source.id, source.rep, stamp(dayString(SEED_WINDOW.end, -int(0, 6)), int(8, 18), int(0, 59)));
      }

      // Patient module placeholders: opaque synthetic tokens only, no identity or health attributes.
      for (let i = 1; i <= 6; i++) {
        const patientId = Number(insPatient.run(tenantId, `SYN-${tenant.slug}-${String(i).padStart(4, '0')}`, 'placeholder', createdAt).lastInsertRowid);
        if (admitted[i - 1]) insLink.run(tenantId, patientId, admitted[i - 1]);
      }
    });

    const setting = d.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    setting.run('patient_module_enabled', String(config.patientModuleEnabled));
    setting.run('session_ttl_seconds', String(config.sessionTtlSeconds));
    setting.run('api_token_ttl_seconds', String(config.apiTokenTtlSeconds));
    setting.run('job_lock_ttl_seconds', String(config.jobLockTtlSeconds));

    const hash = computeSeedHash();
    const meta = d.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('seed_version', SEED_VERSION);
    meta.run('seed_hash', hash);
    meta.run('seed_window_start', SEED_WINDOW.start);
    meta.run('seed_window_end', SEED_WINDOW.end);
  });
  tx();

  const counts: Record<string, number> = {};
  for (const table of ['tenants', 'users', 'referral_sources', 'activities', 'referrals', 'admissions', 'referral_inbox', 'patients']) {
    counts[table] = (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  return { seed_version: SEED_VERSION, seed_hash: computeSeedHash(), window: SEED_WINDOW, counts };
}

const HASHED_TABLES: Array<[string, string]> = [
  ['tenants', 'id, slug, name, webhook_url'],
  ['users', 'id, tenant_id, email, name, role, active, created_at'],
  ['referral_sources', '*'],
  ['activities', '*'],
  ['referrals', 'id, tenant_id, referral_source_id, assigned_rep_id, status, received_at, updated_at'],
  ['admissions', '*'],
  ['referral_inbox', 'id, tenant_id, external_ref, referral_source_id, assigned_rep_id, received_at'],
  ['patients', '*'],
  ['patient_referral_links', '*'],
];

/** Hash of the seeded business rows. Excludes credentials and runtime state. */
export function computeSeedHash(): string {
  const d = db();
  let acc = SEED_VERSION;
  for (const [table, columns] of HASHED_TABLES) {
    const rows = d.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`).all();
    acc = sha256(acc + table + JSON.stringify(rows));
  }
  return acc;
}
