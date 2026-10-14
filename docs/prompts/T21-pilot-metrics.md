DISPATCH · Model: standard (a read-only report; the risk is a wrong definition, not a broken invariant) · Order: after the docs PR that carries this prompt merges; T20 may still be in review
Surface: Cursor · Repository: StephenForte/OceanRelay
Baseline: main at the merge of that docs PR or later (all Node tests passing, 0 skipped)
Host: any machine with Node 26
Runtime: unmeasured; small to medium
Working directory: your OceanRelay checkout, starting from main · Landing: draft PR from task/T21-pilot-metrics
Teardown: n/a

# T21: pilot metrics from the Render Shell (Phase 6)

You are implementing one task in the OceanRelay repository, a Node web service that renders HTML on the server.

## Read first
- docs/oceanrelay-prd.md "Phase 6 — Invite-only pilot": the metrics it asks for.
- docs/plan.md: the Phase 6 readiness note under the Phase 5 table (2026-10-14), including the operator's decisions.
- docs/decisions.md: C-7 (offers), C-9 (requests and `history`), C-11 (fulfilment, cancellation and `cancellationEvents`), C-12 (audit).
- lib/records.js, to see how those fields are written. The script must not use it to open the file (see the traps).
Verify against the repo; if it disagrees with this brief, the repo wins. Say so in the handoff.

## Why this exists
The PRD's pilot must "record how many offers are created, how many requests arrive, how long a decision takes, how many complete, and how many are cancelled, rolled, or disputed. Note who participates again." Every event is already in the records file with a timestamp, but nothing turns it into those numbers. The operator chose a script run from the Render Shell over a page. Whether test data is excluded by date or by company is deferred, so the script must support both without deciding.

## What to build
`scripts/pilot-metrics.js`, plus `"pilot:metrics": "node scripts/pilot-metrics.js"` in package.json scripts.

**Run:** `node scripts/pilot-metrics.js [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--exclude-company <companyId>]... [--json]`
- It reads the records file at `OCEANRELAY_RECORDS_PATH`, or at `--file <path>` if given.
- `--since` and `--until` are inclusive UTC dates. They apply to an offer by its `createdAt`, and to a request by its `createdAt`.
- `--exclude-company` drops every offer whose seller is that company, and every request whose buyer **or** seller is that company. It is repeatable.
- The default output is plain text. `--json` prints one JSON object with the same numbers.

**Metrics** (state each definition in a one-line header in the text output, so a reader knows what was counted):
1. **Offers:** created; published (ever had `publishedAt`); on chain (has a `chain` record with a confirmed publish).
2. **Requests:** arrived; and by final off-chain state: accepted, declined, withdrawn, still open (pending or countered).
3. **Decision time**, from request creation:
   - to the **first response**: the first `history` entry after creation whose `to` is countered, accepted or declined;
   - to the **final decision**: the entry whose `to` is accepted, declined or withdrawn.
   For each, report the count, median, p90 and max, in hours with one decimal. Requests without that entry are excluded and counted as "not yet".
4. **After acceptance:** completed; cancelled; ever rolled (a `fulfilment.history` entry with `to` "rolled"); disputed (`fulfilment.cancellation.state` "disputed", or a "refused" cancellation event); carrier rejected.
5. **Counters:** requests with at least one counter; counters in total.
6. **Who participates again:** for each company, the number of offers created and the number of requests made, received and accepted, plus its first and last activity dates. "Again" means activity on 2 or more distinct UTC days, and the summary line gives that count. Show company ids, and the company name where the records hold one.

## The traps
1. **Read-only, provably.** The script runs on the live server's disk. It must parse the JSON with `fs.readFileSync` and `JSON.parse` only. It must not call `openRecords` (which can migrate and write), must not write any file, must not make any network call, and must not need the chain or any secret. Test it: run the script against a fixture and assert the file is byte-identical with the same mtime afterwards.
2. **Definitions must match the records, not guesses.**
   - Decision times come from `request.history[].at`, not from the audit log.
   - A buyer who declines a counter is a final decision, not a first response.
   - Withdrawn is final, but it is not a seller decision.
   - Write each definition into the output header and the README section.
3. **Filters must not double-count or leak.** A request between an excluded and an included company is excluded. `--since` on its own includes everything from that date. With no filters, the totals equal a hand count of the fixture.
4. **Empty data must not crash.** No offers, no requests, or every company excluded: print zeros and "not yet" with exit code 0.
5. **Old schemas.** If `schemaVersion` is not 7, print a one-line message and exit with code 2. Never migrate.

## Tests (test/pilot-metrics.test.js)
- A fixture records file (schema 7) built by hand, with: 2 sellers and 2 buyers; published and draft offers; requests accepted directly, countered then accepted, declined by the seller, declined by the buyer after a counter, withdrawn, and still pending; one completed, one cancelled, one rolled, one disputed; and one company active on 2 days.
- Assert every metric against values computed by hand in the test, including median and p90 for a known set of durations.
- Assert `--since`, `--until`, `--exclude-company` (twice), and `--json` (valid, and the same numbers as the text).
- Assert the read-only property (bytes and mtime), the empty-data case, and exit code 2 on schema 6.

## Must not change
Everything in lib/, the routes, views and existing tests; contracts/**, deployments/** and docs/**. No new dependency.

## File scope
Owned: scripts/pilot-metrics.js (new), test/pilot-metrics.test.js (new). Shared, additive only: package.json (the one script line), README.md (a short "Pilot metrics" section: the command to run in the Render Shell, the flags, and the definitions). Anything else: stop and report. No new identifiers.

## Outside the repo
None needed. Temp files under one mktemp -d with trap … EXIT.

## Gate (after rebasing onto current main)
    node --check scripts/pilot-metrics.js test/pilot-metrics.test.js
    npm install && npm test             (current count plus yours, 0 failed, 0 skipped)
    node scripts/pilot-metrics.js --file <your fixture>   (prints the report; exit code 0)
Push, then confirm Semgrep, Trivy and Bugbot ran on the new head. If Bugbot does not start within 15 minutes, say so; the operator triggers it with a "bugbot run" comment.

## Disagree if needed
If a metric definition here is wrong for the records as they are written, argue it with evidence rather than implementing around it.

## Hand back
Open a draft PR with this block filled in, and return it in one fenced block:

    TASK:        T21 — Pilot metrics from the Render Shell (Phase 6)
    BRANCH:      task/T21-pilot-metrics
    PR:          <url>
    STATUS:      complete | complete-with-caveats | blocked
    GATE:        node --check ✅  npm test: <N> passed, <N> failed, <N> skipped (was <N>)
                 base: main at <sha>  head: <sha>
    METRICS:     every PRD metric present, with its definition in the output header: yes/no
    READ-ONLY:   no openRecords, no writes, no network; fixture bytes and mtime unchanged: yes/no
    FILTERS:     since / until / exclude-company (repeatable) / json, each tested: yes/no
    EDGES:       empty data → zeros, exit 0; schema ≠ 7 → exit 2: yes/no
    SCANS:       Semgrep <pass/fail> · Trivy <pass/fail> · Bugbot <pass/fail, findings>
    SHARED FILES TOUCHED: <package.json and README.md: exactly what changed>
    EXISTING TESTS MODIFIED: none | <path — why>
    TEMP:        <paths> — deleted: yes/no
    DECISIONS NEEDED FROM OPERATOR: none | <question>
    RISKS AND FOLLOW-UPS: <definitions you were unsure of>

/goal T21 is done when `node scripts/pilot-metrics.js` reads the records file read-only (no openRecords, no writes, no network) and prints every PRD Phase 6 metric with its definition: offers, requests, decision times (median, p90, max), outcomes after acceptance, counters, and repeat participants; when --since, --until, repeatable --exclude-company and --json work and are tested against a hand-counted fixture; when empty data prints zeros and exits 0 and a schema other than 7 exits 2; and when task/T21-pilot-metrics passes node --check and npm test (0 skipped), with Semgrep, Trivy and Bugbot green on the new head. Keep the PR merge-ready by fixing CI and bot findings within this scope only.
