# Plan-Orchestrate Result

**Plan**: `docs/plans/techpulse-ai-mvp.md`  
**Lang**: `unknown` — project baseline là JavaScript/JSX; catalogue không có JavaScript-specific reviewer  
**ECC mode**: `plugin`  
**Steps**: 12  
**Scope**: `all`

> Đây là output generative. Mỗi lệnh chỉ chạy khi project owner chủ động paste vào ECC; tài liệu này không tự gọi `/ecc:orchestrate`.

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
/ecc:orchestrate custom "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Scaffold React/Vite JavaScript/JSX + Express JavaScript dùng chung local/Vercel app, pin tooling và thêm OpenAPI validate/generate/runtime-test scripts cùng health endpoint; Acceptance: clean install/build/test xanh; generated JS client/schema import được; health response validate contract và client bundle không lộ server env; Out of scope: Database, authentication, business UI, connector hoặc provider thật."
```

## Step 2 — Build MongoDB core, authentication and session authorization

**Intent**: Thiết lập Mongo migrations, account lifecycle, opaque session, CSRF/RBAC và shared rate-limit buckets.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database reviewer kiểm tra index/TTL/atomic bucket; code/security reviewers chốt serializer, session, CSRF và RBAC.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement Mongo migrations, register/login/logout/me/preferences/deletion, opaque hashed sessions, CSRF/RBAC, rateLimitBuckets và seeded admin theo OpenAPI; Acceptance: logout/suspend revoke session; user/admin trả đúng 401/403; auth success/error validate contract và DB/log không có token hay password rõ; Out of scope: Source Registry, content, social login, password reset, MFA, multi-admin RBAC."
```

## Step 3 — Implement Source Registry and executable rights policy

**Intent**: Tạo Source Registry, text/media policy review, state machine và fail-closed policy gates.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review bảo vệ state/contract; security review chốt rights/media scope, audit redaction và backend authorization.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/review/transitions, policyVersion, audit và admin Sources UI; enforce licenseStatus, llmInputScope, storageScope cùng image/video mode và media host allowlist; Acceptance: unclear rights mặc định metadata-only và media none; blocked/review-needed không active/gọi provider; responses/mutations validate contract và có audit; Out of scope: Network fetch/technical check thật, ingestion job, automatic license interpretation."
```

## Step 4 — Add durable jobs, Mongo leases and SSRF-safe source fetching

**Intent**: Xây durable bounded runner, ingestion jobs, leases, idempotency, cron/admin triggers và SSRF-safe technical checks.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database/code review chốt lease/job contract; security review kiểm tra cron auth, SSRF và shared rate limits.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement generic bounded runner, ingestionJobs, Mongo lease/checkpoint/idempotency, retry/cancel, protected cron, admin triggers và SSRF-safe technical check; Acceptance: duplicate invocation không double side effect; expired lease resume an toàn; private/redirect URL bị chặn và serialized job/error paths validate OpenAPI; Out of scope: Connector parse và article persistence."
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
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate candidates vào Mongo article pipeline với normalization, dedupe, provenance, rights/media snapshot và optional policy-approved leadMedia metadata; Acceptance: rerun không duplicate; ambiguous merge vào review; source/media policy change fail-closed, crash recovery an toàn và DB không có media binary/base64; Out of scope: AI summary, embedding, user feed UI."
```

## Step 8 — Deliver feed, detail, saved articles and keyword search

**Intent**: Hoàn thành user content vertical slice, gồm approved image preview/fallback và video link-only, khi AI bị tắt.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt generated JS client/UI states; security review kiểm tra visibility, ownership và media host policy.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement article feed/detail, saved, cursor/text search bằng generated JS client; render approved image + fallback và video source link với not-analyzed disclosure; Acceptance: login-to-source hoạt động khi AI tắt; hidden/blocked content hoặc media ngoài policy không leak; image error fallback và responses validate contract; Out of scope: Semantic ranking, AI Q&A, personalization/recommendation."
```

## Step 9 — Add Vietnamese summaries, embeddings and hybrid retrieval

**Intent**: Tạo summary tiếng Việt, versioned BGE-M3 embeddings, hybrid ranking và text fallback qua controlled JavaScript providers.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt jobs/vector metadata; code/security review chốt runtime schemas, policy gate, temporary text và media exclusion.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Implement indexingJobs, JS LLM/embedding ports với runtime validation, policy-derived inputs loại media fields, BGE-M3 vectors và hybrid/text fallback; Acceptance: forbidden scope không gọi provider; model/version mismatch không so vector; outage không phá feed/search, top-5 gate đạt và không persist/log temporary full text/media; Out of scope: Claim-level citation, model fine-tuning, Atlas Vector Search, arbitrary admin model picker."
```

## Step 10 — Implement grounded Q&A, paragraph citations and refusal

**Intent**: Trả lời tiếng Việt từ retrieved text evidence với paragraph citations, conflict handling và deterministic refusal.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt structured runtime contract; security review kiểm tra prompt injection, visibility, quota, citation và media-only refusal.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement Mongo-backed Q&A quota, visible text evidence retrieval, untrusted-data envelope, structured paragraphs/citations, refusal/conflict và owned chat deletion; exclude not-analyzed media; Acceptance: citation precision đạt 90%; insufficient hoặc media-only evidence luôn refuse; hidden/blocked/injected evidence không vào answer; Out of scope: Tool-using agent, web browsing at question time, claim-level citations, multilingual output ngoài tiếng Việt."
```

## Step 11 — Complete admin operations, governance and audit UI

**Intent**: Hoàn thiện dashboard overview, article/index/media operations, takedown, users và immutable audit view.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt cleanup/reconciliation; code/security review chốt admin contract, RBAC, media policy, redaction và transitions.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Complete admin overview, article/topic/merge/summary/index/media actions, takedown cleanup, user suspend, audit UI và confirm-reason flows; Acceptance: user bị chặn ở mọi admin operation; media policy change loại preview vi phạm và có audit; takedown/revoke paths validate contract, không lộ secret; Out of scope: Superadmin, MFA, SSO, multi-approver workflow, prompt/model editor."
```

## Step 12 — Run adversarial verification, deploy and prepare the demo

**Intent**: Chạy release evidence matrix, deploy Vercel/MongoDB và chuẩn bị deterministic demo/local fallback.  
**Tags**: `test`, `security`, `build`, `review`  
**Chain rationale**: E2E/build lanes kiểm chứng system/deploy; security reviewer làm release gate cho policy, secret/full-text và binary-media scans.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full contract/test/eval/security matrix, approved-image/fallback/video-link E2E, verify source evidence, seed demo và deploy Vercel/Mongo với runbook; Acceptance: mọi PRD gate có evidence; deployed user/admin/cron/provider-outage paths pass; DB/log/bundle không có secret/full text/media binary; Out of scope: Production SLA, unrestricted public launch, commercial use, hậu-MVP connectors/features."
```

## Batch execution

Các dòng dưới đây được sắp theo dependency order. Paste tuần tự; không paste Step N+1 trước khi exit criteria của dependency đã có evidence.

```bash
/ecc:orchestrate custom "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Scaffold React/Vite JavaScript/JSX + Express JavaScript dùng chung local/Vercel app, pin tooling và thêm OpenAPI validate/generate/runtime-test scripts cùng health endpoint; Acceptance: clean install/build/test xanh; generated JS client/schema import được; health response validate contract và client bundle không lộ server env; Out of scope: Database, authentication, business UI, connector hoặc provider thật."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement Mongo migrations, register/login/logout/me/preferences/deletion, opaque hashed sessions, CSRF/RBAC, rateLimitBuckets và seeded admin theo OpenAPI; Acceptance: logout/suspend revoke session; user/admin trả đúng 401/403; auth success/error validate contract và DB/log không có token hay password rõ; Out of scope: Source Registry, content, social login, password reset, MFA, multi-admin RBAC."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/review/transitions, policyVersion, audit và admin Sources UI; enforce licenseStatus, llmInputScope, storageScope cùng image/video mode và media host allowlist; Acceptance: unclear rights mặc định metadata-only và media none; blocked/review-needed không active/gọi provider; responses/mutations validate contract và có audit; Out of scope: Network fetch/technical check thật, ingestion job, automatic license interpretation."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement generic bounded runner, ingestionJobs, Mongo lease/checkpoint/idempotency, retry/cancel, protected cron, admin triggers và SSRF-safe technical check; Acceptance: duplicate invocation không double side effect; expired lease resume an toàn; private/redirect URL bị chặn và serialized job/error paths validate OpenAPI; Out of scope: Connector parse và article persistence."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-5] Implement bounded RSS/Atom connector với normalized article fields và optional media candidate metadata từ allowlisted feed fields, không fetch article/media URL; Acceptance: RSS/Atom cùng candidate schema; malformed/oversized feed không crash batch; output không có raw HTML/full article/media binary và không gọi AI; Out of scope: Arbitrary webpage scraping, full-text extraction, feed discovery crawler, media download/proxy."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-6] Implement bounded arXiv query và Hacker News top/new/best connectors qua API chính thức, với normalized metadata, retry mapping, fixtures và metrics không lưu body; Acceptance: config ba arXiv query/HN streams không đổi core; HN luôn community-signal; không connector nào fetch PDF, comment hoặc linked website; Out of scope: arXiv PDF parsing, HN comment ingestion, linked-site scraping."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate candidates vào Mongo article pipeline với normalization, dedupe, provenance, rights/media snapshot và optional policy-approved leadMedia metadata; Acceptance: rerun không duplicate; ambiguous merge vào review; source/media policy change fail-closed, crash recovery an toàn và DB không có media binary/base64; Out of scope: AI summary, embedding, user feed UI."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement article feed/detail, saved, cursor/text search bằng generated JS client; render approved image + fallback và video source link với not-analyzed disclosure; Acceptance: login-to-source hoạt động khi AI tắt; hidden/blocked content hoặc media ngoài policy không leak; image error fallback và responses validate contract; Out of scope: Semantic ranking, AI Q&A, personalization/recommendation."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Implement indexingJobs, JS LLM/embedding ports với runtime validation, policy-derived inputs loại media fields, BGE-M3 vectors và hybrid/text fallback; Acceptance: forbidden scope không gọi provider; model/version mismatch không so vector; outage không phá feed/search, top-5 gate đạt và không persist/log temporary full text/media; Out of scope: Claim-level citation, model fine-tuning, Atlas Vector Search, arbitrary admin model picker."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement Mongo-backed Q&A quota, visible text evidence retrieval, untrusted-data envelope, structured paragraphs/citations, refusal/conflict và owned chat deletion; exclude not-analyzed media; Acceptance: citation precision đạt 90%; insufficient hoặc media-only evidence luôn refuse; hidden/blocked/injected evidence không vào answer; Out of scope: Tool-using agent, web browsing at question time, claim-level citations, multilingual output ngoài tiếng Việt."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Complete admin overview, article/topic/merge/summary/index/media actions, takedown cleanup, user suspend, audit UI và confirm-reason flows; Acceptance: user bị chặn ở mọi admin operation; media policy change loại preview vi phạm và có audit; takedown/revoke paths validate contract, không lộ secret; Out of scope: Superadmin, MFA, SSO, multi-approver workflow, prompt/model editor."
/ecc:orchestrate custom "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full contract/test/eval/security matrix, approved-image/fallback/video-link E2E, verify source evidence, seed demo và deploy Vercel/Mongo với runbook; Acceptance: mọi PRD gate có evidence; deployed user/admin/cron/provider-outage paths pass; DB/log/bundle không có secret/full text/media binary; Out of scope: Production SLA, unrestricted public launch, commercial use, hậu-MVP connectors/features."
```
