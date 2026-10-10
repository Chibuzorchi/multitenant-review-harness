# Scope and limitations

## In scope

- Authorization: five roles against a written permission model, on the server and in the UI.
- Tenant isolation across read, list, filter, search, report, export and write paths.
- Session and API-token lifecycle: logout, expiry, revocation, stale state.
- Feature-flag denial for one module, including its queued work.
- Report reconciliation against source rows.
- Scheduled-job idempotency and recovery.
- Containment of outbound actions and of the review itself.
- Evidence preservation, reporting, and retest of claimed fixes.

## Not in scope

This is a functional access-control and data-integrity review. It is not a penetration test, and it does not replace one. It does not cover:

- Injection (SQL, command, template), XSS, CSRF, SSRF, deserialization, or file-upload attacks.
- Authentication strength: password policy, brute-force protection, MFA, SSO/SAML/OIDC flows, account recovery.
- Rate limiting, denial of service, load or performance.
- Infrastructure: cloud configuration, network segmentation, secrets management, container hardening, TLS.
- Dependency vulnerabilities and supply chain.
- Source-code review. The harness is black-box plus database access.
- Cryptography and data-at-rest protection.
- Accessibility, usability, cross-browser rendering (only Chromium desktop and a Chromium mobile profile are used).
- Regulatory compliance. The harness produces evidence that can support a compliance argument; it does not assert compliance with HIPAA or anything else.

## Limits of the method

- **It tests what the model lists.** A route that is not in `config/routes.ts` is not tested. The route inventory must be checked against the application's own route table at onboarding.
- **It tests the data it has.** Isolation is shown for the tenants and records in the seed. A defect that depends on a data shape the seed lacks will not be seen.
- **Absence of findings is not proof of absence.** A clean run means the listed controls held under the listed conditions.
- **Time is simulated.** Expiry is tested with short TTLs and job schedules with explicit run times, not by waiting for real clocks.
- **Concurrency is limited.** Overlap is tested with two simultaneous runs of a job, not under production load.

## Limits of this demonstration

- ReferralDesk is a small application written for this purpose. Detecting five defects that were put there on purpose shows the stages work as designed; it does not measure detection rate on unknown defects in a real system.
- The no-false-positive result is established on this target: a clean build produces zero findings, and the remediated build produces zero findings. A real application will need tuning (for example, the business-name collision handling in tenant-isolation checks).
- The harness depends on control-plane capabilities ReferralDesk provides for testing: resetting data, toggling the flag, triggering jobs, and short TTLs. A real system must offer equivalents in a test environment, or the corresponding tests are reduced.
- Severity is a qualitative scale, not CVSS.
- Local mode has no image digest; only Docker mode records one.
- The evidence seal is a checksum, not a signature.
- The demo fix commit is created with `git commit-tree`, which does not run local commit hooks.
