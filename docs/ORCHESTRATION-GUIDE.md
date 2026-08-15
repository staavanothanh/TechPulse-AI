# Plan-Orchestrate Result

**Plan**: `docs/plans/techpulse-ai-mvp.md`  
**Lang**: `unknown` — project baseline là JavaScript/JSX; catalogue không có JavaScript-specific reviewer  
**ECC mode**: `plugin`  
**Steps**: 12  
**Scope**: `all`

> Đây là reference generative về thứ tự và chain review, không phải bộ command thực thi. Authority vẫn là blueprint và tài liệu Plan-of-Record.

## Execution metadata

- **Prerequisite:** chỉ chạy một step khi dependency trong blueprint có handoff/verification evidence. Baseline v1.7 là historical prerequisite; current authority là v1.8, Steps 1–11 đã implement và Step 12 chờ ADR-0013 remediation/release evidence.
- **Authority:** các reference chain dưới đây không thay thế tasks/exit criteria trong blueprint hoặc OpenAPI/PRD/Data Model.
- **Ownership collision:** Step 3 sở hữu source marker; Step 4 sở hữu queue/maintenance registry, generic runner, leases và ingestion; Step 7 chỉ tạo article/intent, không materialize marker; Step 9 đăng ký indexing/indexing cleanup + sole marker materialization/checkpoint; Step 10 đăng ký answer-attempt cleanup; Step 11 sở hữu `techpulse_governance` migrations, deletion/governance cleanup và `tests/e2e/governance/**`; Step 12 sở hữu backup sidecar/restore rehearsal. Không sửa migration/file step khác nếu chưa handoff.
- **Safe parallel lanes:** chỉ Steps 5/6 có thể chạy song song sau Step 4. Phần Step 11 không chạm Q&A có thể chuẩn bị sau Step 9, nhưng Step 11 exit chờ Step 10 để chạy delayed-write lifecycle races; Step 12 chờ Step 11.
- **Cutline:** coding-agent support cho phép giữ target scope; chỉ mutation theo milestone thực tế. Không cắt contract/security/source policy/citation/fencing/audit/deletion completion.

## Steps overview

| # | Title | Tags | Chain |
|---|---|---|---|
| 1 | Scaffold application and contract toolchain | impl, build | `ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer` |
| 2 | Build MongoDB core, authentication and session authorization | impl, db, security | `ecc:tdd-guide,ecc:backend-patterns,ecc:code-reviewer,ecc:security-reviewer` |
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

```text
Reference chain: "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Historical Step-1 chain: validate current 55-operation OpenAPI and preserve closed TP-M01 x-persistence/400/503 plus 413/415 gates. Keep same-origin no-CORS, exact Origin, __Host-techpulse_session/no-store, strict target/JSON/query ingress and generated /answers idempotency contract. Do not treat historical 54-operation evidence as current contract status."
```

## Step 2 — Build MongoDB core, authentication and session authorization

**Intent**: Thiết lập Mongo migrations, account lifecycle, opaque session, CSRF/RBAC và shared rate-limit buckets.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Backend patterns và TDD chốt repository/index/atomic bucket; security và code reviewers chốt serializer, session, CSRF và RBAC. Không dùng database-reviewer vì role hiện tại chuyên PostgreSQL, không phải MongoDB authority.

```text
Reference chain: "ecc:tdd-guide,ecc:backend-patterns,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement Mongo auth/session/CSRF/RBAC và trusted-IP limits. Use one transaction-capable runtime identity/session: domain privileges, audit insert/find only; define Step-11 suppression role extension, separate maintenance credential. Test real role: audit insert denial rolls back domain mutation, update/delete denied. Verify cookie/Origin/cache, HMAC rotation, deadline indexes và closed tombstone. Account deletion belongs Step 11. Out of scope: source/content/MFA."
```

## Step 3 — Implement Source Registry and executable rights policy

**Intent**: Tạo Source Registry, text/media policy review, state machine và fail-closed policy gates.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review bảo vệ state/contract; security review chốt rights/media scope, audit redaction và backend authorization.

```text
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/policy/re-review, connector matrix, policyVersion, marker validators và atomic reasonCode audit. Acceptance: ordinary connector-config mutation increments policyVersion exactly once and atomically writes pending reconciliation marker plus audit; contradictory policy/connector, Source attribution true+missing|null|empty, invalid terminal states and IP-literal media host are rejected. Out of scope: Network check thật, job materialization, automatic license interpretation."
```

## Step 4 — Add durable jobs, Mongo leases and SSRF-safe source fetching

**Intent**: Xây durable bounded runner, ingestion jobs, leases, idempotency, cron/admin triggers và SSRF-safe technical checks.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database/code review chốt lease/job contract; security review kiểm tra cron auth, SSRF và shared rate limits.

```text
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement queue/maintenance registry, canonical leases, recovery và bounded fairness. Add normal/aged/deadline indexes with explain; fixed machine-only maintenance tasks batch<=100. Safe fetch pins public IP per hop and bounds wire 1MiB, decoded 4MiB, ratio 20 before connector parse. Test three due adapters, low-maxJobs fail-safe and no caller-controlled cleanup predicate. Out of scope: article persistence."
```

## Step 5 — Implement the RSS/Atom connector

**Intent**: Parse allowlisted RSS/Atom thành normalized candidates, gồm optional media metadata nhưng không fetch linked content/binary.  
**Tags**: `impl`  
**Chain rationale**: TDD dùng fixtures; code reviewer chốt JavaScript candidate contract, bounded parsing và error mapping.

```text
Reference chain: "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-5] Implement RSS/Atom parser chỉ cho allowlisted XML content type. Forbid DOCTYPE, entity expansion, XInclude và network resolver; bound depth 64, nodes 20k, items 100, field 20k, parse deadline 2s. Normalize metadata/media candidates nhưng không fetch article/media, không giữ raw HTML/full text/binary và không gọi AI. Test malformed/entity/decompression-limit fixtures. Out of scope: scraping/discovery/proxy."
```

## Step 6 — Implement arXiv and Hacker News connectors

**Intent**: Ingest arXiv queries và HN top/new/best qua API chính thức với authority/provenance semantics đúng.  
**Tags**: `impl`  
**Chain rationale**: TDD dùng provider-free fixtures; code reviewer chốt pagination, concurrency, normalized output và retry semantics.

```text
Reference chain: "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-6] Implement bounded arXiv và Hacker News API connectors với normalized metadata/retry fixtures. Mark mọi HN item community-signal và prove nó chỉ xuất hiện feed/search, không bao giờ thành Q&A evidence. Không fetch arXiv PDF, HN comment, linked website hoặc persist provider body. Out of scope: PDF parsing, comment ingestion, linked-site scraping."
```

## Step 7 — Integrate normalization, deduplication and article lifecycle

**Intent**: Nối connector vào article pipeline idempotent với dedupe, provenance, visibility và media policy gate.  
**Tags**: `impl`, `db`  
**Chain rationale**: Database review kiểm tra indexes/fail-closed queries; code review chốt mapper, lifecycle và `leadMedia` metadata-only.

```text
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate article normalization/dedupe/provenance/media. Capture expected source policy/config version trước fetch; final article/checkpoint transaction match canonical lease + exact source active/eligible/version/config. Acceptance: mid-fetch block/change discards candidate, no checkpoint advance; rerun/crash safe; DB không media binary. Out of scope: summary, embedding, source-marker materialization/checkpoint, feed UI."
```

## Step 8 — Deliver feed, detail, saved articles and keyword search

**Intent**: Hoàn thành user content vertical slice, gồm approved image preview/fallback và video link-only, khi AI bị tắt.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt generated JS client/UI states; security review kiểm tra visibility, ownership và media host policy.

```text
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement feed/detail/saved/cursor/text search bằng generated JS client. Render remote media chỉ từ exact reviewed public host với no-referrer, safe rel, deployed CSP allowlist và fallback; không tuyên bố browser preview được DNS pin. Acceptance: AI-off flow; hidden/media ngoài policy/IP host và unsafe URL không leak. Out of scope: Semantic ranking, Q&A, personalization."
```

## Step 9 — Add Vietnamese summaries, embeddings and hybrid retrieval

**Intent**: Tạo summary tiếng Việt, compatibility-pinned embeddings, hybrid ranking và text fallback qua controlled JavaScript provider routes.
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt jobs/vector metadata; code/security review chốt runtime schemas, policy gate, temporary text và media exclusion.

```text
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Implement ADR-0013 provider config graph without vendor/model strings in business/bootstrap routing. Validate installed adapter, provider failure domain, credential admission domain, route and workload refs. Add route/provider-domain circuits; classify model vs provider retryable failure; cap generation at two attempts. Require privacy-equivalent candidates and embedding artifactCompatibilityId or text fallback. Preserve indexing/reconciliation fences and no full text."
```

## Step 10 — Implement grounded Q&A, paragraph citations and refusal

**Intent**: Trả lời tiếng Việt từ retrieved text evidence với paragraph citations, conflict handling và deterministic refusal.  
**Tags**: `impl`, `security`  
**Chain rationale**: Code review chốt structured runtime contract; security review kiểm tra prompt injection, visibility, quota, citation và media-only refusal.

```text
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement Q&A privacy admission, 24h answerAttempts idempotency/one quota and ADR-0013 workload routing. Same immutable admitted input may use one model or cross-provider fallback according to failure class; policy/privacy/schema/support/ambiguous errors never fallback. Persist only after active-user/session/article fence and supported evidence blocks. Test max-attempt cap, provider outage, sensitive-input, delayed deletion/takedown and no raw question. Out of scope: tools/live web."
```

## Step 11 — Complete admin operations, governance and audit UI

**Intent**: Hoàn thiện dashboard overview, article/index/media operations, takedown, users và immutable audit view.  
**Tags**: `impl`, `db`, `security`  
**Chain rationale**: Database review chốt cleanup/reconciliation; code/security review chốt admin contract, RBAC, media policy, redaction và transitions.

```text
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Complete governance/admin across pre-created techpulse_app + techpulse_governance DBs. Atomically write terminal signed suppression with audit using one client/session. Actual Atlas runtime-role probe must commit/rollback across both DBs; failure blocks handoff, no best-effort fallback. Preserve deletion flags, quota/tombstone/citation zero-match, fixed cleanup and signed checkpoint. Out of scope: superadmin/MFA/SSO."
```

## Step 12 — Run adversarial verification, deploy and prepare the demo

**Intent**: Chạy release evidence matrix, deploy Vercel/MongoDB và chuẩn bị deterministic demo/local fallback.  
**Tags**: `test`, `security`, `build`, `review`  
**Chain rationale**: E2E/build lanes kiểm chứng system/deploy; security reviewer làm release gate cho policy, secret/full-text và binary-media scans.

```text
Reference chain: "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full gates and isolated restore. Block release unless ADR-0013 remediation proves model fallback, full provider-domain outage fallback, terminal no-fallback classes, privacy equivalence, max-attempt cap and embedding compatibility/text degradation. Verify Atlas mirrored capability probes, account-deletion inline recovery index, governance sidecar/checkpoints/manifests, secret/fulltext/binary scans. Out of scope: production SLA/unrestricted launch."
```

## Batch execution

Các chain dưới đây chỉ là reference theo dependency order, không phải command để chạy. Chỉ bắt đầu Step N+1 khi exit criteria của dependency đã có evidence.

```text
Reference chain: "ecc:tdd-guide,ecc:build-error-resolver,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-1] Historical Step-1 chain: validate current 55-operation OpenAPI and preserve closed TP-M01 x-persistence/400/503 plus 413/415 gates. Keep same-origin no-CORS, exact Origin, __Host-techpulse_session/no-store, strict target/JSON/query ingress and generated /answers idempotency contract. Do not treat historical 54-operation evidence as current contract status."
Reference chain: "ecc:tdd-guide,ecc:backend-patterns,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-2] Implement Mongo auth/session/CSRF/RBAC và trusted-IP limits. Use one transaction-capable runtime identity/session: domain privileges, audit insert/find only; define Step-11 suppression role extension, separate maintenance credential. Test real role: audit insert denial rolls back domain mutation, update/delete denied. Verify cookie/Origin/cache, HMAC rotation, deadline indexes và closed tombstone. Account deletion belongs Step 11. Out of scope: source/content/MFA."
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-3] Implement source CRUD/policy/re-review, connector matrix, policyVersion, marker validators và atomic reasonCode audit. Acceptance: ordinary connector-config mutation increments policyVersion exactly once and atomically writes pending reconciliation marker plus audit; contradictory policy/connector, Source attribution true+missing|null|empty, invalid terminal states and IP-literal media host are rejected. Out of scope: Network check thật, job materialization, automatic license interpretation."
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-4] Implement queue/maintenance registry, canonical leases, recovery và bounded fairness. Add normal/aged/deadline indexes with explain; fixed machine-only maintenance tasks batch<=100. Safe fetch pins public IP per hop and bounds wire 1MiB, decoded 4MiB, ratio 20 before connector parse. Test three due adapters, low-maxJobs fail-safe and no caller-controlled cleanup predicate. Out of scope: article persistence."
Reference chain: "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-5] Implement RSS/Atom parser chỉ cho allowlisted XML content type. Forbid DOCTYPE, entity expansion, XInclude và network resolver; bound depth 64, nodes 20k, items 100, field 20k, parse deadline 2s. Normalize metadata/media candidates nhưng không fetch article/media, không giữ raw HTML/full text/binary và không gọi AI. Test malformed/entity/decompression-limit fixtures. Out of scope: scraping/discovery/proxy."
Reference chain: "ecc:tdd-guide,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-6] Implement bounded arXiv và Hacker News API connectors với normalized metadata/retry fixtures. Mark mọi HN item community-signal và prove nó chỉ xuất hiện feed/search, không bao giờ thành Q&A evidence. Không fetch arXiv PDF, HN comment, linked website hoặc persist provider body. Out of scope: PDF parsing, comment ingestion, linked-site scraping."
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-7] Integrate article normalization/dedupe/provenance/media. Capture expected source policy/config version trước fetch; final article/checkpoint transaction match canonical lease + exact source active/eligible/version/config. Acceptance: mid-fetch block/change discards candidate, no checkpoint advance; rerun/crash safe; DB không media binary. Out of scope: summary, embedding, source-marker materialization/checkpoint, feed UI."
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-8] Implement feed/detail/saved/cursor/text search bằng generated JS client. Render remote media chỉ từ exact reviewed public host với no-referrer, safe rel, deployed CSP allowlist và fallback; không tuyên bố browser preview được DNS pin. Acceptance: AI-off flow; hidden/media ngoài policy/IP host và unsafe URL không leak. Out of scope: Semantic ranking, Q&A, personalization."
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-9] Implement ADR-0013 provider config graph without vendor/model strings in business/bootstrap routing. Validate installed adapter, provider failure domain, credential admission domain, route and workload refs. Add route/provider-domain circuits; classify model vs provider retryable failure; cap generation at two attempts. Require privacy-equivalent candidates and embedding artifactCompatibilityId or text fallback. Preserve indexing/reconciliation fences and no full text."
Reference chain: "ecc:tdd-guide,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-10] Implement Q&A privacy admission, 24h answerAttempts idempotency/one quota and ADR-0013 workload routing. Same immutable admitted input may use one model or cross-provider fallback according to failure class; policy/privacy/schema/support/ambiguous errors never fallback. Persist only after active-user/session/article fence and supported evidence blocks. Test max-attempt cap, provider outage, sensitive-input, delayed deletion/takedown and no raw question. Out of scope: tools/live web."
Reference chain: "ecc:tdd-guide,ecc:database-reviewer,ecc:code-reviewer,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-11] Complete governance/admin across pre-created techpulse_app + techpulse_governance DBs. Atomically write terminal signed suppression with audit using one client/session. Actual Atlas runtime-role probe must commit/rollback across both DBs; failure blocks handoff, no best-effort fallback. Preserve deletion flags, quota/tombstone/citation zero-match, fixed cleanup and signed checkpoint. Out of scope: superadmin/MFA/SSO."
Reference chain: "ecc:tdd-guide,ecc:e2e-runner,ecc:build-error-resolver,ecc:security-reviewer" "[Plan: docs/plans/techpulse-ai-mvp.md#step-12] Run full gates and isolated restore. Block release unless ADR-0013 remediation proves model fallback, full provider-domain outage fallback, terminal no-fallback classes, privacy equivalence, max-attempt cap and embedding compatibility/text degradation. Verify Atlas mirrored capability probes, account-deletion inline recovery index, governance sidecar/checkpoints/manifests, secret/fulltext/binary scans. Out of scope: production SLA/unrestricted launch."
```
