# ADR-0017: Add a bounded indexing drain after the fair queue turn

- Status: accepted
- Date: 2026-08-23
- Extends: ADR-0011

## Context

ADR-0011 gives every registered durable queue one reserved turn, then spills
the remaining capacity to the oldest due queue. The production runner was
configured for three total attempts, which is enough for queue fairness but
not for indexing throughput: one ingestion batch can create a summary and an
embedding job for every published article.

Vercel cron is the only automatic worker trigger in the MVP deployment and is
scheduled daily. Leaving indexing on the three-attempt runner makes the
backlog grow even when provider capacity is available.

## Decision

Keep the reserved fair turn from ADR-0011. After that turn:

- the explicit admin due-work operation may run a server-owned indexing drain
  with a 24-attempt, 45-second start budget;
- the daily cron may run a server-owned indexing drain with a 200-attempt,
  240-second start budget;
- summary, embedding, and visibility work have independent concurrency caps;
- two jobs for the same article are never executed concurrently;
- claim attempts, including lease conflicts, consume the invocation cap;
- no new work starts after the deadline guard, and all started work settles
  before the invocation returns;
- create and retry requests keep the short fair auto-kick and do not inherit
  the longer admin drain;
- HTTP callers cannot set queue selection, budgets, claim caps, or concurrency.

Provider admission denial before an outbound attempt is deferred with a
bounded retry delay. Configuration, privacy, evidence, and post-outbound
failures remain terminal under the existing recovery policy.

## Consequences

- Indexing can use the available serverless invocation without starving the
  account-deletion and ingestion reserved turns.
- Admin can make bounded manual progress without waiting for the next daily
  cron.
- The due-work response and OpenAPI contract remain unchanged; drain counters
  are merged into the existing indexing queue counters.
- Existing due indexes remain valid for the initial patch, although task and
  article exclusions are post-filters. A new migration is required if explain
  evidence later shows unacceptable scans; committed migrations are not
  modified.
- The Vercel API function receives a five-minute execution ceiling, while the
  application budget remains lower to retain shutdown margin.

## Rejected alternatives

- Increasing the shared coordinator from three attempts without concurrency:
  provider calls would remain sequential and could overrun the invocation.
- Running an unbounded `Promise.all`: this could exceed provider admission,
  duplicate article work, and return before all lease-owning tasks settle.
- Using the long drain for every create/retry request: unrelated backlog would
  add unacceptable synchronous latency to admin mutations.
