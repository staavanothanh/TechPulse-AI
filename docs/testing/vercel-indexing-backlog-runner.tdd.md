# Vercel indexing backlog runner - TDD evidence

## Problem

The shared due-work coordinator gives each registered queue one fair turn and is
configured with only three total job attempts. A single ingestion batch can
materialize far more summary and embedding jobs than that, so a daily Vercel
cron invocation cannot drain the indexing backlog.

## Acceptance criteria

- Keep the existing fair queue turn for account deletion, indexing, and
  ingestion.
- After the fair turn, drain additional indexing jobs within server-owned
  limits; HTTP callers cannot select limits, concurrency, or queues.
- Never process two indexing jobs for the same article concurrently.
- Cap concurrent summary and embedding work independently.
- Stop starting work when the claim cap or execution deadline is reached.
- A lease conflict for one article must not block unrelated articles.
- A provider admission denial before any outbound request must defer the same
  job and restore the article artifact to `pending` rather than terminal
  `failed`.
- Preserve the existing due-work response and OpenAPI contract.
- Keep the production cron schedule daily and set an explicit bounded Vercel
  function duration.

## TDD matrix

| Layer | Evidence |
| --- | --- |
| Unit | bounded indexing drain, task concurrency, article serialization, deadline, claim cap |
| Unit | provider pre-outbound denial metadata and safe job defer |
| Unit | artifact pending reset for zero external attempts |
| Integration | cron materialization precedes the fair turn and bounded drain |
| Contract/security | existing admin authorization, CSRF, rate limiting, and response shape remain unchanged |
| Deployment | daily cron remains registered; API function duration is explicit |

## Verification log

Commands and actual results are recorded here as the RED, GREEN, and review
checkpoints are executed.

### RED

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/vercel/deployment-config.test.js
```

Result: expected failure. The new drain module does not exist yet and five
behavior tests fail for provider metadata, safe defer, artifact pending reset,
cron composition, and Vercel duration. Existing assertions in the focused set
remain green (`53 passed`).

```text
npm test -- --run test/unit/jobs/service.test.js
```

Result: expected failure (`15 passed`, `1 failed`) because create/retry auto-kick
and explicit admin draining still share one runner.

### GREEN

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/jobs/service.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/vercel/deployment-config.test.js
```

Result: PASS (`7 files`, `80 tests`).

```text
npm test -- --run test/unit/jobs/coordinator.test.js test/unit/indexing/repository.test.js test/unit/indexing/bootstrap.test.js test/unit/indexing/service.test.js test/unit/jobs/service.test.js test/security/jobs-http.test.js test/ui/admin/admin-due-work.test.js
```

Result: PASS (`7 files`, `51 tests`). The repository selector regression was
then added and passed separately (`1 file`, `5 tests`).

```text
npm test -- --run test/integration/jobs-leases.mongo.test.js
```

Result: Mongo integration suite was discovered but skipped because
`MONGODB_TEST_URI` was not present in the test process (`14 skipped`).

```text
npm run lint
npm run build
git diff --check
```

Result: PASS.

```text
npm test -- --run --coverage test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/jobs/service.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/unit/indexing/repository.test.js test/vercel/deployment-config.test.js
```

Result: all focused tests passed (`8 files`, `86 tests`). The command still
exited non-zero because the repository-wide coverage threshold was evaluated
against only this focused subset (`34.32%` lines globally). Changed focused
modules reported, among others, `91.01%` lines for the new drain, `79.68%` for
the indexing queue, `94.64%` for provider routing, `96.70%` for artifact
processing, `97.40%` for the jobs service, and `97.05%` for jobs bootstrap.
The global coverage gate remains for the final verification phase; it is not
reported as passing here.

Final focused GREEN rerun, including HTTP security and admin UI regression:
`10 files`, `101 tests`, PASS.

### Independent review remediation

Independent code and security review found three concurrency/error-path defects
and one Atlas query-plan defect. Each was reproduced with a failing regression
test before implementation:

- a fast wave rejection could become an unhandled rejection before settlement;
- a claim conflict after lease acquisition could stop the complete drain;
- an availability query could mask the first infrastructure failure;
- heartbeat loss did not cancel the provider request;
- task-aware selectors still forced the task-unaware due indexes;
- in-flight cancellation could publish output across a check/commit race;
- final-attempt lease loss could leave an artifact `processing` forever.

The GREEN remediation propagates lease cancellation into provider adapters,
prevents stale artifact transitions, releases claim-race leases, observes wave
rejections immediately, preserves the original infrastructure error, and adds
an idempotent task-aware index migration. Artifact commits now fence the
cancellation state atomically, and expired-lease recovery repairs the matching
artifact state.

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/indexing/repository.test.js test/migrations/indexing-drain-performance.test.js test/unit/indexing/bootstrap.test.js test/unit/performance/schema-readiness.test.js
```

Result: PASS (`8 files`, `81 tests`).

Final focused regression expansion: PASS (`16 files`, `168 tests`). Security
regression: PASS (`12 files`, `77 tests`). `contract:validate`, `contract:test`,
`npm run lint`, `npm run build`, and `git diff --check` all pass.

```text
npm run db:migrate:dry-run -- --to indexing-drain-performance
```

Result: PASS with two non-destructive `createIndex` operations. The migration
was not applied to the shared Atlas database. The Mongo lease integration suite
was discovered again but remained skipped because `MONGODB_TEST_URI` was not
available in the test process (`14 skipped`).
