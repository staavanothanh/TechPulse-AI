# Plan-Orchestrate Result

**Plan**: `docs/plans/techpulse-ai-mvp.md`  
**Lang**: `unknown` — project baseline là JavaScript/JSX; catalogue không có JavaScript-specific reviewer  
**ECC mode**: `plugin`  
**Steps**: 12  
**Scope**: `all`

> Đây là output generative. Mỗi lệnh chỉ chạy khi project owner chủ động paste vào ECC; tài liệu này không tự gọi `/ecc:orchestrate`.

## Execution metadata

- **Prerequisite:** chỉ chạy một step khi dependency trong blueprint có handoff/verification evidence; Step 1 chỉ bắt đầu sau Plan-of-Record baseline v1.6.
- **Authority:** prompt dưới đây là entrypoint, không thay thế tasks/exit criteria trong blueprint hoặc OpenAPI/PRD/Data Model.
- **Ownership collision:** Step 3 sở hữu source marker; Step 4 sở hữu queue registry/generic runner/leases/ingestion; Step 7 chỉ tạo article/intent, không materialize marker; Step 9 đăng ký indexing + sole marker materialization/checkpoint; Step 11 đăng ký deletion + governance và `tests/e2e/governance/**`. Không sửa migration/file step khác nếu chưa handoff.
- **Safe parallel lanes:** chỉ Steps 5/6 có thể chạy song song sau Step 4. Phần Step 11 không chạm Q&A có thể chuẩn bị sau Step 9, nhưng Step 11 exit chờ Step 10 để chạy delayed-write lifecycle races; Step 12 chờ Step 11.
- **Cutline:** coding-agent support cho phép giữ target scope; chỉ mutation theo milestone thực tế. Không cắt contract/security/source policy/citation/fencing/audit/deletion completion.

## Steps overview

| # | Title | Tags | Chain |
|---|---|---|---|
| 1 | Scaffold application and contract toolchain | impl, build | `ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer` |
| 2 | Build MongoDB core, authentication and session authorization | impl, db, security | `ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer` |
| 3 | Implement Source Registry and executable rights policy | impl, security | `ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer` |
| 4 | Add durable jobs, Mongo leases and SSRF-safe source fetching | impl, db, security | `ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer` |
| 5 | Implement the RSS/Atom connector | impl | `ecc:tdd-guide,ecc:code-reviewer` |
| 6 | Implement arXiv and Hacker News connectors | impl | `ecc:tdd-guide,ecc:code-reviewer` |
| 7 | Integrate normalization, deduplication and article lifecycle | impl, db | `ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer` |
| 8 | Deliver feed, detail, saved articles and keyword search | impl, security | `ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer` |
| 9 | Add Vietnamese summaries, embeddings and hybrid retrieval | impl, db, security | `ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer` |
| 10 | Implement grounded Q&A, paragraph citations and refusal | impl, security | `ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer` |
| 11 | Complete admin operations, governance and audit UI | impl, db, security | `ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer` |
| 12 | Run adversarial verification, deploy and prepare the demo | test, security, build, review | `ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer` |

---

## Step 1 — Scaffold application and contract toolchain

**Intent**: Tạo JavaScript/JSX modular monolith với React/Vite, Express, test/build và OpenAPI runtime contract/generation.  
**Tags**: `impl`, `build`  
**Chain rationale**: TDD dẫn scaffold; build resolver kiểm tra Vite/Vercel; code reviewer chốt module và generated JavaScript contract artifacts.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Scaffold React/Vite JS/JSX + Express/Vercel; pin tooling và contract/test/eval/db/build scripts. Acceptance: every OpenAPI operation has x-persistence mongo|none; lint rejects missing/unknown; every JSON body has 400 and mongo operation has 503; kill-tests cover HttpsUrl/media host, Source states, account-deletion revoke/delete flags with no request body, decisionReasonCode, expected policy version and unavailable citation/takedown completion; generated JS imports, bundle sạch. Out of scope: DB, auth, business UI, connector/provider thật."
```

## Step 2 — Build MongoDB core, authentication and session authorization

**Intent**: Thiết lập Mongo migrations, account lifecycle, opaque session, CSRF/RBAC và shared rate-limit buckets.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database reviewer kiểm tra index/TTL/atomic bucket; code/security reviewers chốt serializer, session, CSRF và RBAC.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement/apply/verify Mongo auth migrations, register/login/logout/me/preferences, opaque sessions, CSRF/RBAC, subjectType rateLimitBuckets và seeded admin; enforce session idle 24h/absolute 7d, revoked-session 24h TTL, user quota vs shared IP separation, and indexed direct session-delete/zero-match primitive. Acceptance: logout/suspend revoke session; đúng 401/403; DB/log không có token/password rõ. Account deletion workflow belongs Step 11. Out of scope: Source Registry, content, social login, MFA."
```

## Step 3 — Implement Source Registry and executable rights policy

**Intent**: Tạo Source Registry, text/media policy review, state machine và fail-closed policy gates.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review bảo vệ state/contract; security review chốt rights/media scope, audit redaction và backend authorization.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/policy/re-review, connector matrix, policyVersion, marker validators và atomic reasonCode audit. Acceptance: ordinary connector-config mutation increments policyVersion exactly once and atomically writes pending reconciliation marker plus audit; contradictory policy/connector, Source attribution true+missing|null|empty, invalid terminal states and IP-literal media host are rejected. Out of scope: Network check thật, job materialization, automatic license interpretation."
```

## Step 4 — Add durable jobs, Mongo leases and SSRF-safe source fetching

**Intent**: Xây durable bounded runner, ingestion jobs, leases, idempotency, cron/admin triggers và SSRF-safe technical checks.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database/code review chốt lease/job contract; security review kiểm tra cron auth, SSRF và shared rate limits.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement queue registry, canonical resource keys, no-TTL high-water, exact heartbeat, linked/same-request recovery adapters và reserved queue-local fairness; register ingestion only. Test fake three registered due adapters with maxJobs=3 so each receives a reserved slot; fail safely if maxJobs is below registered count. Safe-fetch pin validated public IP per hop. Out of scope: Connector parse, article persistence."
```

## Step 5 — Implement the RSS/Atom connector

**Intent**: Parse allowlisted RSS/Atom thành normalized candidates, gồm optional media metadata nhưng không fetch linked content/binary.  
**Tags**: `impl`  
**Chain rationale**: TDD dùng fixtures; code reviewer chốt JavaScript candidate contract, bounded parsing và error mapping.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-5] Implement bounded RSS/Atom connector với normalized article fields và optional media candidate metadata từ allowlisted feed fields, không fetch article/media URL; Acceptance: RSS/Atom cùng candidate schema; malformed/oversized feed không crash batch; output không có raw HTML/full article/media binary và không gọi AI; Out of scope: Arbitrary webpage scraping, full-text extraction, feed discovery crawler, media download/proxy."
```

## Step 6 — Implement arXiv and Hacker News connectors

**Intent**: Ingest arXiv queries và HN top/new/best qua API chính thức với authority/provenance semantics đúng.  
**Tags**: `impl`  
**Chain rationale**: TDD dùng provider-free fixtures; code reviewer chốt pagination, concurrency, normalized output và retry semantics.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-6] Implement bounded arXiv query và Hacker News top/new/best connectors qua API chính thức, với normalized metadata, retry mapping, fixtures và metrics không lưu body; Acceptance: config ba arXiv query/HN streams không đổi core; HN luôn community-signal; không connector nào fetch PDF, comment hoặc linked website; Out of scope: arXiv PDF parsing, HN comment ingestion, linked-site scraping."
```

## Step 7 — Integrate normalization, deduplication and article lifecycle

**Intent**: Nối connector vào article pipeline idempotent với dedupe, provenance, visibility và media policy gate.  
**Tags**: `impl`, `db`  
**Chain rationale**: Database review kiểm tra indexes/fail-closed queries; code review chốt mapper, lifecycle và `leadMedia` metadata-only.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate article normalization/dedupe/provenance/media. Capture expected source policy/config version trước fetch; final article/checkpoint transaction match canonical lease + exact source active/eligible/version/config. Acceptance: mid-fetch block/change discards candidate, no checkpoint advance; rerun/crash safe; DB không media binary. Out of scope: summary, embedding, source-marker materialization/checkpoint, feed UI."
```

## Step 8 — Deliver feed, detail, saved articles and keyword search

**Intent**: Hoàn thành user content vertical slice, gồm approved image preview/fallback và video link-only, khi AI bị tắt.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt generated JS client/UI states; security review kiểm tra visibility, ownership và media host policy.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement feed/detail/saved/cursor/text search bằng generated JS client. Render remote media chỉ từ exact reviewed public host với no-referrer, safe rel, deployed CSP allowlist và fallback; không tuyên bố browser preview được DNS pin. Acceptance: AI-off flow; hidden/media ngoài policy/IP host và unsafe URL không leak. Out of scope: Semantic ranking, Q&A, personalization."
```

## Step 9 — Add Vietnamese summaries, embeddings and hybrid retrieval

**Intent**: Tạo summary tiếng Việt, versioned BGE-M3 embeddings, hybrid ranking và text fallback qua controlled JavaScript providers.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt jobs/vector metadata; code/security review chốt runtime schemas, policy gate, temporary text và media exclusion.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Register indexing adapter; implement one-task jobs/admin HTTP+UI, expected policy fenced artifacts, retention purgeAfter and BGE-M3 fallback. Sole-owner materialize source marker with exact policy/status/cursor CAS and versioned fan-out identity. Acceptance: pending-provider output discard; N→N+1 worker cannot mutate marker; real ingestion plus indexing backlogs both make bounded progress; top-5/text fallback pass; no full text. Out of scope: Claim citation, fine-tuning, Atlas Vector Search."
```

## Step 10 — Implement grounded Q&A, paragraph citations and refusal

**Intent**: Trả lời tiếng Việt từ retrieved text evidence với paragraph citations, conflict handling và deterministic refusal.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt structured runtime contract; security review kiểm tra prompt injection, visibility, quota, citation và media-only refusal.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement bounded grounded chat và eval. Capture user/session lifecycle before provider; final chat/user-quota append CAS active user + exact sessionVersion + current article state; chat gets 30-day activity retention. Add available/unavailable citation union. Acceptance: delayed provider after user/article transition persists nothing; unavailable with URL/title rejected; citation/refusal gates pass. Out of scope: Tools, live web, claim-level citation, multilingual output."
```

## Step 11 — Complete admin operations, governance and audit UI

**Intent**: Hoàn thiện dashboard overview, article/index/media operations, takedown, users và immutable audit view.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt cleanup/reconciliation; code/security review chốt admin contract, RBAC, media policy, redaction và transitions.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Register deletion same-request recovery; complete admin/governance and own tests/e2e/governance/**. Takedown hides target then bounded atomically updates each chat citation and zero-match verifies; deletion increments sessionVersion, separately proves sessionsRevoked/sessionsDeleted/userQuotaDataDeleted and preserves flags on retry. Acceptance: fake delayed Q&A after takedown/deletion recreates nothing; actual three-queue progress and low-maxJobs fail-safe; reason/status mismatch rejected; audit/PII retention safe. Out of scope: Superadmin, MFA, SSO, partial approval."
```

## Step 12 — Run adversarial verification, deploy and prepare the demo

**Intent**: Chạy release evidence matrix, deploy Vercel/MongoDB và chuẩn bị deterministic demo/local fallback.  
**Tags**: `test`, `security`, `build`, `review`  
**Chain rationale**: E2E/build lanes kiểm chứng system/deploy; security reviewer làm release gate cho policy, secret/full-text và binary-media scans.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full contract/eval/security/E2E, deploy và restore rehearsal. Acceptance: x-persistence/400/503 contract completeness, canonical keys/heartbeat, linked-vs-same recovery, staged queue fairness, ingestion/reconciliation policy races, delayed Q&A deletion/takedown, direct session-deletion and retention evidence, Source/reason/citation conditionals, media browser boundary, DNS-pinned server fetch and secret/fulltext/binary scans all have evidence. Out of scope: Production SLA, unrestricted launch, post-MVP."
```

## Batch execution

Các dòng dưới đây được sắp theo dependency order. Paste tuần tự; không paste Step N+1 trước khi exit criteria của dependency đã có evidence.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Scaffold React/Vite JS/JSX + Express/Vercel; pin tooling và contract/test/eval/db/build scripts. Acceptance: every OpenAPI operation has x-persistence mongo|none; lint rejects missing/unknown; every JSON body has 400 and mongo operation has 503; kill-tests cover HttpsUrl/media host, Source states, account-deletion revoke/delete flags with no request body, decisionReasonCode, expected policy version and unavailable citation/takedown completion; generated JS imports, bundle sạch. Out of scope: DB, auth, business UI, connector/provider thật."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement/apply/verify Mongo auth migrations, register/login/logout/me/preferences, opaque sessions, CSRF/RBAC, subjectType rateLimitBuckets và seeded admin; enforce session idle 24h/absolute 7d, revoked-session 24h TTL, user quota vs shared IP separation, and indexed direct session-delete/zero-match primitive. Acceptance: logout/suspend revoke session; đúng 401/403; DB/log không có token/password rõ. Account deletion workflow belongs Step 11. Out of scope: Source Registry, content, social login, MFA."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/policy/re-review, connector matrix, policyVersion, marker validators và atomic reasonCode audit. Acceptance: ordinary connector-config mutation increments policyVersion exactly once and atomically writes pending reconciliation marker plus audit; contradictory policy/connector, Source attribution true+missing|null|empty, invalid terminal states and IP-literal media host are rejected. Out of scope: Network check thật, job materialization, automatic license interpretation."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement queue registry, canonical resource keys, no-TTL high-water, exact heartbeat, linked/same-request recovery adapters và reserved queue-local fairness; register ingestion only. Test fake three registered due adapters with maxJobs=3 so each receives a reserved slot; fail safely if maxJobs is below registered count. Safe-fetch pin validated public IP per hop. Out of scope: Connector parse, article persistence."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-5] Implement bounded RSS/Atom connector với normalized article fields và optional media candidate metadata từ allowlisted feed fields, không fetch article/media URL; Acceptance: RSS/Atom cùng candidate schema; malformed/oversized feed không crash batch; output không có raw HTML/full article/media binary và không gọi AI; Out of scope: Arbitrary webpage scraping, full-text extraction, feed discovery crawler, media download/proxy."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-6] Implement bounded arXiv query và Hacker News top/new/best connectors qua API chính thức, với normalized metadata, retry mapping, fixtures và metrics không lưu body; Acceptance: config ba arXiv query/HN streams không đổi core; HN luôn community-signal; không connector nào fetch PDF, comment hoặc linked website; Out of scope: arXiv PDF parsing, HN comment ingestion, linked-site scraping."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate article normalization/dedupe/provenance/media. Capture expected source policy/config version trước fetch; final article/checkpoint transaction match canonical lease + exact source active/eligible/version/config. Acceptance: mid-fetch block/change discards candidate, no checkpoint advance; rerun/crash safe; DB không media binary. Out of scope: summary, embedding, source-marker materialization/checkpoint, feed UI."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement feed/detail/saved/cursor/text search bằng generated JS client. Render remote media chỉ từ exact reviewed public host với no-referrer, safe rel, deployed CSP allowlist và fallback; không tuyên bố browser preview được DNS pin. Acceptance: AI-off flow; hidden/media ngoài policy/IP host và unsafe URL không leak. Out of scope: Semantic ranking, Q&A, personalization."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Register indexing adapter; implement one-task jobs/admin HTTP+UI, expected policy fenced artifacts, retention purgeAfter and BGE-M3 fallback. Sole-owner materialize source marker with exact policy/status/cursor CAS and versioned fan-out identity. Acceptance: pending-provider output discard; N→N+1 worker cannot mutate marker; real ingestion plus indexing backlogs both make bounded progress; top-5/text fallback pass; no full text. Out of scope: Claim citation, fine-tuning, Atlas Vector Search."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement bounded grounded chat và eval. Capture user/session lifecycle before provider; final chat/user-quota append CAS active user + exact sessionVersion + current article state; chat gets 30-day activity retention. Add available/unavailable citation union. Acceptance: delayed provider after user/article transition persists nothing; unavailable with URL/title rejected; citation/refusal gates pass. Out of scope: Tools, live web, claim-level citation, multilingual output."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Register deletion same-request recovery; complete admin/governance and own tests/e2e/governance/**. Takedown hides target then bounded atomically updates each chat citation and zero-match verifies; deletion increments sessionVersion, separately proves sessionsRevoked/sessionsDeleted/userQuotaDataDeleted and preserves flags on retry. Acceptance: fake delayed Q&A after takedown/deletion recreates nothing; actual three-queue progress and low-maxJobs fail-safe; reason/status mismatch rejected; audit/PII retention safe. Out of scope: Superadmin, MFA, SSO, partial approval."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full contract/eval/security/E2E, deploy và restore rehearsal. Acceptance: x-persistence/400/503 contract completeness, canonical keys/heartbeat, linked-vs-same recovery, staged queue fairness, ingestion/reconciliation policy races, delayed Q&A deletion/takedown, direct session-deletion and retention evidence, Source/reason/citation conditionals, media browser boundary, DNS-pinned server fetch and secret/fulltext/binary scans all have evidence. Out of scope: Production SLA, unrestricted launch, post-MVP."
```
