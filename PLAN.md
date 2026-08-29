# Source-policy reconciliation tool plan

## Scope
Add an explicit, bounded source-policy reconciliation operator surface on `feat/source-policy-reconciliation`.

The first release reuses the existing reconciliation engine instead of introducing a second policy/fence implementation:

- read-only preview for one source;
- explicit single-source execution for a pending reconciliation marker;
- canonical `reconciliation:source:<sourceId>` lease;
- existing cursor/CAS materialization and deterministic job upserts;
- dry-run by default for the CLI;
- authenticated admin HTTP trigger with CSRF and idempotency-key validation;
- append-only pending audit claim keyed by actor/session/key/hash, enabled by a new explicit validator/index migration.

## Explicit non-goals

- Never bulk-rewrite historical `article.rightsSnapshot` or artifact source-policy versions.
- Never write `completedPolicyVersion` or reconciliation marker state directly from the CLI/HTTP layer.
- Never add a new indexing task or bypass `createReconciliationRunner`/`materializeReconciliationPage`.
- Never make paused sources public or silently activate a source.
- Never use takedown as an ordinary reconciliation workaround.
- No merge, push, deployment, or production execution from this branch.

## Current architecture decision

The repository already has the safe primitives:

```text
Source policy review
  -> pending reconciliation marker (source transaction)
  -> reconciliation runner (lease + bounded pages + marker CAS)
  -> deterministic visibility/summary/embedding jobs
  -> existing indexed job worker and article/artifact fences
```

The missing capability is an explicit, source-targeted operator/admin trigger. The tool will call the same repository and worker path. Preview must use the same source/cursor/article predicate and `buildReconciliationJobs` fan-out as execution, but perform no lease, marker, or job write.

## Acceptance criteria

1. CLI defaults to dry-run and requires `--confirm --confirm-database=<configured DB>` before mutation.
2. CLI supports a validated one-source `--source-id=<24-hex ObjectId>`; `--all` is bounded and optional only if implemented without arbitrary scans.
3. Preview returns source current/required policy versions, reconciliation state, bounded stale article count, and exact jobs that execution would materialize.
4. Execute targets only the selected source, uses the canonical reconciliation lease, honors `max-pages` and `page-limit` bounds, and releases the lease on every path.
5. Existing marker/article/job CAS and idempotency semantics remain authoritative.
6. Re-running the same source is safe and creates no duplicate jobs.
7. Admin HTTP invocation is authenticated, CSRF-protected, idempotency-key protected, contract-first, and returns a canonical response.
8. No secret, source full text, vector, or provider payload is logged.
9. Tests prove preview purity, exact source targeting, bounded pages, release-on-error, idempotency, database confirmation, and contract validation.
10. Commits remain on this branch; no merge or push.

## Build order

1. Add repository preview/source-selection tests (RED), then implement read-only assessment and target selection.
2. Add source-targeted runner tests (RED), then implement the bounded worker by extracting shared runner logic.
3. Add CLI contract tests (RED), then implement `scripts/reconcile-source-policy.js` and package scripts.
4. Add OpenAPI/admin route/service/client tests (RED), then implement endpoint and regenerate generated client.
5. Add the explicit source-policy-reconciliation audit validator/index migration; do not modify an already-run migration in place.
6. Run focused tests, contract validation/generation/tests, lint on changed files, build, and diff safety checks. Full suite only if explicitly required later.

## Merge gate

- Worktree clean except intentional task commits.
- Focused RED and GREEN evidence preserved in commits.
- `npm test -- --run` focused targets pass.
- `npm run contract:validate`, `npm run contract:test`, and generated client are consistent if HTTP endpoint ships.
- `npm run build` passes.
- `git diff --check` passes.
- No migration applied to shared DB from this branch; any required migration is explicit, idempotent, and separately reviewed.
