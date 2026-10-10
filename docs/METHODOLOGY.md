# Methodology

The harness reviews one release candidate at a time and answers one question: *is this build safe to release to more than one customer?* The principles below explain why each stage is built the way it is.

## Principles

1. **Review a named build.** A review is of a commit, not of an environment. The orchestrator exports the commit with `git archive` (or builds it into an image), starts that, and refuses to continue unless the running application reports the same SHA. The manifest records the SHA, image digest, versions and seed hash.

2. **State the expected behaviour before testing.** The intended permission model, routes, feature flags and report definitions are written down in `config/` and agreed before the run. A test compares the application with that statement. Nothing is "expected" because the application happens to do it.

3. **The server is the authority.** Every permission is tested by calling the server directly with the role's own credentials. Hiding a button is not a control. The role matrix records the UI result and the API result separately so a UI-only restriction is visible as a mismatch.

4. **Test with another party's data.** Isolation tests use real identifiers belonging to another tenant or another rep, discovered from the database. A response is judged by its content: a `200` that contains only the caller's records passes; a `200` that contains the victim's records fails.

5. **Verify in the system of record.** After an action is denied, the harness reads the database to confirm nothing changed. After an action is allowed, it confirms the row exists. Status codes alone are not evidence.

6. **Deny means denied everywhere.** A disabled module is tested on every route, with request variations that try to slip past a route-level gate, in the UI, and in its background work, including work that was queued before the module was switched off.

7. **Recalculate, do not trust.** Report figures are recomputed from source rows using the agreed definitions (`config/reports.ts`) and compared cell by cell with the API, the UI and exports. When figures disagree, the harness tries alternative attributions to say *why* they disagree.

8. **Background work must be safe to repeat.** Each job is run once, twice, concurrently, interrupted, failed and late. The harness checks the data, the run records and the idempotency keys after each.

9. **Nothing leaves the building.** Outbound actions are pointed at a local sink. The harness reconciles what the sink received with what tests declared they would cause, and three egress guards (application, harness, browser) block and log everything else.

10. **One cause, one finding.** Checks record a finding key that names the control that failed. Fifty failing checks under one key are one finding with fifty observations, so the report describes defects, not test counts.

11. **Evidence is preserved, not summarised.** Each finding has its own folder with the exact request and response, a screenshot, video and trace where a browser was involved, and the relevant log lines. Secrets are redacted before writing. The run folder is sealed with checksums and never rewritten.

12. **A fix is a claim until retested.** A developer saying "fixed" moves a finding to `FIXED_PENDING_RETEST`. Only a retest run against a different build, re-executing the checks that failed, can move it to `VERIFIED_FIXED`.

## Stages

| Stage | Checks | Passes when |
| --- | --- | --- |
| 01 Baseline | Build identity, seed hash, flag state, tenants and role accounts present, egress allowlist | The target is the named build in the expected state. A failure here stops the review. |
| 02 Role matrix | Every operation in `config/routes.ts` × every role, via API and via browser | Actual equals `config/permissions.ts`, and denied writes leave no trace in the database |
| 03 Sessions | Logout, re-entry, browser session expiry, API token expiry, revocation, stale browser state, save/reload | Every ended credential is refused on every protected route |
| 04 Tenant isolation | Foreign ids in paths, queries, bodies; lists, filters, search, reports, exports; writes | No victim-tenant data is returned and no victim row changes |
| 05 Module denial | Flag state, every gated route, bypass variations, UI, queued work across a flag change | Every route answers `403 FEATURE_DISABLED` and no module work executes |
| 06 Reconciliation | Summary, weekly, monthly, per-rep, per-source over four date ranges; UI; CSV exports | Every displayed figure equals the recalculated one |
| 07 Scheduled work | Single, duplicate, overlapping, interrupted, failed, missed runs | No duplicates, partial work is detected, a second attempt completes it |
| 08 Containment | Each outbound type, record fields, guard self-tests, whole-run reconciliation | Every outbound action is in the sink; no unexpected destination was attempted |
| 09 Report | Collation, secret scan, sealing, rendering | Reports are generated from sealed evidence only |

## Severity

Severity is a five-level qualitative scale: Critical, High, Medium, Low, Informational. It is assigned per finding key in `review-harness/lib/catalogue.ts` from the kind of control that failed. It is **not** a CVSS score and no CVSS vector is claimed. Critical and High findings block release while open.

## What a failing test means

A test fails in one of two ways, and the harness keeps them apart:

- A **check** failed: the application did something the model says it must not. This becomes a finding.
- The test itself broke (a timeout, a missing fixture, an adapter error). This is a **harness error**. It is reported separately, never as a finding, and it makes the report generator exit non-zero.
