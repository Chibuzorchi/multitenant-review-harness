# Retest process

## Statuses

| Status | Meaning | Set by |
| --- | --- | --- |
| `OPEN` | Found and not yet addressed | The review that found it |
| `FIXED_PENDING_RETEST` | The developer says it is fixed in a named commit | A fix claim |
| `VERIFIED_FIXED` | Every originally failing check was re-executed on a new build and passed | A retest run |
| `PARTIALLY_FIXED` | Some originally failing checks pass and some still fail | A retest run |
| `NOT_FIXED` | The originally failing checks still fail | A retest run |
| `REGRESSION` | A check that passed in the original run fails on the new build | A retest run |

Nothing but a retest run can set `VERIFIED_FIXED`. If the retest did not execute all of a finding's originally failing checks (for example, a partial stage selection), the finding is reported as **not retested** and keeps its previous status.

## Steps

```bash
npm run review                                   # 1. initial review
npm run demo:remediate                           # 2. demo: build and claim a fix
#   or, for a real fix a developer committed:
npm run demo:remediate -- --claim --sha <sha> --findings FIND-001,FIND-003 --note "PR 123"
npm run review:retest                            # 3. retest the claimed commit
```

### 1. Initial review

Findings are written to `evidence/<RUN>/FIND-00N/`, the run is sealed, and each finding enters the ledger as `OPEN` with its first-seen run and SHA.

### 2. Fix claim

`demo:remediate` applies the patches in `remediation/patches/` on top of the reviewed commit, creates a new commit, and points the branch `demo/remediated` at it. It uses a scratch git index, so the working tree and current branch are untouched. It then records the claim in the ledger and moves the claimed findings to `FIXED_PENDING_RETEST`.

### 3. Retest

`review:retest`:

1. Takes the SHA from the latest fix claim and refuses to run if it equals the original build's SHA.
2. Exports and starts the new build, and writes a new manifest with the new SHA (and image digest in Docker mode).
3. Runs all stages. This both re-executes the originally failing checks and serves as regression.
4. For each original finding, matches the originally failing checks to the same checks in the new run and writes `retest/FIND-00N/retest.json` with before/after results and the adjacent checks from the same stage.
5. Reports any failing check that is not part of an original finding: `REGRESSION` if that check passed originally, otherwise a new `OPEN` finding with full evidence.
6. Verifies the original run's checksums and records whether the original evidence is intact.
7. Updates the ledger and renders `reports/retest-summary.md` and the retest view of the HTML reports.

## What the retest report shows

For each original finding: original run and SHA, retest run and SHA, status before, retest result, how many originally failing checks were re-executed and how many now pass, sample before/after observations, and the adjacent regression result. Original and retest evidence are linked side by side; the original is never edited.
