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
