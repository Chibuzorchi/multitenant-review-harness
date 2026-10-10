# Evidence model

## Layout

```
evidence/
  ledger.json                      status history of every finding (the only mutable file)
  RUN-2026-10-10-001/              one folder per run
    manifest.json                  what was reviewed
    run-summary.json               stage, test and check totals
    checks.jsonl                   every check executed, pass or fail (redacted)
    role-matrix.csv
    FIND-001/
      finding.json
      request.json                 the request that demonstrated the finding
      response.json                the response received
      observations.json            every failing check grouped under this finding
      screenshot.png               only when a browser test observed the finding
      video.webm                   only when a browser test observed the finding
      trace.zip                    Playwright trace (sanitised)
      logs.txt                     application log lines for the requests involved
    containment/egress-summary.json
    logs/                          application, sink, guard and runner logs
    reports/                       the reports as generated for this run
    checksums.sha256               seal
  RUN-2026-10-10-002/              a retest run
    retest/retest-summary.json
    retest/FIND-001/retest.json    result for each original finding
```

Only artifacts that exist are listed. A finding observed purely through the API has no screenshot or video, and its `supporting_artifacts` does not mention one.

## Manifest

`manifest.json` records: run id and kind, baseline run (for a retest), timestamp, environment name, target/API/sink URLs, target mode, candidate git SHA, harness git SHA, Docker image reference/id/digest (or a note explaining why there is none), application name and version, Node and Playwright versions, seed version and hash, feature-flag state, tenants, role accounts (addresses only), a checksum of the `config/` files the run was judged against, and the browser projects used.

It never contains passwords, API secrets, session tokens or private credentials. Every `finding.json` points to it (`"manifest": "../manifest.json"`).

## Finding

`finding.json` fields: `id`, `title`, `severity`, `status`, `category`, `affected_roles`, `affected_tenants`, `affected_route_or_job`, `build`, `run_id`, `preconditions`, `reproduction_steps`, `expected_result`, `actual_result`, `security_impact`, `business_impact`, `request_evidence`, `response_evidence`, `supporting_artifacts`, `first_seen_run`, `first_seen_sha`, `retest_run`, `retest_sha`, `retest_status`. Two additions: `key` (the control that failed) and `detection` (stage, failing-check count, diagnostic signals).

Findings are numbered in stage order within a run. The stable identity across runs is the `key`.

## Redaction

Before anything is written, the harness removes `Authorization` and `Cookie` headers, `Set-Cookie` values, and password, token and key fields from bodies, and replaces any known secret value with `[REDACTED]`. Playwright traces are rewritten the same way. At the end of collation the whole run folder, including the contents of zip files, is scanned for every secret the run used. A hit stops the run from being sealed and the generator exits non-zero.

## Sealing

When collation finishes, `checksums.sha256` is written over every file in the run folder and the files are made read-only. From then on:

- Reports are regenerated from the sealed files; the run folder is not rewritten.
- A retest writes to its own run folder and reads the original.
- The retest verifies the original seal and reports any file that changed, went missing, or was added.

Status changes are recorded in `evidence/ledger.json`, with timestamp, run and SHA for each change. The sealed `finding.json` keeps the status it had when it was found; reports merge the ledger over it.

Sealing detects accidental or casual modification. It is not a signature: someone with write access to the folder can rewrite both files and checksums. For a client engagement, copy the run folder to write-once storage or sign the checksum file.
