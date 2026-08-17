# Test evidence

This file records commands and results that were observed on the current checkout. A pending entry is not release evidence.

## Step 12 restore/release lane — 2026-08-17

Scope: local, non-network restore-plan preflight. No Atlas or Vercel mutation was authorized or performed in this lane.

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

## Step 12 application gates — 2026-08-17

| Command | Observed result |
| --- | --- |
| `npm test -- --run` | 167 files passed, 1003 tests passed; 16 files/66 tests skipped by explicit external gates |
| `npm run test:integration` | 24 files/82 tests passed; 14 files/57 tests skipped by explicit external gates |
| `npm run test:security` | 12 files/76 tests passed |
| `npm run test:ui` | 12 files/100 tests passed |
| `npm run contract:validate` | 55 operations valid |
| `npm run contract:test` | All contract/runtime fixture groups passed |
| `npm run lint` | PASS after ignoring gitignored local tool directories |
| `npm run build` | PASS |
| `npm run eval:retrieval` | PASS, 6/6 top-5 hits; below the Step 12 30+ dataset target |
| `npm run eval:groundedness` | PASS, 31/31 cases; deterministic in-memory provider fixture |
| `npm run eval:citations` | PASS, 31/31 cases; deterministic in-memory provider fixture |
| `npm run db:verify -- provider-routing-v2 --require-role` | `verified: true`, 5 collections, role verified |
| `npm run seed:demo` | PASS dry-run; 3 live connectors, 44 accepted articles, 15 audits, 3 manifests |
| `npm run seed:demo -- --apply` | PASS after the owner-authorized exact demo reset; 3 live sources, 44 accepted articles, 15 lifecycle audits and 3 manifests committed atomically |
| `npm run verify:demo` | PASS; 3/3 sources, 44 manifest-bound published articles (at least 5 per source), 15/15 lifecycle audits and 3/3 manifests verified |

Preview API/Cron smoke was also observed through `npx vercel curl`: health `200`, missing/invalid machine bearer `401`, valid bearer `202`. Direct browser-style Preview E2E remains blocked by Deployment Protection unless an approved bypass header or public test origin is configured.

## Pending external evidence

| Step 12 gate | Status | Missing authority or implementation |
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
| Serving approval | CLOSED | All preceding gates plus explicit project-owner decision |

## Release interpretation

The local scaffold validates only plan shape and destructive-target guards. It does not prove backup recoverability, governance signature authenticity, replay correctness or safe production promotion. Step 12 tasks 9–11 and the backup/restore exit criterion remain open.
