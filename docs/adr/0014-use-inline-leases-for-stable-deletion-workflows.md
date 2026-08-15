# ADR-0014: Use inline leases for stable account-deletion workflows

**Date**: 2026-08-15
**Status**: accepted
**Deciders**: Project owner
**Refines**: [ADR-0011](0011-coordinate-durable-work-scopes-recovery-and-fairness.md)

## Context

ADR-0011 dung shared `jobLeases` cho ingestion, indexing va reconciliation. Cac job nay co parent/child retry va can generation high-water tach khoi job document. Account deletion lai co mot stable workflow document. Workflow nay giu tung cleanup checkpoint va duoc requeue tren cung request sau crash.

Implementation Step 11 da dung lease noi tuyen tren `accountDeletionRequests`. Tai lieu cu van gan workflow nay vao canonical `jobLeases`, nen khong mo ta dung transaction fence va recovery behavior.

## Decision

`accountDeletionRequests` giu `leaseOwner`, `leaseExpiresAt` va `leaseGeneration` tren stable workflow document. Claim, cleanup checkpoint, fail, complete va recovery phai match exact owner token, generation va unexpired lease trong cung transaction voi domain mutation.

Expired recovery dung compare-and-set de chuyen cung request tu `running` ve `queued`, tang attempt va giu cac cleanup flag da hoan tat. Recovery khong tao parent/child request va khong reset completion evidence.

Shared `jobLeases` chi dieu phoi ingestion, article indexing va source reconciliation. ADR-0011 van la authority cho generation high-water, fairness va shared-scope coordination cua ba queue nay.

Recovery scan cua account deletion can indexed predicate theo status, lease deadline va stable `_id`. Thieu exact index hoac query-plan evidence la implementation gate, khong duoc thay bang unbounded scan.

## Alternatives Considered

### Alternative 1: Dung shared `jobLeases` cho account deletion

- **Pros**: Mot lease model cho moi queue.
- **Cons**: Tach owner khoi stable cleanup checkpoints va them parent/child semantics khong can thiet.
- **Why not**: Account deletion can resume cung request va giu per-item completion evidence.

### Alternative 2: Khong persist lease

- **Pros**: Repository don gian hon.
- **Cons**: Serverless invocation overlap co the cleanup va terminalize cung workflow hai lan.
- **Why not**: Khong co exact stale-worker fence hoac crash recovery.

## Consequences

### Positive

- Cleanup checkpoint va lease fence nam tren cung stable workflow.
- Recovery khong tao duplicate deletion request.
- Shared `jobLeases` giu dung pham vi coordination da thiet ke.

### Negative

- He thong co hai lease storage shapes.
- Migration, readiness va query-plan verification phai cover inline recovery index rieng.

### Risks

- Repository co the chi read lease ma khong conditional touch; transaction tests phai assert exact owner/generation/deadline filter.
- Recovery scan co the thanh collection scan; migration va `db:verify` phai require intended index.
