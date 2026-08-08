# TechPulse AI — Technical Design

> Trạng thái: Plan-of-Record architecture contract
> Phiên bản: 1.2
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

Technical check không được tự phê duyệt rights và `passed` phải có server timestamp/host/content-type/sample evidence. Source activation là state transition có audit; source `blocked` hoặc `review-needed` không thể active. Terms change dùng dedicated re-review operation: pause → review-needed → policyVersion++ → enqueue reconciliation.

### 6.3. Daily/manual ingestion

```text
Vercel Cron GET adapter or admin POST trigger
→ authenticate separate trust boundary
→ derive/validate actor-scoped idempotency key + request hash
→ create or reuse job record
→ coordinator selects due work by priority/availableAt/createdAt and request budget
→ acquire Mongo lease; increment leaseGeneration
→ connector fetches bounded batch
→ normalize + canonicalize + dedupe
→ upsert article with provenance/rights snapshot
→ run allowed summary/index work within request budget
→ checkpoint cursor/counters only with current leaseGeneration
→ release lease; mark succeeded/partial/failed
```

Job runner dừng trước execution deadline bằng safety margin. Phần còn lại tồn tại với `availableAt` và checkpoint để due-work coordinator resume qua manual run hoặc lần cron sau. Coordinator dùng chung cho ingestion, summary, embedding, visibility reconciliation và account deletion; không có queued work chỉ phụ thuộc process memory. `partial` không rollback dữ liệu đã ghi; mỗi item operation idempotent và stale worker không commit được sau khi mất generation.

### 6.4. Summary và embedding

```text
One article + one artifact task pending
→ load current source policy
→ policy gate selects metadata/excerpt/fulltext-temporary/none
→ optional safe fetch + main-content extraction in memory
→ LLM summary schema validation
→ persist short summary + basis + model + input hash
→ embedding gate selects allowed derived text
→ BGE-M3 request
→ validate 1024 dimensions
→ persist vector + model/version/hash
→ discard temporary text
```

Mỗi indexing job chỉ sở hữu một task để summary và embedding có state/retry độc lập. Nếu policy là `none`, provider không được gọi. Nếu summary lỗi, article có thể vẫn publish với summary state rõ ràng nếu metadata hợp lệ; UI không giả vờ summary đã sẵn sàng. Nếu embedding lỗi, text search tiếp tục hoạt động. Artifact chuyển `removed` phải unset content/model/hash/error; public serializer chỉ trả summary khi `ready`.

### 6.5. Feed/search/detail

Mọi repository query cho user surface phải dùng cùng visibility predicate:

```text
article.status == published
AND current source.operationalStatus == active
AND current source.licenseStatus IN [permitted, metadata-only]
```

Rights snapshot trên article phục vụ audit, còn Source Registry hiện tại quyết định có tiếp tục được hiển thị/xử lý hay không. Source transition đồng thời enqueue reconciliation; query-time predicate là lớp bảo vệ trong khoảng thời gian reconciliation chưa hoàn tất.

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
- Không tin tùy ý `og:image`; candidate phải đến từ field connector cho phép, dùng HTTPS và hostname khớp `allowedHosts` của source.
- React đặt `alt`, credit/attribution khi bắt buộc, lazy loading, referrer policy phù hợp và fallback khi hotlink lỗi. Backend không proxy ảnh chỉ để né hotlink/CORS.
- `mediaEvidenceStatus=not-analyzed` luôn được trả với media MVP. Summary, embedding và Q&A không được dùng chi tiết chỉ nhìn thấy/nghe thấy trong media đó.

### 6.7. AI Q&A có citation

```text
Question + article/topic/time scope
→ validate + quota
→ retrieve only visible/allowed candidates
→ build evidence blocks with stable citation IDs
→ system instruction separates evidence as untrusted data
→ LLM returns structured paragraphs + cited evidence IDs
→ server validates every cited ID and coverage
→ invalid/insufficient output becomes refusal or one bounded retry
→ persist/return answer without copied full text
```

Provider không được cấp tool. Model không được tự tạo URL; serializer lấy citation metadata từ MongoDB bằng evidence ID đã kiểm tra. Contract dùng hai shape loại trừ nhau: `answered` có paragraph/citation không rỗng và `refusalReason=null`; `refused` có arrays rỗng và reason code. Runtime kiểm tra mọi paragraph citation ID resolve tới retrieved article đang visible trước persistence/response.

### 6.8. Takedown

```text
Admin approves complete requestedScope
→ mark target hidden/removed first
→ remove media reference/summary/vector from user and retrieval surfaces
→ delete fields/documents required by the complete requestedScope
→ revoke related cached/generated artifacts
→ mark completed only after verification
→ append audit record
```

Visibility bị tắt trước thao tác xóa để tránh race làm dữ liệu tiếp tục xuất hiện. MVP content takedown chỉ có source/article và all-or-nothing approval; không có `user-data`, `account-data` hoặc partial approval. Historical chat citation tới target bị anonymize/disable, không tiếp tục mở URL/title đã gỡ.

### 6.9. Automatic account deletion

```text
User POSTs deletion request with CSRF + idempotency key
→ transaction creates deletion workflow + audit intent
→ user becomes deletion-pending; sessionVersion increments
→ revoke all sessions and clear current cookie
→ due-work coordinator deletes saved/chat/quota data idempotently
→ anonymize email/password identity into opaque tombstone
→ verify every completion flag
→ mark completed and append terminal audit event
```

Account deletion không cần admin approval và không dùng content takedown state machine. Admin chỉ xem safe progress/error và retry remaining steps; retry không restore session hoặc identity.

## 7. Job execution model

### 7.1. Vì sao không có in-memory queue

Vercel Function có thể cold start, scale thành nhiều instance hoặc kết thúc sau response. Vì vậy một array/queue trong process không đảm bảo durability hoặc mutual exclusion.

### 7.2. Durable job contract

Mỗi job có:

- opaque ID và identity `(actorScope, idempotencyKey, canonicalRequestHash)`;
- `type`, target source/article và trigger actor;
- state/attempt/checkpoint/counters, priority và `availableAt`;
- monotonically increasing `leaseGeneration`;
- `createdAt`, `startedAt`, `heartbeatAt`, `finishedAt`;
- retry classification và error đã redact;
- link tới parent job khi retry.

Lease được lấy bằng atomic conditional update, có owner token, `leaseGeneration` và `expiresAt`. Acquire mới tăng generation. Worker chỉ heartbeat/release/update job/checkpoint/artifact khi owner token + generation còn khớp. Recovery coi job `running` với lease hết hạn là failed/recoverable trước attempt mới; response provider từ stale worker bị bỏ.

### 7.3. Due-work coordinator

Cron và admin manual run gọi cùng coordinator service nhưng qua adapter/auth riêng. Mỗi invocation:

1. lấy tối đa `maxJobs` có `status=queued` và `availableAt<=now`;
2. sort ổn định theo priority giảm dần, `availableAt`, `createdAt`, `_id`;
3. dừng trước function deadline và không nhận work mới sau safety margin;
4. checkpoint/requeue remaining item với `availableAt` mới;
5. ghi stale-ingestion/backlog signal để admin có thể manual recovery.

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
- admin mutation yêu cầu CSRF và `reason` khi operation nhạy cảm;
- manual job/deletion/retry hỗ trợ `Idempotency-Key`; reuse khác request hash trả `409 idempotency_mismatch`;
- Vercel Cron dùng protected GET adapter; manual admin trigger vẫn là POST;
- stable error code dùng enum trong OpenAPI; client không branch theo message;
- rate-limit trả `429` và `Retry-After`.

OpenAPI là authority cho payload/nullability/enum/error. Prose trong file này không được dùng để âm thầm đổi shape.

## 11. Security controls

| Boundary | Control bắt buộc |
|---|---|
| Browser → API | schema validation, session, CSRF, Origin/CORS policy, rate limit |
| Admin route | session + role + transition validation + atomic safe audit |
| Cron → API | GET + Bearer `CRON_SECRET`, no cookie/CSRF, idempotency |
| API → source URL | HTTPS allowlist khi có thể, DNS/IP/redirect revalidation, timeout, size/content-type limit |
| Browser → media host | current media policy, HTTPS host allowlist, CSP `img-src`, referrer policy, no arbitrary backend proxy |
| Source text → AI | policy gate, sanitize/extract, delimit untrusted evidence, no tools |
| API → provider | scoped input, timeout, redaction, ZDR/logging config khi hỗ trợ |
| API → MongoDB | least-privilege connection, indexed queries, no raw secret/full text |

Password dùng password hashing library được duy trì với cost cấu hình. Session token và reset-like token chỉ lưu hash. Log structured luôn có `requestId`; job log thêm `jobId`/`sourceId` nhưng không chứa credential, session ID, source body hoặc private chat.

Login, AI Q&A, admin trigger và source technical check dùng atomic Mongo-backed rate-limit/quota buckets. Counter theo process không được dùng vì Vercel có thể cold start hoặc chạy nhiều instance; `Retry-After` được tính từ bucket window chứ không chờ TTL cleanup.

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

Admin dashboard đọc dữ liệu tổng hợp từ collection nghiệp vụ; log platform không phải system of record cho audit. Audit document không có raw before/after snapshot: chỉ actor, action, target, changedFields, allowlisted state transition, reason/result/request/time. Direct mutation + audit commit trong transaction ngắn; workflow dài có pending intent và terminal event.

## 13. Testing strategy

| Layer | Mục tiêu | Requirement tiêu biểu |
|---|---|---|
| Unit | state transition, scope gate, URL normalization, dedupe, score | SRC-004..007, ING-007..009, SEARCH-004 |
| Contract | request/response và invalid conditional fixtures validate cùng OpenAPI | AUTH/USER/ART/ADMIN endpoints |
| Integration | Mongo indexes/repository predicates, fencing/idempotency, session/deletion | AUTH-002..006, ING-004, ART-002 |
| Connector | fixture RSS/arXiv/HN → normalized candidate | ING-001, ING-007 |
| Provider adapter | runtime-validated response, timeout/error/fallback; không network thật mặc định | AI-001..007, QA-008 |
| Media policy/UI | mode/host/attribution, null/fallback, broken remote image, video link-only | SRC-009, ART-007, ADMIN-008, NFR-011 |
| Retrieval eval | top-5 relevance, refusal, hidden-content exclusion, citation precision | SEARCH-005..006, QA-002..007 |
| E2E | login → feed → detail → source; admin source → job → audit | MVP gates |

Test quan trọng nhất là negative invariant: một article hidden/removed/review-needed hoặc source bị blocked tuyệt đối không xuất hiện trong feed, search hay evidence context. Tương tự, media từ host/mode không được duyệt không được serialize và media `not-analyzed` không được dùng để hỗ trợ factual claim. Contract test còn phải reject answered rỗng/không citation, refused có factual paragraph, policy/connector combination mâu thuẫn, technical check passed thiếu evidence và audit có arbitrary snapshot.

## 14. Failure/degradation behavior

| Dependency lỗi | User/admin thấy gì | Dữ liệu/hành vi |
|---|---|---|
| MongoDB | `503` có request ID | Không fake success; mutation không được ghi nhận |
| RSS/arXiv/HN | Job partial/failed | Existing articles vẫn phục vụ; retry bounded |
| LLM primary | Có thể thử fallback | Không fallback cho policy error; summary giữ trạng thái |
| Cả hai LLM | Summary/Q&A unavailable rõ ràng | Feed/detail/citation nguồn vẫn dùng được |
| Embedding | Search fallback text | Vector cũ chỉ dùng nếu version/input còn hợp lệ |
| Ảnh remote lỗi/bị chặn | Visual fallback, link bài gốc vẫn hoạt động | Không backend-proxy hoặc lưu bản sao để che lỗi |
| Cron không chạy | Admin overview cảnh báo stale ingestion | Manual trigger dùng cùng service |
| Audit write lỗi trong direct admin mutation | Mutation thất bại với request ID | Mongo transaction abort; không có state change không audit |
| Account deletion cleanup lỗi | Admin thấy failed item an toàn | Session vẫn revoked; retry chỉ item chưa hoàn tất, không restore identity |

## 15. Architecture acceptance checklist

- [ ] Mọi endpoint implementation map tới operation trong OpenAPI.
- [ ] Frontend JavaScript client/JSDoc và mock được derive từ OpenAPI.
- [ ] Repository user-facing dùng visibility predicate chung.
- [ ] Source scope được kiểm tra ngay trước mọi provider call.
- [ ] Job/lease/idempotency test vượt qua duplicate, request-hash mismatch và stale lease-generation case.
- [ ] Text search hoạt động khi embedding adapter bị tắt.
- [ ] Citation serializer không nhận URL do model tạo.
- [ ] Takedown ẩn trước, xóa/index cleanup sau và có audit.
- [ ] Account deletion revoke session trước, hoàn thành mọi cleanup flag rồi mới `completed`.
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
