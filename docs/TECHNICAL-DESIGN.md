# TechPulse AI — Technical Design

> Trạng thái: Plan-of-Record architecture contract
> Phiên bản: 1.6
> Cập nhật: 08/08/2026  
> Product contract: [PRD.md](./PRD.md)  
> Persistence contract: [DATA-MODEL.md](./DATA-MODEL.md)  
> HTTP contract: [contracts/openapi.json](./contracts/openapi.json)  
> Decision log: [adr/README.md](./adr/README.md)

## 1. Mục tiêu thiết kế

Kiến trúc phải chứng minh được một vertical slice hoàn chỉnh và vẫn đủ rõ để bốn phần React, Node.js, MongoDB và AI có giá trị kỹ thuật riêng. Baseline tối ưu cho một project owner làm cùng coding agent, 250–400 article và tối thiểu 10 user đồng thời trong buổi demo; tốc độ agent không làm yếu contract/security gate.

Các thuộc tính bắt buộc:

1. provenance và source policy không bị mất từ ingestion đến citation;
2. browser, nguồn ngoài và AI provider đều nằm ngoài trust boundary;
3. mọi state bền vững nằm trong MongoDB, không nằm trong memory/filesystem của Vercel Function;
4. cron hoặc request bị gửi lặp không tạo side effect trùng;
5. text search vẫn hoạt động khi embedding/LLM provider lỗi;
6. chỉ article `published` từ source hiện còn hợp lệ được đi vào user surface hoặc AI context;
7. contract HTTP có thể dùng chung để sinh JavaScript client/JSDoc, mock và kiểm tra response runtime;
8. media nguồn chỉ được serialize khi current Source Registry policy cho phép và không trở thành AI evidence khi chưa được phân tích hợp lệ.

## 2. Non-goals kiến trúc

- Không dùng microservice, event bus, Redis, dedicated queue hoặc vector database trong MVP.
- Không chạy process nền dài hạn, `node-cron` hoặc queue trong memory.
- Không tạo crawler tùy ý; connector chỉ làm việc với RSS/Atom, arXiv API và Hacker News API.
- Không lưu raw HTML hoặc full text lâu dài.
- Không tải về/rehost binary ảnh/video, không tạo arbitrary media proxy và không phân tích ảnh/video bằng AI trong MVP.
- Không dùng TypeScript/TSX trong MVP; implementation dùng `.js`/`.jsx`, runtime validation và test.
- Không xây abstraction chung cho mọi loại AI hoặc mọi nguồn có thể có trong tương lai; chỉ định nghĩa boundary cần cho ba connector và hai loại provider hiện tại.
- Không coi Vercel Hobby là production SLA.

## 3. System context

```text
┌──────────────┐      HTTPS / JSON       ┌──────────────────────────────┐
│ React client │ ──────────────────────► │ Express API on Vercel        │
│ user/admin   │ ◄────────────────────── │ validation + auth + services │
└──────────────┘                         └──────────────┬───────────────┘
                                                     │
                      ┌──────────────────────────────┼──────────────────────┐
                      │                              │                      │
                      ▼                              ▼                      ▼
             ┌─────────────────┐           ┌────────────────┐     ┌────────────────┐
             │ MongoDB Atlas   │           │ Source APIs    │     │ AI providers   │
             │ system of record│           │ RSS/arXiv/HN   │     │ LLM/embedding  │
             └─────────────────┘           └────────────────┘     └────────────────┘
                      ▲
                      │ protected daily invocation
             ┌────────┴────────┐
             │ Vercel Cron     │
             └─────────────────┘
```

Trust rules:

- React chỉ là consumer; không quyết định role, source policy hoặc visibility.
- Express là policy enforcement point duy nhất.
- MongoDB là system of record; output provider không tự trở thành dữ liệu hợp lệ nếu chưa qua validation.
- Source payload và text được bao như quoted evidence, không bao giờ được diễn giải là instruction.
- Browser có thể tải ảnh trực tiếp từ host đã duyệt; URL media vẫn là untrusted data và bị giới hạn bởi media policy/CSP.

## 4. Deployment topology

Một Vercel project chứa hai deployable surface:

```text
Vercel project
├── static React/Vite build
└── Node.js Express Function
    ├── /api/v1/*
    └── /api/internal/cron/*
```

MongoDB Atlas giữ users, sessions, shared rate-limit buckets, source registry, articles, jobs, leases, chat, content takedown, account-deletion workflow và audit. Vercel Environment Variables giữ Mongo URI, session/CSRF/HMAC secret, cron secret và provider keys. Không có secret trong React bundle.

Local development dùng cùng Express application và Mongo repository; chỉ entrypoint khác production. Mục tiêu layout khi scaffold:

```text
api/index.js                  # Vercel entrypoint rất mỏng
client/                       # React/Vite application
server/
├── app.js                    # Express composition root
├── http/                     # route/controller/middleware
├── application/              # use cases
├── domain/                   # entity, state transition, policy
├── repositories/             # repository ports + Mongo adapters
├── connectors/               # RSS, arXiv, Hacker News
├── providers/                # LLM và embedding adapters
└── jobs/                     # bounded runners, leases, checkpoints
shared/generated/
├── api-client.js             # JavaScript client sinh từ OpenAPI
└── api-schema.js             # runtime/JSDoc contract, không sửa tay
jsconfig.json                 # editor/module aliases; không phải TypeScript build
scripts/                      # seed admin/source/demo
docs/contracts/openapi.json   # canonical HTTP contract
```

Đây là JavaScript/JSX modular monolith: module tách theo responsibility nhưng chạy trong cùng application và database. JSDoc hoặc `// @ts-check` có thể hỗ trợ editor, nhưng MVP không tạo `.ts`/`.tsx` và không phụ thuộc TypeScript compiler.

## 5. Component boundaries

| Component | Trách nhiệm | Không được làm |
|---|---|---|
| React client | Render feed/admin, giữ UI state, gọi generated JavaScript client | Tự suy role, gọi source/provider trực tiếp |
| HTTP layer | Parse/validate request, auth, CSRF, rate-limit, serialize contract | Chứa business rule hoặc Mongo query rải rác |
| Application services | Điều phối use case và transaction boundary | Phụ thuộc Express object |
| Domain policy | State transition, visibility, rights scope, dedupe decision | Network hoặc database I/O |
| Repositories | Truy cập MongoDB và enforce query predicate chung | Trả document thô ra HTTP |
| Connectors | Fetch nguồn allowlisted và trả normalized candidate | Gọi LLM, tự nâng license scope |
| Content policy gate | Tạo allowed provider input từ source/article policy | Dùng text ngoài scope hoặc bỏ qua blocked state |
| Media policy gate | Kiểm tra mode/host/current policy, tạo `leadMedia` DTO hoặc null | Fetch binary, proxy URL tùy ý hoặc biến media chưa xử lý thành evidence |
| LLM adapter | Summary/answer theo schema, timeout và fallback hợp lệ | Fallback cho policy/validation error, bật tool |
| Embedding adapter | Vector theo pinned model/version/dimensions | Trộn vector khác version |
| Job runner | Lease, checkpoint, bounded work, counter, retry classification | Queue trong memory hoặc chạy vô hạn |
| Audit service | Ghi admin mutation append-only | Lưu secret/full text/private chat |

### 5.1. Dependency direction

```text
HTTP/Jobs → Application → Domain
                    ↓
        repository/connector/provider ports
                    ↑
        Mongo/external provider adapters
```

Domain không import Express, MongoDB SDK hoặc provider SDK. Chỉ các boundary có khả năng thay đổi hoặc cần fake trong test mới dùng interface; không tạo repository/service wrapper cho logic một lần dùng.

## 6. Luồng nghiệp vụ chính

### 6.1. Đăng nhập bằng server-side session

```text
Browser → POST /auth/login
API → validate + rate limit + verify password hash
API → create hashed session record in MongoDB
API → Set-Cookie HttpOnly/Secure/SameSite
API → return User + CSRF token
Browser reload → GET /api/v1/me + cookie
API → return User + session-bound CSRF token
Browser → state-changing request + cookie + X-CSRF-Token
API → session lookup → status/role/CSRF authorization
```

- Cookie chứa opaque session token; MongoDB chỉ lưu hash của token.
- CSRF token chỉ giữ trong memory của React và được bootstrap lại qua `/me`; không lưu localStorage và không yêu cầu login lại sau reload.
- Khi user bị suspend/deleted, session lookup kiểm tra user state và mọi session được revoke.
- Route admin dùng cùng session nhưng thêm `role=admin` ở backend.

### 6.2. Source onboarding

```text
Admin creates draft source
→ technical check fetches a bounded sample through SSRF guard
→ result stored; source becomes testing/review-needed
→ admin records publisher/terms/license/evidence/scopes
→ compatibility validator checks license/input/storage/media as one policy unit
→ server records reviewedBy/reviewedAt
→ admin activates source
```

Technical check không được tự phê duyệt rights và `passed` phải có server timestamp/host/content-type/sample evidence. Source activation là state transition có audit; source `blocked` hoặc `review-needed` không thể active. Terms change dùng dedicated re-review operation: pause → review-needed → policyVersion++ → atomically persist a pending reconciliation marker on the source. Query-time policy fail-closed ngay; Step 9 mới materialize marker thành bounded reconciliation jobs.

### 6.3. Cron due-work và manual ingestion

```text
Vercel Cron GET /api/internal/cron/due-work
→ authenticate separate trust boundary
→ idempotently materialize scheduled ingestion intents for active sources
→ recover a bounded batch of expired active leases/running jobs
→ select due work across ingestion/indexing/account-deletion queues
→ return aggregate recovery + per-queue counters

Admin POST ingestion trigger
→ authenticate cookie + admin role + CSRF
→ derive/validate actor-scoped idempotency key + request hash
→ create or reuse job record
→ invoke the same queue runner through a separate adapter

Selected job
→ acquire persistent lease ownership; increment generationHighWater
→ capture expectedSourcePolicyVersion before external fetch
→ connector fetches bounded batch
→ normalize + canonicalize + dedupe
→ transactionally fence and upsert article only if exact source ID/version/active/eligible/config still match
→ run allowed summary/index work within request budget
→ checkpoint cursor/counters only after exact fence touch
→ atomically mark succeeded/partial/failed + clear active ownership; preserve generationHighWater
```

Job runner dừng trước execution deadline bằng safety margin. Phần còn lại tồn tại với `availableAt` và checkpoint để due-work coordinator resume qua manual run hoặc lần cron sau. Coordinator queue-agnostic nhưng response chỉ trả aggregate counters; chi tiết job đọc qua admin queue endpoints. `partial` không rollback dữ liệu đã ghi; mỗi item operation idempotent và stale worker không commit được sau khi mất generation. Nếu source bị block, mất eligibility hoặc policy/connector config đổi trong lúc fetch, final CAS miss discard candidate và không advance checkpoint/counter; safe workflow error là `policy_version_mismatch`.

### 6.4. Summary và embedding

```text
One article + one artifact task pending
→ capture expectedSourcePolicyVersion and load current source policy
→ policy gate selects metadata/excerpt/fulltext-temporary/none
→ optional safe fetch + main-content extraction in memory
→ LLM summary schema validation
→ transactionally re-check fence + current policy version
→ persist short summary + basis + model + input hash + source policy version
→ embedding gate selects allowed derived text
→ BGE-M3 request
→ validate 1024 dimensions
→ transactionally re-check fence + current policy version
→ persist vector + model/version/hash + source policy version
→ discard temporary text
```

Mỗi indexing job chỉ sở hữu một task để summary và embedding có state/retry độc lập. Nếu policy là `none`, provider không được gọi. Nếu source policy đổi sau provider call, commit phải fail với safe `policy_version_mismatch`, discard output và để current reconciliation tạo work phù hợp; không persist artifact sinh dưới policy cũ. Nếu summary lỗi, article có thể vẫn publish với summary state rõ ràng nếu metadata hợp lệ; UI không giả vờ summary đã sẵn sàng. Nếu embedding lỗi, text search tiếp tục hoạt động. Artifact chuyển `removed` phải unset content/model/hash/error/policy-version; public serializer chỉ trả summary khi `ready`.

### 6.5. Feed/search/detail

Mọi repository query cho user surface phải dùng cùng visibility predicate:

```text
article.status == published
AND current source.operationalStatus == active
AND current source.licenseStatus IN [permitted, metadata-only]
```

Rights snapshot trên article phục vụ audit, còn Source Registry hiện tại quyết định có tiếp tục được hiển thị/xử lý hay không. Source transition đồng thời ghi durable reconciliation marker; query-time predicate là lớp bảo vệ tức thời trong khoảng thời gian Step 9 chưa materialize/hoàn tất cleanup jobs.

Worker reconciliation capture `requiredPolicyVersion` rồi mọi claim, cursor, error, retry và completion CAS exact source policy version + marker version + expected status/cursor. Fan-out identity gồm `sourceId/articleId/task/policyVersion`; worker N gặp marker N+1 phải dừng mà không mutate marker mới. Runtime chỉ chấp nhận completion khi `completedPolicyVersion == requiredPolicyVersion`.

Keyword search chạy trước hoặc độc lập. Hybrid search chỉ thêm embedding score cho candidates có cùng model/dimensions/version; khi provider hoặc vector thiếu, response ghi `fallbackUsed=true` và dùng text score.

### 6.6. Hiển thị ảnh/video nguồn

```text
Connector returns candidate media metadata only
→ normalizer rejects non-HTTPS/invalid URL
→ media policy gate reloads current source policy
→ allowed image becomes remote-preview metadata
→ important video becomes link-only metadata
→ MongoDB stores URL/credit/alt/policy snapshot, never binary
→ API serializes LeadMedia or null
→ React lazy-loads image or renders source link
→ image error/policy denial falls back to TechPulse-owned visual
```

- `mediaPolicy` độc lập với `llmInputScope`: quyền xử lý text không tự cấp quyền hiển thị ảnh/video và ngược lại.
- MVP chỉ có `imageMode=none|remote-preview` và `videoMode=none|link-only`. Official embed, transcript/vision analysis và media caching nằm hậu MVP.
- Không tin tùy ý `og:image`; candidate phải đến từ field connector cho phép, dùng HTTPS và canonical reviewed public hostname khớp `allowedHosts`. Wildcard, IP literal, localhost/single-label host và private/special-use resolution bị cấm.
- React đặt `alt`, credit/attribution khi bắt buộc, `loading=lazy`, `referrerPolicy=no-referrer` và fallback khi hotlink lỗi. CSP `img-src` chỉ gồm `'self'` cùng exact reviewed HTTPS hosts được deploy; không dùng wildcard hoặc blanket `https:`. Backend không proxy ảnh chỉ để né hotlink/CORS.
- DNS pinning của server chỉ bảo vệ technical check/safe fetch do server thực hiện; nó không bảo vệ request remote-preview phát trực tiếp từ browser. Browser preview vẫn có rủi ro DNS/host thay đổi nên không gửi credential/referrer, không đọc pixel/canvas, không coi media là trusted evidence và luôn có fallback.
- `mediaEvidenceStatus=not-analyzed` luôn được trả với media MVP. Summary, embedding và Q&A không được dùng chi tiết chỉ nhìn thấy/nghe thấy trong media đó.

### 6.7. AI Q&A có citation

```text
Question + article/topic/time scope
→ validate + quota
→ capture userId + expectedSessionVersion
→ retrieve only visible/allowed candidates
→ build evidence blocks with stable citation IDs
→ system instruction separates evidence as untrusted data
→ LLM returns structured paragraphs + cited evidence IDs
→ server validates every cited ID and coverage
→ invalid/insufficient output becomes refusal or one bounded retry
→ final transaction rechecks active user/session version + article/takedown lifecycle
→ persist/return answer without copied full text, or discard provider result on CAS miss
```

Provider không được cấp tool. Model không được tự tạo URL; serializer lấy citation metadata từ MongoDB bằng evidence ID đã kiểm tra. Contract dùng hai shape loại trừ nhau: `answered` có paragraph/citation không rỗng và `refusalReason=null`; `refused` có arrays rỗng và reason code. Runtime kiểm tra mọi paragraph citation ID resolve tới retrieved article đang visible trước persistence/response. Final chat/quota write conditionally touch `users._id`, `status=active`, exact captured `sessionVersion` và current article/takedown visibility trong cùng transaction; account deletion hoặc takedown thắng race thì output provider bị bỏ và không được tái tạo user data/citation.

### 6.8. Takedown

```text
Admin approves complete requestedScope
→ mark target hidden/removed first
→ remove media reference/summary/vector from user and retrieval surfaces
→ query affected chat sessions by indexed citation target in bounded batches
→ atomically convert each chat document citation to unavailable shape without URL/title
→ zero-match scan confirms no available citation remains for target
→ delete fields/documents required by the complete requestedScope
→ revoke related cached/generated artifacts
→ mark completed only after historical citation redaction and requested-scope verification
→ append audit record
```

Visibility bị tắt trước thao tác xóa để tránh race làm dữ liệu tiếp tục xuất hiện. MVP content takedown chỉ có source/article và all-or-nothing approval; không có `user-data`, `account-data` hoặc partial approval. Historical citation có hai branch: `available` giữ source metadata, `unavailable` cấm `originalUrl/titleOriginal/publishedAt` và có reason allowlisted. “Atomic” nghĩa là update một `chatSessions` document trong một write/transaction ngắn, không phải transaction xuyên toàn corpus. Worker resume theo bounded indexed batch, re-run idempotently và chỉ set `historicalChatCitationsRedacted=true` sau zero-match scan; delayed Q&A append dùng cùng article/takedown lifecycle fence nên không thể ghi lại metadata sau cleanup.

### 6.9. Automatic account deletion

```text
User POSTs deletion request with CSRF + idempotency key
→ transaction creates deletion workflow + audit intent
→ user becomes deletion-pending; sessionVersion increments
→ revoke all sessions and clear current cookie
→ due-work coordinator directly deletes/zero-verifies session documents
→ deletes saved/chat and user-scoped Q&A quota data idempotently
→ anonymize email/password identity into opaque tombstone
→ verify every completion flag
→ mark completed and append terminal audit event
```

Account deletion không cần admin approval và không dùng content takedown state machine. API không nhận free-form reason; server derive `user-request`. Admin chỉ xem safe progress/error và retry remaining steps; retry không restore session hoặc identity. Request acceptance chứng minh `sessionsRevoked=true`, còn `sessionsDeleted=true` chỉ sau direct indexed delete + zero-match verification. `userQuotaDataDeleted=true` chỉ áp dụng bucket `subjectType=user` cho Q&A; shared IP anti-abuse buckets không bị xóa. Request document có stable unique user identity: expired-run recovery và admin retry exact-fence CAS chính request về `queued`, tăng attempt, giữ completion flags và không tạo linked child.

## 7. Job execution model

### 7.1. Vì sao không có in-memory queue

Vercel Function có thể cold start, scale thành nhiều instance hoặc kết thúc sau response. Vì vậy một array/queue trong process không đảm bảo durability hoặc mutual exclusion.

### 7.2. Durable job contract

Mỗi job có:

- opaque ID và identity `(actorScope, idempotencyKey, canonicalRequestHash)`;
- `type`, target source/article và trigger actor;
- state/attempt/checkpoint/counters, priority và `availableAt`;
- `leaseGeneration` được cấp từ persistent `generationHighWater` không bị TTL/reset;
- `createdAt`, `startedAt`, `heartbeatAt`, `finishedAt`;
- retry classification và error đã redact;
- link tới parent job khi retry.

Mỗi bounded logical resource key có persistent lease record gồm `generationHighWater` và nullable active owner. Lease không dùng TTL. Acquire chỉ match record không có active owner, atomically tăng high-water rồi ghi owner token hash, job ID, generation và expiry. Heartbeat match exact owner + generation và `expiresAt > authoritative database/server now`; lease đã hết hạn không được resurrect. Normal completion transactionally ghi terminal/partial job state và clear owner bằng cùng fence; không release trước state transition.

Lease key chỉ do server derive; raw caller key bị reject. Canonical table là:

| Namespace | Key | Operations dùng chung key |
|---|---|---|
| Ingestion | `ingestion:source:<sourceId>` | cron, admin trigger, retry cùng source |
| Indexing | `indexing:article:<articleId>` | summary, embedding, visibility reconcile cùng article |
| Source reconciliation | `reconciliation:source:<sourceId>` | marker claim/cursor/fan-out/retry cùng source |
| Account deletion | `account-deletion:user:<userId>` | automatic workflow, recovery, admin retry cùng user |

Suffix là lowercase opaque ID 1–128 ký tự chỉ gồm `[a-z0-9_-]`; cấm email, actor, invocation, random job ID và namespace tùy ý. Job/checkpoint/article/artifact commit chạy trong transaction ngắn và phải conditionally touch lease record với exact active owner + generation + unexpired authoritative timestamp trước target write. Reacquire tạo write conflict/conditional miss nên stale worker abort. Ingestion commit còn match exact source ID + current policy/config version + active/eligible state + connector config/discriminant; AI artifact commit match `sources.policyVersion == job.expectedSourcePolicyVersion`. Output/candidate bị bỏ nếu conditional touch thất bại.

Step 4 cung cấp queue adapter/registry contract: `queueName`, `selectDue`, `claimAndExecute`, `recoverExpired` và `recoveryStrategy`. Step 4 đăng ký ingestion; Step 9 đăng ký indexing; Step 11 đăng ký account deletion. Unregistered queue phải trả zero counters mà không query collection; HTTP response luôn giữ đúng ba summary keys.

### 7.3. Due-work coordinator

Cron và admin manual run gọi cùng coordinator service nhưng qua adapter/auth riêng. Mỗi invocation có hai bounded phase:

1. **Recovery:** lấy tối đa `maxRecoveries` lease có active owner hết hạn. Ingestion/indexing exact owner/generation transaction terminalize immutable parent thành `failed/lease_expired`, tạo tối đa một deterministic linked retry và clear ownership. Account deletion dùng registered `same-request` strategy: CAS chính request từ expired `running` về `queued`, tăng attempt, giữ completion flags, clear transient error/running timestamps rồi clear lease; không tạo child. Acquire không được tự chiếm expired owner chưa recovery.
2. **Reserved due work:** mỗi registered queue tự sort theo effective priority giảm dần, `availableAt`, stable creation timestamp, `_id`; overdue aging nâng item lên queue-local max. `maxJobs` phải >= số registered queue và invocation phải reserve deadline/claim margin cho toàn bộ reserved phase trước recovery/execution; budget thiếu thì fail safe và không spill. Canonical order `account-deletion → indexing → ingestion` thử claim tối đa một due item/queue trước để mọi sustained due queue tiến triển hữu hạn.
3. **Spill capacity:** slot reserved không dùng và slot còn lại chọn oldest due head giữa registered queues; tie-break theo canonical order, priority không so trực tiếp xuyên queue. `nextAvailableAt` là minimum queued `availableAt` còn lại, và chỉ `null` khi không còn queued item.
4. Dừng nhận work trước safety margin; item dở dang được checkpoint/`partial` hoặc crash-recovery ở invocation sau.
5. Cron response trả recovery counts và counters cho đúng ba queue `ingestion|indexing|account-deletion`, cùng `nextAvailableAt`; không serialize heterogeneous job documents.
6. Backlog/stale signal dùng để admin manual recovery nhưng không thay thế durable state.

### 7.4. Retry policy

| Error class | Ví dụ | Hành vi |
|---|---|---|
| Validation/policy | blocked source, scope violation | Không retry; đưa review/audit |
| Permanent upstream | 404 feed, invalid payload lặp lại | Không auto-retry; pause/review source |
| Retryable upstream | 429, timeout, 5xx | Exponential backoff có jitter, tối đa cấu hình nhỏ |
| Provider unavailable | LLM/embedding outage | LLM có fallback được cấu hình; embedding để pending/failed |
| Function deadline | Còn items khi gần deadline | Checkpoint và `partial`, không coi là crash |
| Unknown | exception ngoài dự kiến | `failed`, log request/job ID, cần admin review |

Retry của LLM chỉ chuyển provider với lỗi retryable. Policy rejection, malformed input hoặc content scope violation không được fallback.

## 8. Search và retrieval

### 8.1. Keyword baseline

- MongoDB text index dùng `default_language: "none"`.
- `searchTextNormalized` chứa bản viết thường/bỏ dấu của các field được phép.
- Filter status/source/topic/time luôn áp dụng trước khi serialize.
- Feed dùng cursor dựa trên `(publishedAt, _id)` để ổn định khi có insert mới.

### 8.2. Semantic retrieval

- Document input: `titleOriginal + titleVi + summaryVi + topics`, sau policy gate.
- Model baseline: `baai/bge-m3`, 1024 dimensions, `embeddingVersion=1` sau benchmark.
- Query và document chỉ được so cosine khi metadata vector tương thích.
- Backend giới hạn candidate set theo visibility/topic/time trước khi tính cosine.
- Với 250–400 article, tính trong Node.js là chấp nhận được; đây không phải lựa chọn scale dài hạn.

Ranking MVP ưu tiên dễ giải thích:

```text
hybridScore = 0.45 * normalizedTextScore + 0.55 * normalizedCosineScore
```

Trọng số là cấu hình cần benchmark, không phải product invariant. Không có vector hợp lệ thì kết quả dùng text score và ghi rõ fallback.

## 9. AI provider boundary

Hai JavaScript port độc lập, mô tả bằng JSDoc và kiểm tra output runtime:

```js
export class LlmProvider {
  /** @param {object} input @returns {Promise<object>} */
  async summarize(input) { throw new Error('Not implemented'); }

  /** @param {object} input @returns {Promise<object>} */
  async answer(input) { throw new Error('Not implemented'); }
}

export class EmbeddingProvider {
  /** @param {object} input @returns {Promise<object>} */
  async embed(input) { throw new Error('Not implemented'); }
}
```

Application chỉ nhận result đã qua runtime schema validation; provider adapter chịu trách nhiệm auth, timeout, retryable error mapping và schema parse. Router chọn primary/fallback từ server config. Không expose model picker hoặc arbitrary endpoint cho admin/client.

Mỗi generated artifact lưu provider/model/version/input hash và thời điểm tạo. Log chỉ giữ metadata vận hành, không giữ prompt chứa full text.

Provider request chỉ nhận field Source Policy hiện hành cho phép và không bao giờ nhận email, session, private chat history hoặc requester PII. OpenCode Zen free được coi là non-confidential route cho tới khi current policy được xác minh; nếu dùng OpenRouter cho request cần privacy, adapter bật provider ZDR/data-collection restriction cụ thể và fail closed khi không có endpoint phù hợp. ZDR không thay thế quyền publisher/source policy.

## 10. API conventions

Canonical observable contract nằm ở [contracts/openapi.json](./contracts/openapi.json). Các quy ước chính:

- base path `/api/v1`;
- resource URL dạng plural/kebab-case;
- JSON field dùng `camelCase`; ID luôn là opaque string;
- success dùng `{ "data": ... }`, collection thêm `meta`;
- error dùng `{ "error": { "code", "message", "details?", "requestId" } }`;
- feed/list dùng opaque cursor; không parse cursor ở client;
- `401` cho thiếu/hỏng session, `403` cho thiếu role/object permission;
- `409` cho duplicate/state conflict, `422` cho semantic validation;
- `GET /api/v1/me` bootstrap session-bound CSRF token; mutation cookie-auth yêu cầu header và không dùng localStorage;
- admin mutation yêu cầu CSRF và action-specific allowlisted `reasonCode` khi operation nhạy cảm; requester/account case text không được copy vào audit;
- manual job/deletion/retry hỗ trợ `Idempotency-Key`; reuse khác request hash trả `409 idempotency_mismatch`;
- Vercel Cron dùng protected `GET /api/internal/cron/due-work`; manual admin trigger vẫn là POST;
- stable error code dùng enum trong OpenAPI; client không branch theo message;
- rate-limit trả `429` và `Retry-After`.

OpenAPI là authority cho payload/nullability/enum/error. Prose trong file này không được dùng để âm thầm đổi shape.

## 11. Security controls

| Boundary | Control bắt buộc |
|---|---|
| Browser → API | schema validation, session, CSRF, Origin/CORS policy, rate limit |
| Admin route | session + role + transition validation + atomic safe audit |
| Cron → API | GET + Bearer `CRON_SECRET`, no cookie/CSRF, idempotency |
| API → source URL | canonical HTTPS không credential; normalize mapped address, validate mọi A/AAAA, reject answer set có bất kỳ private/loopback/link-local/unspecified/multicast/reserved IP, pin connection vào validated public IP, manual redirect validation, timeout/size/content-type limit |
| Browser → media host | current media policy, HTTPS host allowlist, CSP `img-src`, referrer policy, no arbitrary backend proxy |
| Source text → AI | policy gate, sanitize/extract, delimit untrusted evidence, no tools |
| API → provider | scoped input, timeout, redaction, ZDR/logging config khi hỗ trợ |
| API → MongoDB | least-privilege connection, indexed queries, no raw secret/full text |

Safe-fetch không được validate hostname rồi để HTTP client tự resolve lại. IPv4-mapped IPv6 phải normalize về IPv4 trước CIDR classification; nếu một answer không public thì reject toàn bộ mixed answer set. Adapter chọn một IP từ tập A/AAAA đã validate và pin actual connection tới IP đó trong khi giữ original hostname cho HTTP Host/TLS SNI/certificate verification. Redirect dùng `redirect=manual`, tối đa cấu hình nhỏ; mỗi `Location` được resolve/canonicalize/validate/pin lại. URL rendered ra browser cũng phải qua canonical `HttpsUrl`, cấm username/password; external anchor dùng `rel="noopener noreferrer external"`.

Password dùng password hashing library được duy trì với cost cấu hình. Session token và reset-like token chỉ lưu hash. Log structured luôn có `requestId`; job log thêm `jobId`/`sourceId` nhưng không chứa credential, session ID, source body hoặc private chat.

Login, AI Q&A, admin trigger và source technical check dùng atomic Mongo-backed rate-limit/quota buckets. `subjectType`/scope mapping là `login→ip`, `answer-*→user`, `admin-trigger→admin`, `source-test→source`; `keyHash` là keyed HMAC của opaque subject thích hợp, không là email/raw IP. Counter theo process không được dùng vì Vercel có thể cold start hoặc chạy nhiều instance; `Retry-After` được tính từ bucket window chứ không chờ TTL cleanup. Account deletion chỉ direct-delete user Q&A buckets, không đụng shared IP anti-abuse state.

## 12. Observability

### 12.1. Structured event tối thiểu

```text
timestamp, level, eventName, requestId,
actorType, actorId?, sourceId?, articleId?, jobId?,
durationMs?, result, errorCode?
```

Các event P0:

- auth success/failure/rate-limit;
- source technical check và policy transition;
- job created/started/checkpointed/completed/failed;
- provider call outcome, model và latency nhưng không log input;
- AI refusal/citation validation failure;
- admin mutation/content takedown/account-deletion step/session revocation.

Admin dashboard đọc dữ liệu tổng hợp từ collection nghiệp vụ; log platform không phải system of record cho audit. Audit document không có raw before/after snapshot: chỉ actor, action, target, changedFields, allowlisted state transition, action-specific `reasonCode`, result/request/time. Direct mutation + audit commit trong transaction ngắn; workflow dài có pending intent và terminal event. Free-form requester reason/evidence chỉ nằm trong restricted workflow document với retention/access riêng và không được copy sang audit.

## 13. Testing strategy

| Layer | Mục tiêu | Requirement tiêu biểu |
|---|---|---|
| Unit | state transition, scope gate, HTTPS canonicalization, dedupe, score | SRC-004..007, ING-007..009, SEARCH-004 |
| Contract | request/response và invalid conditional fixtures validate cùng OpenAPI | AUTH/USER/ART/ADMIN endpoints |
| Integration | Mongo indexes/repository predicates, fencing/idempotency, session/deletion | AUTH-002..006, ING-004, ART-002 |
| Connector | fixture RSS/arXiv/HN → normalized candidate | ING-001, ING-007 |
| Provider adapter | runtime-validated response, timeout/error/fallback; không network thật mặc định | AI-001..007, QA-008 |
| Media policy/UI | mode/host/attribution, null/fallback, broken remote image, video link-only | SRC-009, ART-007, ADMIN-008, NFR-011 |
| Retrieval eval | top-5 relevance, refusal, hidden-content exclusion, citation precision | SEARCH-005..006, QA-002..007 |
| E2E | login → feed → detail → source; admin source → job → audit | MVP gates |

Test quan trọng nhất là negative invariant: một article hidden/removed/review-needed hoặc source bị blocked tuyệt đối không xuất hiện trong feed, search hay evidence context. Tương tự, media từ host/mode không được duyệt không được serialize và media `not-analyzed` không được dùng để hỗ trợ factual claim. Contract test còn phải reject answered rỗng/không citation, refused có factual paragraph, policy/connector combination mâu thuẫn, technical check passed thiếu evidence, Source response `attributionRequired=true` thiếu/null/rỗng text, reconciliation terminal state thiếu version/error, unavailable citation còn URL/title, completed takedown thiếu chat-redaction evidence, rendered URL dùng `javascript:|data:|file:`/credential, IP-literal media host và operation-specific reason code sai.

Integration/security suite phải có: crash-after-claim ingestion/indexing → linked retry → stale commit fail; account deletion crash sau revoke/trước delete hoặc sau delete/trước flag → same-request requeue giữ flags; direct session zero-match/user quota delete không đụng shared IP bucket; heartbeat exact owner/generation và expired lease không resurrect; cron/manual cùng source contend canonical key; Step 4 fake three-adapter fairness, Step 9 actual ingestion/indexing backlog, Step 11 actual three-queue proof; source connector-config update tăng đúng một policy version + marker/audit rồi mid-fetch candidate bị discard; reconciliation worker N không mutate marker N+1; policy đổi lúc fake provider pending → artifact commit fail; delayed Q&A → account deletion completed/takedown completed → provider resume không persist chat/quota/available citation; bounded per-chat takedown cleanup → zero-match → completion; DNS resolver đổi public→private giữa server validation/connect → request server-side vẫn pin public hoặc reject; mixed A/AAAA và IPv4-mapped IPv6 private đều bị chặn.

## 14. Failure/degradation behavior

| Dependency lỗi | User/admin thấy gì | Dữ liệu/hành vi |
|---|---|---|
| MongoDB | `503` có request ID | Không fake success; mutation không được ghi nhận |
| RSS/arXiv/HN | Job partial/failed | Existing articles vẫn phục vụ; retry bounded |
| LLM primary | Có thể thử fallback | Không fallback cho policy error; summary giữ trạng thái |
| Cả hai LLM | Summary/Q&A unavailable rõ ràng | Feed/detail/citation nguồn vẫn dùng được |
| Embedding | Search fallback text | Vector cũ chỉ dùng nếu version/input còn hợp lệ |
| Ảnh remote lỗi/bị chặn | Visual fallback, link bài gốc vẫn hoạt động | Không backend-proxy hoặc lưu bản sao để che lỗi |
| Cron due-work không chạy | Admin overview cảnh báo stale queues/ingestion | Manual trigger dùng cùng service; durable queued/running state không mất |
| Audit write lỗi trong direct admin mutation | Mutation thất bại với request ID | Mongo transaction abort; không có state change không audit |
| Account deletion cleanup lỗi | Admin thấy failed item an toàn | Session vẫn revoked; retry chỉ item chưa hoàn tất, không restore identity |

## 15. Architecture acceptance checklist

- [ ] Mọi endpoint implementation map tới operation trong OpenAPI.
- [ ] Frontend JavaScript client/JSDoc và mock được derive từ OpenAPI.
- [ ] Repository user-facing dùng visibility predicate chung.
- [ ] Source scope được kiểm tra ngay trước mọi provider call.
- [ ] Job/lease/idempotency test vượt qua duplicate, request-hash mismatch, crash recovery, generation high-water persistence và stale lease-generation case.
- [ ] Canonical key test chứng minh cron/manual cùng source contend; heartbeat hết hạn không resurrect; account deletion recovery giữ same request/flags.
- [ ] Queue-local priority + reserved fairness cho mỗi registered due queue bounded progress; unregistered queue zero counter và không query collection.
- [ ] Ingestion final transaction fail nếu source policy/config/state đổi và không advance checkpoint.
- [ ] Reconciliation marker mutation CAS exact version/status/cursor; worker N không ghi lên N+1.
- [ ] AI artifact commit thất bại nếu current source policy version khác job expectation.
- [ ] Safe-fetch pin actual connection tới validated public IP; DNS rebinding/mixed/mapped/redirect-to-private fixtures đều bị chặn.
- [ ] Mọi rendered external URL là HTTPS không credential và external anchor có rel an toàn.
- [ ] Text search hoạt động khi embedding adapter bị tắt.
- [ ] Citation serializer không nhận URL do model tạo.
- [ ] Takedown ẩn trước, redacts historical citation URL/title, xóa/index cleanup sau và chỉ completed khi chat evidence true.
- [ ] Account deletion revoke session trước, direct-delete/zero-verify session document và user quota trước `completed`; shared IP bucket không bị xóa, delayed Q&A không tái tạo user data.
- [ ] Retention owner tạo TTL/indexed cleanup cùng migration; TTL không được dùng làm authorization, completion evidence hoặc fencing.
- [ ] Direct admin mutation không thể commit nếu safe audit event không commit.
- [ ] Không có raw HTML/full text/secret trong MongoDB hoặc log fixture.
- [ ] Không có binary/base64/GridFS media; media ngoài policy bị loại và broken image có fallback.
- [ ] Video chỉ link-only và mọi media MVP mang `mediaEvidenceStatus=not-analyzed`.
- [ ] Build local và Vercel dùng cùng application composition.

## 16. Traceability

| Architecture area | PRD requirements |
|---|---|
| Session/RBAC | AUTH-001..006, ADMIN-005..007 |
| Source Registry/policy gate | SRC-001..009, AI-001..004/007, QA-004/007 |
| Durable jobs/connectors | ING-001..009, NFR-001/005/006 |
| Article repository/visibility/media | ART-001..007, SEARCH-002, QA-004, NFR-011 |
| Search/retrieval | SEARCH-001..006, QA-002/006 |
| Provider adapters/citations | AI-001..006, QA-001..008 |
| Takedown/audit | ADMIN-004/006/007 |
| Contract/testing | NFR-007..010 và toàn bộ MVP acceptance gates |

Mọi thay đổi boundary phải bắt đầu từ PRD/ADR nếu thay đổi ý định, hoặc OpenAPI/data contract nếu chỉ thay đổi interface triển khai.
