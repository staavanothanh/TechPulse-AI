# ADR-0018: Harden indexing drain ownership and query plans

- Status: accepted
- Date: 2026-08-23
- Extends: ADR-0017

## Context

The bounded drain introduced by ADR-0017 selects due work by task and excludes
articles already active in the same wave. The original due-work indexes do not
contain `task`, so a growing backlog can force Atlas to post-filter many rows.

The original lease heartbeat only extended ownership. Losing that heartbeat
did not stop an in-flight provider request, which could duplicate provider cost
after another invocation recovered the expired lease. A fast worker rejection
could also remain temporarily unobserved while the drain selected more work.

## Decision

- Add a separate, idempotent `indexing-drain-performance` migration with
  task-aware aged and normal due indexes.
- Make indexing runtime readiness fail closed until both indexes exist.
- Bind the existing `indexing-jobs` release attestation generation and query
  plan verification to the new indexes.
- Abort the provider request when the indexing lease heartbeat loses ownership
  and prevent the stale worker from committing terminal artifact state.
- Re-check admin cancellation after provider completion and make the artifact
  commit transaction require that cancellation is still absent. A
  cancellation-specific fenced reset requires cancellation to be present.
- Repair artifacts during expired-lease recovery: retryable/cancelled work
  returns to `pending`, while a final failed attempt becomes `failed`.
- Treat a claim conflict after lease acquisition as normal contention, release
  the lease, and continue draining unrelated work.
- Attach rejection handling when a wave task is created and preserve the first
  infrastructure error instead of masking it with an availability query.

## Consequences

- Deployments must apply and verify `indexing-drain-performance`, then issue a
  fresh runtime schema attestation before the new runtime becomes available.
- `db:verify indexing-drain-performance --issue-runtime-attestation` emits the
  attestation under the existing `indexing-jobs` runtime scope.
- Existing committed migrations and their indexes remain unchanged.
- Provider requests can be cancelled on lease loss; database fencing remains
  the final protection against stale commits.
- Provider output produced across an admin-cancellation race is discarded; the
  artifact is returned to `pending` and the job completes as cancelled.
- Task-aware selection avoids the broad post-filter scans identified during
  independent review.

## Rejected alternatives

- Ignore heartbeat loss and rely only on commit fencing: this protects data but
  can still duplicate paid provider calls.
- Modify the committed `indexing-jobs` migration: shared databases may already
  have applied it, so a new idempotent migration is required.
- Keep using the old due indexes: this leaves the production backlog path
  vulnerable to growing Atlas scans.
