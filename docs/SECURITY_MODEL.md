# Security model

How the harness keeps a review contained, and how it handles the sensitive material a review touches.

## Network containment

Nothing in this repository needs the network at run time. Three independent guards enforce that, and each one is self-tested during every run.

| Guard | Where | What it does |
| --- | --- | --- |
| Application | `referraldesk/src/egress.ts` | Wraps every TCP connect and DNS lookup made by the application process. Destinations outside the allowlist are refused before a packet or DNS query is sent, and logged. |
| Harness | `review-harness/lib/egress-guard.ts` | The same for the orchestrator, the Playwright runner and workers, and the report generator. |
| Browser | `review-harness/lib/fixtures.ts` | Every browser context routes all requests through an allowlist check; anything else is aborted and logged. |

Allowed destinations: `localhost`, `127.0.0.1`, `::1` (and the wildcard and mapped forms of loopback), plus, in Docker mode, the internal service names. Nothing else.

Stage 08 proves the guards work rather than assuming it:

- Each guard is asked to reach a reserved `.invalid` name (RFC 2606, cannot resolve). The attempt must be refused and must appear in that guard's log.
- At the end of the run, a final test reads all three logs. Any refused attempt that was not one of those self-tests fails the run and is listed in `containment/egress-summary.json` under `unexpected_external_attempts`.
- Every connection the application made is listed by destination; any destination other than the sink fails the run.

In Docker mode there is a second, structural layer: the application and sink containers sit on a Compose network marked `internal: true`, which has no route to the host network or the internet. A small gateway container is the only bridge, and it publishes ports on the host's loopback interface only.

Installing dependencies (`npm install`, `npx playwright install chromium`, pulling the Node base image) does use the network. That is setup, not review, and is the only network use in the project.

## Outbound actions

Every provider the application would call in production (email, SMS, advertising, billing, webhooks) is pointed at a local sink (`referraldesk/src/sink.ts`). The application records each event (id, tenant, type, destination, payload, timestamp, status) before sending. Stage 08 reconciles three sources: what tests declared they would cause, what the application recorded, and what the sink received. An event in one and not the others is a failure.

## Secrets

- The harness reads account passwords and the operator key from environment variables only (`REVIEW_ACCOUNT_PASSWORD`, `REVIEW_OPERATOR_KEY`), falling back to the demo application's published defaults. They are never written to the manifest, evidence or reports.
- Requests and responses are redacted before being written: `Authorization`, `Cookie`, `Set-Cookie`, and password/token/key fields.
- Playwright traces are rewritten to remove the same values.
- After collation, the run folder (including zip contents) is scanned for every secret value the run used and every token it was issued. A hit prevents sealing and the generator exits 3.
- The demo credentials are fictional and only work against the local demo application.

## Data

- All data is synthetic and generated from a fixed seed. People and businesses are invented; addresses use a non-existent state code and postcode range; email and webhook addresses use the reserved `.example` TLD.
- The patient module's fixture rows are opaque synthetic references (`SYN-…`) linked to referrals. They carry no names, dates of birth, identifiers or health information.
- For a real engagement the same rule applies: the harness should run against a non-production environment with synthetic data. See CLIENT_ONBOARDING.md.

## Evidence integrity

Run folders are sealed with SHA-256 checksums and made read-only; see EVIDENCE_MODEL.md. A retest verifies the original seal before reporting.

## Trust boundaries of the harness itself

- The harness has direct database access and the operator key. Treat the machine that runs it as privileged.
- The harness resets the target's data between stages. It must never be pointed at an environment whose data matters.
- The candidate application's code is executed locally (or in a container). Review only commits you are willing to run.

## Limits

- The Node-level guards cover connections made through Node's `net` and `dns` modules in the guarded processes. They do not constrain child processes or native code. Docker mode's internal network is the stronger control and should be used when the candidate is not trusted.
- The checksum seal detects modification; it does not prevent it and is not a signature.
