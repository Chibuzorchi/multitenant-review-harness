# Retest report: ReferralDesk 1.0.0, build c4b1536f2ad5

Run RUN-2026-10-11-002, reviewed 2026-10-11. Demonstration against a fictional application with synthetic data.

**No findings open.** All 8 stages executed; 1297 checks passed.

## Summary

| Item | Value |
| --- | --- |
| Candidate | ReferralDesk 1.0.0 |
| Source SHA | `c4b1536f2ad558dabf3c83efa661c016ff303fd2` |
| Image digest | Not applicable: candidate ran as a local process from an export of the commit |
| Review date | 2026-10-11 |
| Scope | ReferralDesk 1.0.0, environment "referraldesk-local": 3 tenants, 5 roles, UI and API, background jobs and outbound actions. Patient module flag OFF. |
| Stages executed | 8 of 8, plus reporting |
| Tests | 392 passed, 0 failed (1297 checks) |
| Release-blocking findings | None open |
| Retest status | Retest of RUN-2026-10-11-001 (build 27078b40cc23) against build c4b1536f2ad5: 5 of 5 original findings verified fixed. |

### Results by control

| Control | Result | Detail |
| --- | --- | --- |
| Tenant isolation | PASS | 530 checks passed |
| Role boundaries | PASS | 320 checks passed |
| Sessions and tokens | PASS | 70 checks passed |
| Patient-module denial | PASS | 64 checks passed |
| Reconciliation | PASS | 246 checks passed |
| Scheduled work | PASS | 16 checks passed |
| Containment | PASS | 15 checks passed |

### Findings by severity

| Severity | Found | Open |
| --- | --- | --- |
| Critical | 1 | 0 |
| High | 3 | 0 |
| Medium | 1 | 0 |
| Low | 0 | 0 |
| Informational | 0 | 0 |

Severity is a five-level qualitative scale. It is not a CVSS score.

## Build and environment

| Field | Value |
| --- | --- |
| Run | RUN-2026-10-11-002 (retest of RUN-2026-10-11-001) |
| Timestamp | 2026-10-11T17:30:33.785Z |
| Environment | referraldesk-local (local-process) |
| Target base URL | http://127.0.0.1:3100 |
| API base URL | http://127.0.0.1:3100/api |
| Git SHA | c4b1536f2ad558dabf3c83efa661c016ff303fd2 |
| Docker image | none (The candidate ran as a local process from an export of the commit, not as a container, so there is no image to identify. The git SHA identifies the build.) |
| Application version | 1.0.0 |
| Node / Playwright | v22.20.0 / 1.64.0 |
| Browsers | desktop-chromium: chromium 156.0.8078.4; mobile-chromium: chromium 156.0.8078.4 |
| Seed | rd-seed-v1 ff33d888400eb51ca20d811a7d053cac7e93e759411f669758b1fe8e7271fb89 |
| Feature flags | patient_module=OFF |
| Tenants | A (id 1); B (id 2); C (id 3) |
| Role accounts | 21 fictional accounts (see manifest) |
| Configuration checksum | 7d28c1c9da49a38f3d1d366c879e58a1517bb30def0fcb9780a990aa8a913bb2 |

## Stages

| Stage | Tests passed | Tests failed | Checks passed | Checks failed | Result |
| --- | --- | --- | --- | --- | --- |
| 01-baseline | 10 | 0 | 36 | 0 | PASS |
| 02-role-matrix | 285 | 0 | 320 | 0 | PASS |
| 03-sessions | 30 | 0 | 70 | 0 | PASS |
| 04-tenant-isolation | 19 | 0 | 530 | 0 | PASS |
| 05-module-denial | 16 | 0 | 64 | 0 | PASS |
| 06-reconciliation | 20 | 0 | 246 | 0 | PASS |
| 07-scheduled | 6 | 0 | 16 | 0 | PASS |
| 08-containment | 6 | 0 | 15 | 0 | PASS |

## Findings

### FIND-001: The server lets a role without permission: list another rep's activities by filter

| Field | Value |
| --- | --- |
| Severity | High |
| Status | Verified fixed |
| Category | role-boundary |
| Affected roles | rep |
| Affected tenants | A |
| Affected route or job | GET /api/activities?rep_id=:other_rep |
| Build | 27078b40cc23a622a81d93658dc68028bd4f563d |
| First seen | RUN-2026-10-11-001 (27078b40cc23) |
| Retest | RUN-2026-10-11-002 (c4b1536f2ad5): Verified fixed |
| Detected by | 02-role-matrix, 2 of 6 checks failed |
| Evidence | evidence/RUN-2026-10-11-001/FIND-001/ |

**Preconditions**

- Signed in as the Rep test account of tenant A with an API token.
- The resource addressed belongs to the same tenant.

**Reproduction**

1. Send GET /api/activities?rep_id=:other_rep directly to the API with the rep token (resolved request: GET /api/activities?rep_id=6).
2. Read the status and the body.
3. Check whether the protected data is present, and whether the database changed.

**Expected:** denied (permission activities.read_other_rep: executive, operations_manager, sales_manager)

**Actual:** allowed (HTTP 200) (2 checks failed under this finding; see observations.json)

**Security impact:** A role can read data the permission model denies it. The restriction exists in the interface but is not enforced by the server.

**Business impact:** Staff can see colleagues' accounts and pipeline, which undermines territory ownership and commission integrity, and breaks the access promises made to the customer.

**Evidence files:** finding.json, request.json, response.json, observations.json, screenshot.png, video.webm, trace.zip, logs.txt

### FIND-002: An API token is still accepted after the user's credentials are revoked

| Field | Value |
| --- | --- |
| Severity | High |
| Status | Verified fixed |
| Category | session-management |
| Affected roles | executive, operations_manager, sales_manager, intake, rep |
| Affected tenants | A |
| Affected route or job | POST /api/auth/revoke; POST /api/users/:id/revoke-sessions |
| Build | 27078b40cc23a622a81d93658dc68028bd4f563d |
| First seen | RUN-2026-10-11-001 (27078b40cc23) |
| Retest | RUN-2026-10-11-002 (c4b1536f2ad5): Verified fixed |
| Detected by | 03-sessions, 16 of 16 checks failed |
| Evidence | evidence/RUN-2026-10-11-001/FIND-002/ |

**Preconditions**

- Executive test account of tenant A holds a browser session and an API token, both working.

**Reproduction**

1. Sign in to obtain a browser session.
2. Request an API token for the same account.
3. Confirm both credentials are accepted.
4. Call the revoke-all-credentials endpoint from the browser session.
5. Reuse the browser session and the API token.

**Expected:** HTTP 401 with the revoked API token

**Actual:** revoke HTTP 200, token then HTTP 200 (16 checks failed under this finding; see observations.json)

**Security impact:** A credential remains usable after the point at which the system says it has ended.

**Business impact:** Access cannot be reliably withdrawn from a departing employee, a lost device or a leaked credential.

**Evidence files:** finding.json, request.json, response.json, observations.json, trace.zip, logs.txt

### FIND-003: A user of one tenant can read another tenant's data through GET /api/referral-sources/:id

| Field | Value |
| --- | --- |
| Severity | Critical |
| Status | Verified fixed |
| Category | tenant-isolation |
| Affected roles | executive, operations_manager, sales_manager, intake |
| Affected tenants | A, B, C |
| Affected route or job | GET /api/referral-sources/:id |
| Build | 27078b40cc23a622a81d93658dc68028bd4f563d |
| First seen | RUN-2026-10-11-001 (27078b40cc23) |
| Retest | RUN-2026-10-11-002 (c4b1536f2ad5): Verified fixed |
| Detected by | 04-tenant-isolation, 25 of 31 checks failed |
| Evidence | evidence/RUN-2026-10-11-001/FIND-003/ |

**Preconditions**

- Signed in as the executive test account of tenant A.
- Identifiers of tenant B records are known to the caller (identifiers are sequential integers).

**Reproduction**

1. Obtain an API token as the executive of tenant A.
2. GET /api/referral-sources/51 (Referral source detail by foreign id; vector: url-path-id).
3. Inspect the response for records whose tenant is the victim tenant.

**Expected:** no victim-tenant data in the response

**Actual:** HTTP 200; response contains victim-tenant data (25 checks failed under this finding; see observations.json)

**Security impact:** An authenticated user of one tenant can read records that belong to a different tenant by changing an identifier.

**Business impact:** One customer can see another customer's commercial relationships. This is a reportable breach of tenant confidentiality and of the customer contract.

**Evidence files:** finding.json, request.json, response.json, observations.json, screenshot.png, video.webm, trace.zip, logs.txt

### FIND-004: Patient work queued while the module was ON is executed after the module is switched OFF

| Field | Value |
| --- | --- |
| Severity | High |
| Status | Verified fixed |
| Category | module-denial |
| Affected roles | executive |
| Affected tenants | A |
| Affected route or job | job patient-projection-queue (queued by POST /api/jobs/patient-sync) |
| Build | 27078b40cc23a622a81d93658dc68028bd4f563d |
| First seen | RUN-2026-10-11-001 (27078b40cc23) |
| Retest | RUN-2026-10-11-002 (c4b1536f2ad5): Verified fixed |
| Detected by | 05-module-denial, 1 of 1 checks failed |
| Evidence | evidence/RUN-2026-10-11-001/FIND-004/ |

**Preconditions**

- patient_module is OFF at the start and at the end.
- An executive test account of the tenant.

**Reproduction**

1. Switch patient_module ON.
2. POST /api/jobs/patient-sync as the executive; note the queue item id.
3. Switch patient_module OFF.
4. Run the patient-projection-queue worker.
5. Read the queue item and the patient projection table from the database.

**Expected:** queued item not processed; no patient projection written while the flag is OFF

**Actual:** queue item done (PROJECTED); 1 projection(s) written; worker run succeeded

**Security impact:** Functionality behind a disabled feature flag is reachable or executes. For a module that is switched off because it is not yet approved to hold regulated data, the switch is the control.

**Business impact:** The business cannot state that the unapproved module is inert in production, which is the basis on which the release is being approved.

**Evidence files:** finding.json, request.json, response.json, observations.json, trace.zip, logs.txt

### FIND-005: The monthly report attributes activities to the wrong period

| Field | Value |
| --- | --- |
| Severity | Medium |
| Status | Verified fixed |
| Category | reconciliation |
| Affected roles | executive, operations_manager, sales_manager |
| Affected tenants | A, B, C |
| Affected route or job | GET /api/reports/monthly; GET /reports |
| Build | 27078b40cc23a622a81d93658dc68028bd4f563d |
| First seen | RUN-2026-10-11-001 (27078b40cc23) |
| Retest | RUN-2026-10-11-002 (c4b1536f2ad5): Verified fixed |
| Detected by | 06-reconciliation, 10 of 14 checks failed |
| Evidence | evidence/RUN-2026-10-11-001/FIND-005/ |

**Preconditions**

- Seeded data set, unmodified.
- Signed in as an executive of tenant A; every role with report access sees the same figures.

**Reproduction**

1. GET /api/reports/monthly?from=2026-07-01&to=2026-09-30.
2. Read the tenant's activities rows directly from the database.
3. Count rows whose activity_date date falls in the range, bucketed by month using the same activity_date date.
4. Compare each displayed figure with the recalculated one.

**Expected:** every activities/visits/calls/notes figure equals the count of source rows attributed by activity_date, 2026-07-01 to 2026-09-30 inclusive

**Actual:** 16 figure(s) differ; e.g. activities for 2026-07: displayed 295, expected 304 (difference -9) (10 checks failed under this finding; see observations.json)

**Security impact:** No confidentiality impact: a reported figure does not match the records it is calculated from.

**Business impact:** Managers act on wrong numbers. Activity credited to the wrong period distorts performance reviews, targets and commission.

**Evidence files:** finding.json, request.json, response.json, observations.json, screenshot.png, video.webm, trace.zip, logs.txt

## Role matrix

200 role-and-operation combinations exercised; 0 did not match the intended permission model. Full matrix: `reports/role-matrix.csv`.

## Retest

Retest of RUN-2026-10-11-001 (build 27078b40cc23) against build c4b1536f2ad5: 5 of 5 original findings verified fixed.

## Limits of this review

- Results describe the build, seed and configuration in the manifest only.
- This is behavioural testing from outside the application with database and log access. It is not a source-code audit, infrastructure penetration test or load test.
- A passing check shows the control held for the cases exercised.
- The target is a fictional stand-in; see docs/CLIENT_ONBOARDING.md for what a real engagement needs.
