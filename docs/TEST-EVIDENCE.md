# Test evidence

This file records commands and results that were observed on the current checkout. A pending entry is not release evidence.

## Post-MVP recovery preflight — 2026-08-17

Scope: local, non-network restore-plan preflight only. This lane is not an MVP release gate. No Atlas or Vercel mutation was authorized or performed in this lane.

| Requirement | Evidence | Result |
| --- | --- | --- |
| Restore target cannot be live `techpulse_app` | `test/restore/restore-plan.test.js` | PASS |
| App restore cannot overwrite `techpulse_governance` | `test/restore/restore-plan.test.js` | PASS |
| Rehearsal target remains isolated and non-serving | `test/restore/restore-plan.test.js` | PASS |
| Backup retention is greater than zero and at most seven days | `test/restore/restore-plan.test.js` | PASS |
| Dump and sidecar inventory require private encrypted external storage and SHA-256 digests | `test/restore/restore-plan.test.js` | PASS |
| Plan rejects secret-bearing fields | `test/restore/restore-plan.test.js` | PASS |
| Plan rejects common secret key aliases and credential-bearing/secret-like values | `test/restore/restore-plan.test.js` | PASS |
| Storage references are exact opaque references bound to the current backup ID | `test/restore/restore-plan.test.js` | PASS |
| A locally valid plan does not claim a verified restore or open serving gate | `test/restore/restore-plan.test.js` | PASS |

Observed command:

```text
npm test -- --run test/restore/restore-plan.test.js
Test Files  1 passed (1)
Tests       25 passed (25)

npx eslint scripts/verify-restore-plan.js test/restore/restore-plan.test.js
Exit code: 0

git diff --check
Exit code: 0 (line-ending warnings only for concurrent Step 12 files)
```

The first TDD run failed because `scripts/verify-restore-plan.js` did not exist. The first implementation made eight restore-plan tests pass. The P1 hardening run then added 17 failing cases for secret aliases, credential-bearing values and storage references; the hardened implementation made all 25 tests pass.

## Step 12 MVP application gates — 2026-08-17

| Command | Observed result |
| --- | --- |
| `npm test -- --run` | 167 files passed, 1004 tests passed; 16 files/66 tests skipped by explicit external gates |
| `npm run test:integration` | 24 files/82 tests passed; 14 files/57 tests skipped by explicit external gates |
| `npm run test:security` | 12 files/76 tests passed |
| `npm run test:ui` | 12 files/100 tests passed |
| `npm run contract:validate` | 55 operations valid |
| `npm run contract:test` | All contract/runtime fixture groups passed |
| `npm run lint` | PASS after ignoring gitignored local tool directories |
| `npm run build` | PASS |
| `npm run test:e2e` | PASS, 5 tests; 9 external/local-host tests skipped by explicit gates |
| `npm run test:e2e:local` | FAIL in latest runs: server health passes on `localhost:3000`, but login receives expected `429 rate_limit_exceeded` after repeated retries filled the 15-minute login bucket; governance run had 4 passed/2 failed, non-mutation rerun had 1 passed/3 failed/2 skipped; no deletion/takedown mutation committed |
| `npm run test:e2e:vercel` | PASS, 3/3 Preview health/cron authentication tests |
| `node --env-file-if-exists=.env scripts/step9-real-provider-smoke.js --summary-only` | PASS, 1 real outbound request through the pre-Gemini configured `zen` summary route (historical evidence) |
| `node --env-file-if-exists=.env scripts/step9-real-provider-smoke.js --embedding-only` | PASS, 1 real OpenRouter request, 18 vectors x 1024 dimensions, top-5 rate 1 |
| `npm run eval:retrieval` | PASS, 6/6 top-5 hits; below the Step 12 30+ dataset target |
| `npm run eval:groundedness` | PASS, 31/31 cases; deterministic in-memory provider fixture |
| `npm run eval:citations` | PASS, 31/31 cases; deterministic in-memory provider fixture |
| `npm run db:verify -- provider-routing-v2 --require-role` | `verified: true`, 5 collections, role verified |
| `npm run seed:demo` | PASS dry-run; 3 live connectors, 44 accepted articles, 15 audits, 3 manifests |
| `npm run seed:demo -- --apply` | PASS after the owner-authorized exact demo reset; 3 live sources, 44 accepted articles, 15 lifecycle audits and 3 manifests committed atomically |
| `npm run verify:demo` | PASS; 3/3 sources, 44 manifest-bound published articles (at least 5 per source), 15/15 lifecycle audits and 3/3 manifests verified |

Preview API/Cron smoke was also observed through `npm run test:e2e:vercel`: health `200`, missing/invalid machine bearer `401`, valid bearer `202`. Direct browser-style Preview E2E remains outside this API/Cron gate and requires the configured protected Preview browser path.

## Gemini LLM migration — 2026-08-21

| Gate | Evidence | Result |
| --- | --- | --- |
| Gemini endpoint profile and Bearer/structured-output boundary | `test/unit/ai/gemini-provider-adapter.test.js` | PASS, 8 tests |
| Provider graph routes summary and both Q&A workloads to Gemini while retaining OpenRouter/BGE-M3 embedding | `test/unit/ai/gemini-provider-graph.test.js` | PASS, 2 tests |
| Synthetic summary, answer and support smoke with model fallback and closed-schema failures | `test/unit/ai/gemini-llm-smoke.test.js` | PASS, 6 tests |
| Live Gemini requests using owner-provided environment credentials | `npm run smoke:gemini -- full` | PASS, 3 outbound requests; summary, answer and support all used `gemini-2.5-flash`, with no fallback; no embedding call was made. |

The synthetic gates do not prove the Google project has current `zdr-verified` evidence. A Google Pro account does not by itself guarantee an API model's current rate-limit window; the live gate must observe the configured project response. Quota is a capacity/billing property, not privacy-retention evidence; Q&A remains fail-closed until the configured evidence is reviewed and unexpired.

## DeepSeek V4 Flash LLM migration — 2026-08-23

| Gate | Evidence | Result |
| --- | --- | --- |
| Focused provider/Q&A/indexing/runtime suite | `npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/ai/provider-registry-config.test.js test/unit/ai/provider-router.test.js test/unit/ai/provider-admission-router-boundary.test.js test/unit/qa/bootstrap.test.js test/unit/qa/grounded-answer.test.js test/unit/qa/service.test.js test/unit/qa/retrieval-contract.test.js test/unit/indexing/artifact-processor.test.js test/config/runtime.test.js` | PASS, 10 files/129 tests |
| Q&A HTTP, answer lifecycle and indexing text fallback integration | `npm test -- --run test/integration/qa-http.test.js test/integration/answers.test.js test/integration/indexing/text-fallback.test.js` | PASS, 3 files/11 tests |
| Scoped coverage for changed provider/Q&A boundaries | Vitest coverage command recorded in `docs/testing/deepseek-v4-flash-provider.tdd.md` | PASS, 141 tests; statements 86.27%, branches 84.41%, functions 93.20%, lines 96.18% |
| Security suite | `npm run test:security` | PASS, 12 files/77 tests |
| Contract fixtures | `npm run contract:test` | PASS, 56 operations and all runtime fixture groups |
| Lint/build | `npm run lint`; `npm run build` | PASS |
| Live DeepSeek summary, answer and support with synthetic input | `Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue; node --env-file-if-exists=.env scripts/deepseek-v4-flash-smoke.js full` | PASS, 3 outbound requests; all used provider `deepseek`, model `deepseek-v4-flash`, one external attempt and no fallback; answer/support policy eligible |

ADR-0016 supersedes the Gemini deployment decision for current LLM traffic. Q&A uses owner-approved capability `nonconfidential`; sensitive-input, Source Registry, citation/support, idempotency and lifecycle gates remain active. Query embedding remains `zdr-verified`-only, so current OpenRouter/BGE-M3 does not receive raw questions and Q&A retrieval uses keyword fallback. Article embedding remains OpenRouter/BGE-M3 with compatibility identity `bge-m3-v1-1024`.

## Post-MVP recovery evidence

| Recovery gate | Status | Missing authority or implementation |
| --- | --- | --- |
| Read-only `techpulse_app` dump inventory | PENDING | Atlas owner, dedicated read-only backup identity and MongoDB Database Tools |
| Encrypted private storage and destruction record | PENDING | Storage owner and time-bounded artifact lifecycle |
| Signed read-only `techpulse_governance` sidecar | PENDING | Owner-only offline checkpoint key and reviewed signer/exporter |
| Ordered audit/checkpoint/suppression verification | PENDING | `scripts/verify-audit-integrity.*`, offline verify-only key and Atlas data |
| Isolated pre-deletion/takedown restore | PENDING | Atlas owner/operator and approved `techpulse_app_restore_*` target |
| Whole-Atlas-loss sidecar-first rehearsal | PENDING | Atlas recovery target, owner credential and verified sidecar continuity |
| Restored sessions/quota/answer/provider reservation cleanup | PENDING | Restore-only mutation credential and reviewed reconciliation runner |
| Deleted-user/takedown replay and zero-match verification | PENDING | `scripts/reconcile-restored-governance.*` and current governance ledger |
| Provider failure-domain state reconciliation | PENDING | Current provider configuration version and restore runner |
| Session/CSRF/HMAC/runtime Mongo rotation and stale credential revocation | PENDING | Atlas/Vercel project owner |
| HMAC retirement/custody rehearsal | PENDING | 30-day successor evidence, zero-dependent counts and offline key inventory |
| Full primary-provider outage with cross-provider fallback | PENDING | Configured independent providers and authorized external calls |
| MVP serving approval | PENDING | Explicit project-owner decision after MVP application/deployment gates |

## Release interpretation

The local scaffold validates only plan shape and destructive-target guards. It does not prove backup recoverability, governance signature authenticity, replay correctness or safe restore promotion. Those items are intentionally deferred to the post-MVP recovery track and do not block the MVP application gate. The latest local E2E retry is rate-limited by the configured 15-minute login bucket; rerun after the window expires, without changing rate-limit data or bypassing the admission boundary. The MVP serving decision remains pending until local E2E completes with valid disposable credentials. The MVP still requires live governance mutation/audit atomicity, runtime role evidence, provider safety and deployment verification.
