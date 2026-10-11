# Retest summary

| Item | Value |
| --- | --- |
| Original run | RUN-2026-10-11-001 on build `27078b40cc23a622a81d93658dc68028bd4f563d` |
| Retest run | RUN-2026-10-11-002 on build `c4b1536f2ad558dabf3c83efa661c016ff303fd2` |
| Fix claim | 2026-10-11T17:30:30Z: Demo remediation: 5 of 5 patches applied on top of 27078b40cc23. |
| Original evidence | Unchanged (65 files verified against checksums) |
| Whole-run regression | 1297 checks passed, 0 failed; 0 failure(s) outside the original findings |
| New findings in retest | None |

## Result per original finding

| ID | Severity | Finding | Before | Retest result | Originally failing checks | Now passing | Adjacent checks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FIND-001 | High | The server lets a role without permission: list another rep's activities by filter | Fix claimed, retest pending | VERIFIED_FIXED | 2 | 2 | 314 passed, 0 failed |
| FIND-002 | High | An API token is still accepted after the user's credentials are revoked | Fix claimed, retest pending | VERIFIED_FIXED | 16 | 16 | 54 passed, 0 failed |
| FIND-003 | Critical | A user of one tenant can read another tenant's data through GET /api/referral-sources/:id | Fix claimed, retest pending | VERIFIED_FIXED | 25 | 25 | 499 passed, 0 failed |
| FIND-004 | High | Patient work queued while the module was ON is executed after the module is switched OFF | Fix claimed, retest pending | VERIFIED_FIXED | 1 | 1 | 63 passed, 0 failed |
| FIND-005 | Medium | The monthly report attributes activities to the wrong period | Fix claimed, retest pending | VERIFIED_FIXED | 10 | 10 | 232 passed, 0 failed |

### FIND-001: The server lets a role without permission: list another rep's activities by filter

All 2 originally failing check(s) were re-executed against build c4b1536f2ad5 and now pass.

- Original evidence: `evidence/RUN-2026-10-11-001/FIND-001/` (build `27078b40cc23`)
- Retest evidence: `evidence/RUN-2026-10-11-002/retest/FIND-001/retest.json` (build `c4b1536f2ad5`)

| Check | Original build | Retested build |
| --- | --- | --- |
| rep api | allowed (HTTP 200) | denied (HTTP 403 FORBIDDEN) |
| rep browser-direct | allowed (HTTP 200) | denied (HTTP 403 FORBIDDEN) |

### FIND-002: An API token is still accepted after the user's credentials are revoked

All 16 originally failing check(s) were re-executed against build c4b1536f2ad5 and now pass.

- Original evidence: `evidence/RUN-2026-10-11-001/FIND-002/` (build `27078b40cc23`)
- Retest evidence: `evidence/RUN-2026-10-11-002/retest/FIND-002/retest.json` (build `c4b1536f2ad5`)

| Check | Original build | Retested build |
| --- | --- | --- |
| executive self-revocation | revoke HTTP 200, token then HTTP 200 | revoke HTTP 200, token then HTTP 401 |
| executive token reuse on protected routes | 11 route(s) still answered: /api/me → HTTP 200; /api/referral-sources → HTTP 200; /api/activities → HTTP 200; /api/referrals → HTTP 200 | all refused |
| executive credentials on record | 1 live credential(s): api | 0 live credential(s): none |
| operations_manager self-revocation | revoke HTTP 200, token then HTTP 200 | revoke HTTP 200, token then HTTP 401 |
| operations_manager token reuse on protected routes | 11 route(s) still answered: /api/me → HTTP 200; /api/referral-sources → HTTP 200; /api/activities → HTTP 200; /api/referrals → HTTP 200 | all refused |
| operations_manager credentials on record | 1 live credential(s): api | 0 live credential(s): none |
| sales_manager self-revocation | revoke HTTP 200, token then HTTP 200 | revoke HTTP 200, token then HTTP 401 |
| sales_manager token reuse on protected routes | 11 route(s) still answered: /api/me → HTTP 200; /api/referral-sources → HTTP 200; /api/activities → HTTP 200; /api/referrals → HTTP 200 | all refused |

### FIND-003: A user of one tenant can read another tenant's data through GET /api/referral-sources/:id

All 25 originally failing check(s) were re-executed against build c4b1536f2ad5 and now pass.

- Original evidence: `evidence/RUN-2026-10-11-001/FIND-003/` (build `27078b40cc23`)
- Retest evidence: `evidence/RUN-2026-10-11-002/retest/FIND-003/retest.json` (build `c4b1536f2ad5`)

| Check | Original build | Retested build |
| --- | --- | --- |
| A→B executive path.source | HTTP 200; response contains victim-tenant data | HTTP 404; no victim-tenant data |
| A→B executive entity-id-sweep | 80 of 80 served | 0 of 80 served |
| A→B operations_manager path.source | HTTP 200; response contains victim-tenant data | HTTP 404; no victim-tenant data |
| A→B operations_manager entity-id-sweep | 80 of 80 served | 0 of 80 served |
| A→B sales_manager path.source | HTTP 200; response contains victim-tenant data | HTTP 404; no victim-tenant data |
| A→B sales_manager entity-id-sweep | 80 of 80 served | 0 of 80 served |
| A→B intake path.source | HTTP 200; response contains victim-tenant data | HTTP 404; no victim-tenant data |
| A→B intake entity-id-sweep | 80 of 80 served | 0 of 80 served |

### FIND-004: Patient work queued while the module was ON is executed after the module is switched OFF

All 1 originally failing check(s) were re-executed against build c4b1536f2ad5 and now pass.

- Original evidence: `evidence/RUN-2026-10-11-001/FIND-004/` (build `27078b40cc23`)
- Retest evidence: `evidence/RUN-2026-10-11-002/retest/FIND-004/retest.json` (build `c4b1536f2ad5`)

| Check | Original build | Retested build |
| --- | --- | --- |
| enable → queue → disable → worker | queue item done (PROJECTED); 1 projection(s) written; worker run succeeded | queue item rejected (FEATURE_DISABLED); 0 projection(s) written; worker run succeeded |

### FIND-005: The monthly report attributes activities to the wrong period

All 10 originally failing check(s) were re-executed against build c4b1536f2ad5 and now pass.

- Original evidence: `evidence/RUN-2026-10-11-001/FIND-005/` (build `27078b40cc23`)
- Retest evidence: `evidence/RUN-2026-10-11-002/retest/FIND-005/retest.json` (build `c4b1536f2ad5`)

| Check | Original build | Retested build |
| --- | --- | --- |
| A full-window | 16 figure(s) differ; e.g. activities for 2026-07: displayed 295, expected 304 (difference -9) | all figures match |
| A calendar-month | 6 figure(s) differ; e.g. activities for 2026-08: displayed 283, expected 288 (difference -5) | all figures match |
| A cross-month | 8 figure(s) differ; e.g. activities for 2026-07: displayed 130, expected 139 (difference -9) | all figures match |
| B full-window | 14 figure(s) differ; e.g. activities for 2026-07: displayed 230, expected 235 (difference -5) | all figures match |
| B calendar-month | 6 figure(s) differ; e.g. activities for 2026-08: displayed 223, expected 225 (difference -2) | all figures match |
| B cross-month | 6 figure(s) differ; e.g. activities for 2026-07: displayed 104, expected 109 (difference -5) | all figures match |
| C full-window | 12 figure(s) differ; e.g. activities for 2026-07: displayed 243, expected 249 (difference -6) | all figures match |
| C cross-month | 6 figure(s) differ; e.g. activities for 2026-07: displayed 101, expected 107 (difference -6) | all figures match |
