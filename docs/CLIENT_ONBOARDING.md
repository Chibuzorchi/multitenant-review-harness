# Client onboarding

What is needed to run this review against a real application, and what cannot be finalised until it is provided.

## How the harness is ported

Review stages import only two things:

- `config/` — what should be true: `environment.ts`, `roles.ts`, `permissions.ts`, `routes.ts`, `feature-flags.ts`, `reports.ts`.
- `adapters/` — how to reach the target: `auth.ts`, `api.ts`, `database.ts`, `logs.ts`, `jobs.ts`, `outbound.ts` (plus `control.ts` for test-environment operations). These files are interfaces. `adapters/referraldesk/` is one implementation.

To add a target:

1. Create `adapters/<client>/` implementing each interface, and register it in `adapters/index.ts`.
2. Rewrite the `config/` files for the client's roles, permission model, route inventory, flags and report definitions.
3. Set `REVIEW_ADAPTER=<client>` and the `REVIEW_*` URLs and credentials in the environment.
4. Replace the candidate launcher in `scripts/review.ts` (which starts ReferralDesk from a commit) with the client's deployment of a named build to the review environment.
5. Run stage 01 alone until it passes. It checks that the adapters, accounts and data are what the other stages assume.

Stage files in `review-harness/02-…08-…` should need little or no change. The private validation fixture (`review-harness/internal/`) and `remediation/` are demo-only and are not used.

## Checklist

### Environment and build

- [ ] A dedicated non-production environment that can be reset, with no real customer or patient data
- [ ] Written authorisation to test it, with dates, source addresses and contacts
- [ ] How a specific build is deployed there, and how the running build identifies itself (SHA, image digest, version endpoint)
- [ ] Base URLs for UI and API
- [ ] Confirmation of what the environment can reach (see containment below)

### Tenants, roles and accounts

- [ ] At least two, preferably three, test tenants with comparable synthetic data
- [ ] The list of roles and what each is meant to do, signed off by the product owner
- [ ] One test account per role per tenant, plus a second account for roles where peer isolation matters (e.g. two reps)
- [ ] How accounts authenticate (form, SSO, MFA) and a way for automation to sign in
- [ ] How API tokens are issued, expire and are revoked

### Routes and permissions

- [ ] Route inventory: an OpenAPI document, router dump or equivalent, including internal and admin routes
- [ ] For each operation, which roles may perform it and on which records (own, team, tenant)
- [ ] Known exceptions and intentionally shared data

### Sessions

- [ ] Session and token lifetimes, and whether they can be shortened in the test environment
- [ ] What revocation is supposed to end (browser sessions, API tokens, refresh tokens, other devices)

### Feature flags and gated modules

- [ ] Which modules must be OFF for this release and the expected denial response
- [ ] How flags are stored and evaluated (per tenant, per user, global; cached or not)
- [ ] Every route, job, webhook and import belonging to each gated module
- [ ] A way to toggle the flag in the test environment

### Data access

- [ ] Read-only database access to the test environment, or an agreed equivalent (admin API, export)
- [ ] Schema for the tables involved, including how tenant ownership is recorded
- [ ] Access to application logs for the review window

### Reports

- [ ] Definition of each report figure: source table, date field, timezone, inclusive/exclusive bounds, week start
- [ ] Whether figures are live or pre-aggregated, and how aggregates refresh

### Background work

- [ ] List of scheduled jobs and queues, with schedules
- [ ] A way to trigger each job on demand and to inspect its run records
- [ ] Intended behaviour on duplicate, overlapping, failed and missed runs

### Outbound integrations

- [ ] Every outbound integration: email, SMS, advertising, payments, webhooks, analytics, EHR or other partners
- [ ] How each is disabled or redirected to a sink in the test environment
- [ ] Confirmation that no test action can charge, message or notify a real person

### Reporting and logistics

- [ ] Severity definitions and what blocks release (or acceptance of the defaults here)
- [ ] Who receives findings, by what channel, and how sensitive evidence is to be stored and for how long
- [ ] How fixes will be delivered for retest (branch, build identifier) and the retest window

## Tests that cannot be finalised without client information

| Test | Blocked until |
| --- | --- |
| Role matrix expected values | The permission model is written down and signed off. Without it the harness can only describe behaviour, not judge it. |
| Route coverage | The route inventory is supplied. Unlisted routes are untested. |
| Tenant-isolation write checks | Database access (or equivalent) exists to confirm the victim's rows did not change. |
| Session expiry | Lifetimes are known and can be shortened, or the client accepts long-running tests. |
| Revocation scope | The client states what revocation is meant to end. |
| Module denial | The gated surface is enumerated and the flag can be toggled in test. The queued-work check needs a way to enqueue while ON and execute while OFF. |
| Report reconciliation | Figure definitions are agreed. A mismatch against an assumed definition is not a finding. |
| Scheduled-work checks | Jobs can be triggered and interrupted on demand and their run records read. |
| Containment | Outbound integrations can be pointed at a sink, and the environment's actual network reach is known. The demo's process-level guards live inside ReferralDesk; a real target needs network-level egress control or provider sandboxes. |
| Build identity and image digest | The deployment exposes them. |
| Mobile and browser coverage | Supported devices and browsers are stated. |
