# Multi-tenant Review Harness

A repeatable QA and application-security review method for a multi-tenant B2B SaaS CRM, demonstrated end to end against a small stand-in application.

The repository has two parts:

| Part | What it is |
| --- | --- |
| `referraldesk/` | **ReferralDesk**, a deliberately imperfect, fictional referral CRM (Express, SQLite, server-rendered HTML, JSON API). It exists only to give the harness something to review. |
| `review-harness/`, `config/`, `adapters/`, `scripts/` | **The review harness**: a Playwright/TypeScript suite that reviews a release candidate in nine stages, preserves evidence per finding, produces reports, and retests fixes against a new build. This is the product. |

## What this is, and is not

- ReferralDesk is fictional. Its tenants, people, businesses and records are invented and generated from a fixed seed. Every account uses a reserved `.example` address. There is no real personal data and no patient or health information anywhere in the repository.
- This project is an independent demonstration. It is **not affiliated with, endorsed by, or derived from Solvr** or any Solvr product, and contains none of their code, branding, assets or interface.
- **No real system is contacted.** The application, the outbound sink and the harness run on loopback (or on an internal Docker network). Three egress guards block and log anything else, and a review fails if one is attempted. See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## What it demonstrates

1. Reviewing a named build (a git SHA, and an image digest in Docker mode), not "whatever is running".
2. Checking each role's permissions on the server, separately from what the UI shows.
3. Checking tenant isolation with data belonging to another tenant, not just status codes.
4. Proving a disabled module is denied on every route, including its background work.
5. Recalculating report figures from source rows and comparing them with what is displayed.
6. Exercising scheduled work: repeat runs, overlap, failure, a second attempt, missed runs.
7. Proving outbound actions (email, SMS, ads, charges, webhooks) stay inside a local sink.
8. Preserving evidence per finding, sealed with checksums.
9. Retesting claimed fixes against a new build, and only then calling them fixed.

## Run it

Requirements: Node.js 22+, git, and (optional) Docker.

```bash
npm install
npx playwright install chromium     # once; the only browser the harness uses
npm run demo                        # the whole demonstration, about 3 minutes
```

`npm run demo` does: reset → seed → initial review → report → validate seeded-defect detection → remediate → retest → retest report → validate the retest.

Individual commands:

| Command | What it does |
| --- | --- |
| `npm run dev` | Run ReferralDesk and its sink at http://127.0.0.1:3000 (accounts follow `config/roles.ts`, e.g. `executive@harbor-ridge.example`; the shared demo password is the `DEMO_PASSWORD` default in `referraldesk/src/config.ts`) |
| `npm run seed` | Reset the demo database to the deterministic seed; prints the seed version and hash |
| `npm run review` | Initial review of `HEAD` (all stages), then reports |
| `npm run review:security` | Security stages only (01, 02, 03, 04, 05, 08) |
| `npm run report` | Regenerate reports for the latest run from its sealed evidence |
| `npm run validate:findings` | Prove the review reported exactly the seeded defects, each for the expected reason |
| `npm run demo:remediate` | Build a fix commit on branch `demo/remediated` and record a fix claim |
| `npm run review:retest` | Retest the claimed fix against the new build |
| `npm run demo:docker` | The same demo with the candidate built and run as containers |
| `npm run typecheck` / `lint` / `build` | Static checks and the application build |
| `npm run clean` | Remove working directories (add `-- --evidence` to remove evidence too) |

`docker compose up --build` brings up ReferralDesk on its own at http://127.0.0.1:3000.

A review exits 0 when it completes, whether or not it found anything: findings are its result, not an error. Add `-- --gate` to exit 1 while release-blocking findings are open (for CI).

## The seeded defects

The committed build of ReferralDesk contains exactly five deliberate defects, each introduced in its own commit. At a high level:

1. A tenant-isolation gap on one detail route.
2. A role restriction that exists in the UI but not on the server.
3. A credential-revocation gap.
4. A disabled-module check made at the wrong moment for queued work.
5. A report that attributes records to the wrong period.

The harness is not told where they are. Its stages test the permission model in `config/` against the running application. `npm run validate:findings` then compares what the review reported with a private fixture (`review-harness/internal/expected-defects.json`) that no review stage reads. Developer notes on the defects live in a git-ignored `SOLUTIONS.md` that the harness does not use.

## Review workflow

| Stage | Folder | Question it answers |
| --- | --- | --- |
| 01 Baseline | `01-baseline` | Is this the build we were asked to review, in the state we expect? Writes the run manifest. |
| 02 Role matrix | `02-role-matrix` | Does each role get exactly what the permission model allows, in the UI and on the API? |
| 03 Sessions | `03-sessions` | Do logout, expiry and revocation actually end access? |
| 04 Tenant isolation | `04-tenant-isolation` | Can one tenant read or change another tenant's data? |
| 05 Module denial | `05-module-denial` | Is the disabled patient module denied everywhere, including jobs? |
| 06 Reconciliation | `06-reconciliation` | Do displayed figures equal figures recalculated from source rows? |
| 07 Scheduled work | `07-scheduled` | Is background work idempotent and recoverable? |
| 08 Containment | `08-containment` | Did every outbound action stay local, and was anything else attempted? |
| 09 Report | `09-report` | Collates findings, seals evidence, renders reports. |

Details: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

## Remediation and retest

```bash
npm run review            # RUN-…-001: findings OPEN, evidence sealed
npm run demo:remediate    # new commit on demo/remediated; findings FIXED_PENDING_RETEST
npm run review:retest     # RUN-…-002 against the new SHA; findings VERIFIED_FIXED (or not)
```

The retest re-executes every check that originally failed, runs the full suite as regression, verifies the original evidence is unchanged, and writes its own evidence referencing the original findings. Try `npm run demo:remediate -- --only 1,3` to see what a partial fix looks like. Details: [docs/RETEST_PROCESS.md](docs/RETEST_PROCESS.md).

## Where things go

| Path | Contents |
| --- | --- |
| `evidence/<RUN_ID>/manifest.json` | What was reviewed: SHAs, image, versions, seed hash, flags, accounts, stages |
| `evidence/<RUN_ID>/FIND-00N/` | One folder per finding: `finding.json`, request/response, screenshot, video, trace, logs |
| `evidence/<RUN_ID>/checksums.sha256` | Seal over the run folder |
| `evidence/<RETEST_RUN>/retest/` | Retest results per original finding |
| `evidence/ledger.json` | Finding status history across runs |
| `reports/` | `executive-summary.html`, `report.html`, `full-review.md`, `findings.json`, `role-matrix.csv`, `retest-summary.md` |

All of these are generated and git-ignored. Details: [docs/EVIDENCE_MODEL.md](docs/EVIDENCE_MODEL.md).

## Using it on a real application

Stages depend only on `config/` (what should be true) and `adapters/` (how to talk to the target). ReferralDesk is one implementation. [docs/CLIENT_ONBOARDING.md](docs/CLIENT_ONBOARDING.md) lists what is needed to point the harness at a real system, and [docs/SCOPE_AND_LIMITATIONS.md](docs/SCOPE_AND_LIMITATIONS.md) says plainly what this demonstration does not prove.
