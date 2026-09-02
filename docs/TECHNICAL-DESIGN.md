# TechPulse AI — Technical Design

> Trạng thái: Plan-of-Record architecture contract; ADR-0013/0014 amendment trước Step 12
> Phiên bản: 1.9
> Cập nhật: 24/08/2026
> Product contract: [PRD.md](./PRD.md)  
> Persistence contract: [DATA-MODEL.md](./DATA-MODEL.md)  
> HTTP contract: [contracts/openapi.json](./contracts/openapi.json)  
> Decision log: [adr/README.md](./adr/README.md)

## 1. Mục tiêu thiết kế

Kiến trúc phải chứng minh được một vertical slice hoàn chỉnh và vẫn đủ rõ để bốn phần React, Node.js, MongoDB và AI có giá trị kỹ thuật riêng. Baseline tối ưu cho một project owner làm cùng coding agent, 250–400 article và tối thiểu 10 user đồng thời trong buổi demo; tốc độ agent không làm yếu contract/security gate.

Các thuộc tính bắt buộc:

1. provenance và source policy không bị mất từ ingestion đến citation;
2. browser, nguồn ngoài và AI provider đều nằm ngoài trust boundary;
3. mọi state bền vững nằm trong MongoDB Atlas; `techpulse_app` giữ runtime state, `techpulse_governance` giữ signed suppression/checkpoint state ngoài app dump boundary; Vercel memory/filesystem không là state store;
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
- Không xây arbitrary provider marketplace hoặc abstraction cho mọi loại AI. Chỉ hỗ trợ protocol adapter đã cài và server-owned route config theo ADR-0013.
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
    ├── /api/internal/cron/*
    └── /api/internal/maintenance/<fixed-task>
```

Một MongoDB Atlas deployment vẫn là system of record duy nhất nhưng có hai logical database. `techpulse_app` giữ users, sessions, shared rate-limit buckets, answer-attempt receipts, provider admission state, source registry, articles, jobs, leases, chat, takedown, account-deletion workflow và audit. `techpulse_governance` giữ signed suppression entries, audit checkpoints và audit-retention manifests; database này không bị overwrite khi restore `techpulse_app`. Vercel Environment Variables giữ Mongo URI/database names, session/CSRF/HMAC keyrings, cron secret và provider keys. Không có secret trong React bundle.

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

| Component                | Trách nhiệm                                                                                                 | Không được làm                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| React client             | Render feed/admin, giữ UI state, gọi generated JavaScript client                                            | Tự suy role, gọi source/provider trực tiếp                                |
| HTTP ingress/layer       | Same-origin/CORS-cookie policy, strict target/body/query parser, auth, CSRF, rate-limit, serialize contract | Chứa business rule, tin caller forwarding header hoặc Mongo query rải rác |
| Application services     | Điều phối use case và transaction boundary                                                                  | Phụ thuộc Express object                                                  |
| Domain policy            | State transition, visibility, rights scope, dedupe decision                                                 | Network hoặc database I/O                                                 |
| Repositories             | Truy cập MongoDB và enforce query predicate chung                                                           | Trả document thô ra HTTP                                                  |
| Connectors               | Fetch nguồn allowlisted và trả normalized candidate                                                         | Gọi LLM, tự nâng license scope                                            |
| Content policy gate      | Tạo allowed provider input từ source/article policy                                                         | Dùng text ngoài scope hoặc bỏ qua blocked state                           |
| Media policy gate        | Kiểm tra mode/host/current policy, tạo `leadMedia` DTO hoặc null                                            | Fetch binary, proxy URL tùy ý hoặc biến media chưa xử lý thành evidence   |
| Provider adapter catalog | Chuẩn hóa protocol auth/request/response/error cho adapter đã cài                                           | Chứa business route choice hoặc nhận arbitrary endpoint                   |
| Workload provider router | Chọn primary/model/provider fallback theo failure class và bounded attempts                                 | Hạ capability, đổi admitted input hoặc log raw input                      |
| Provider admission       | Atomic credential-domain concurrency/budget và route/provider-domain circuits                               | Tách cùng credential thành nhiều budget domain                            |
| Answer support verifier  | Kiểm tra paragraph với exact internal evidence blocks                                                       | Tự tạo citation URL hoặc biến community content thành evidence            |
| Embedding adapter        | Vector theo pinned model/version/dimensions                                                                 | Trộn vector khác version                                                  |
| Job runner               | Lease, checkpoint, bounded work, counter, retry classification                                              | Queue trong memory hoặc chạy vô hạn                                       |
| Audit service            | Ghi admin mutation append-only                                                                              | Lưu secret/full text/private chat                                         |
| Maintenance runner       | Chạy fixed task table bằng machine auth, bounded indexed batch                                              | Nhận caller collection/filter/cutoff/batch                                |

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
API → exact Origin + strict ingress + trusted-IP rate limit
API → verify password hash
API → create hashed session record in MongoDB
API → Set-Cookie __Host-techpulse_session; Secure; HttpOnly; Path=/; SameSite=Lax
API → return User + CSRF token
Browser reload → GET /api/v1/me + cookie
API → return User + session-bound CSRF token
Browser → state-changing request + cookie + X-CSRF-Token
API → session lookup → status/role/CSRF authorization
```

- Cookie chứa opaque session token; MongoDB chỉ lưu hash của token.
- Browser API same-origin only và production không phát credentialed CORS. Register/login cùng mọi cookie mutation fail closed nếu `Origin` thiếu/malformed/không exact scheme+host+effective-port; test harness chỉ dùng exact configured test origin.
- Cookie không có `Domain`; `Max-Age<=absoluteExpiresAt`. Logout/account deletion clear đúng cùng cookie tuple. Register/login/`GET /me` trả `Cache-Control: no-store, private`; session-dependent response thêm `Vary: Cookie`.
- CSRF token chỉ giữ trong memory của React và được bootstrap qua `/me`; token được gắn ổn định với session nên concurrent tab/StrictMode không làm token hợp lệ của tab khác bị revoke. Không lưu localStorage và không yêu cầu login lại sau reload.
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
→ idempotently consume bounded daily continuation pages for active sources (100/source page, explicit page cap + deadline)
→ CAS durable per-period cursor/completion marker before coordinator work
→ recover a bounded batch of expired active leases/running jobs
→ select due work across ingestion/indexing/account-deletion queues
→ return aggregate recovery + per-queue counters

Admin POST ingestion trigger
→ authenticate cookie + admin role + CSRF
→ derive/validate actor-scoped idempotency key + request hash
→ atomically create/reuse + admission + audit record
→ invoke shared queue coordinator only (không materialize cron intent ngoài request)
- Admin article status/topics/media mutation dùng cùng actor-scoped idempotency key và append-only audit claim trước article/source/reconciliation writes; client giữ nguyên key qua ambiguous retry nhưng tạo key mới cho next-status intent.

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

Job runner dừng trước execution deadline bằng safety margin. Phần còn lại tồn tại với `availableAt` và checkpoint để coordinator resume qua manual run hoặc lần cron sau. Cron adapter consume liên tiếp các trang daily continuation trong một invocation tới page cap/deadline; durable cursor vẫn cho phép invocation sau tiếp tục khi cap/deadline chạm tới. Manual adapter không được tạo cron job ngoài intent. Coordinator queue-agnostic nhưng response chỉ trả aggregate counters; chi tiết job đọc qua admin queue endpoints. `partial` không rollback dữ liệu đã ghi; mỗi item operation idempotent và stale worker không commit được sau khi mất generation. Nếu source bị block, mất eligibility hoặc policy/connector config đổi trong lúc fetch, final CAS miss discard candidate và không advance checkpoint/counter; safe workflow error là `policy_version_mismatch`.

### 6.4. Summary và embedding

```text
One article + one artifact task pending
→ capture expectedSourcePolicyVersion and load current source policy
→ policy gate selects metadata/excerpt/fulltext-temporary/none
→ optional safe fetch + main-content extraction in memory
→ LLM summary schema validation (short `summaryVi` + 2–5 `summaryParagraphsVi`)
→ transactionally re-check fence + current policy version
→ persist short/detail summary + basis + model + input hash + source policy version
→ embedding gate selects allowed derived text
→ workload router selects a compatible embedding route
→ validate configured dimensions + artifactCompatibilityId
→ transactionally re-check fence + current policy version
→ persist vector + model/version/hash + source policy version
→ discard temporary text
```

Mỗi indexing job chỉ sở hữu một task để summary và embedding có state/retry độc lập. Summary tạo short/detail trong cùng một provider request; feed chỉ đọc `summaryVi`, còn detail chỉ đọc `summaryParagraphsVi` khi `summaryDetailStatus=ready` và fallback rõ ràng khi pending/failed. Ba connector seed có thể dùng payload đã normalize theo exact `sourceKey` cho summary; system prompt đặt payload trong delimiter, coi toàn bộ là untrusted data, bỏ qua prompt injection và không gọi tool. Đây không phải quyền lưu raw full text, HTML, provider payload hoặc media binary. Nếu policy là `none`, provider không được gọi. Nếu source policy đổi sau provider call, commit phải fail với safe `policy_version_mismatch`, discard output và để current reconciliation tạo work phù hợp; không persist artifact sinh dưới policy cũ. Nếu summary lỗi, article có thể vẫn publish với summary state rõ ràng nếu metadata hợp lệ; UI không giả vờ summary đã sẵn sàng. Nếu embedding lỗi, text search tiếp tục hoạt động. Artifact chuyển `removed` phải unset content/model/hash/error/policy-version; public serializer chỉ trả summary khi `ready`.

### 6.5. Feed/search/detail

Mọi repository query cho user surface phải dùng cùng visibility predicate:

```text
article.status == published
AND current source.operationalStatus == active
AND current source.licenseStatus IN [permitted, metadata-only]
```

Q&A evidence thêm predicate `current source.authorityTier IN [primary, editorial]`; `community-signal` vẫn được feed/search discovery nhưng bị loại trước evidence block construction và không được serialize thành answer citation.

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
→ strict validate + privacy admission
→ `sensitive-input` refuses before any embedding/provider call
→ capture userId + opaque sessionId + expectedSessionVersion
→ atomically create/reuse 24h answer attempt + reserve one quota unit
→ optionally create at most one query embedding from the admitted question through the configured `embedding` workload when its capability is equal to or stronger than `qa-generation.requiredCapability`
→ retrieve only visible primary/editorial candidates
→ build evidence blocks with stable citation IDs + internal block IDs
→ system instruction separates evidence as untrusted data
→ every answer/support provider call passes privacy capability + admission/circuit claim
→ LLM returns structured paragraphs + citation IDs + supporting block IDs
→ server validates IDs/coverage and runs one bounded support verification
→ unsupported/uncertain output becomes deterministic refusal in MVP
→ final transaction rechecks active user/session version + article/takedown lifecycle
→ persist/return answer without copied full text, or discard provider result on CAS miss
```

Provider không được cấp tool. Model không được tự tạo URL; serializer lấy citation metadata từ MongoDB bằng evidence ID đã kiểm tra. Privacy gate từ chối obvious credential/high-risk identifier bằng `sensitive-input`, không silently redact rồi giả vờ giữ nguyên nghĩa. Current graph gửi raw question và evidence đã admit tới DeepSeek `deepseek-v4-flash` trên capability `nonconfidential`; route này không có bằng chứng ZDR và phải được coi là nonconfidential. Query embedding là một bước retriever riêng: service chỉ truyền admitted question tới embedding workload khi capability của route bằng hoặc mạnh hơn capability Q&A; current OpenRouter/BGE-M3 route là `nonconfidential` nên được phép sau privacy admission. Vector và embedding metadata không đi vào answer prompt hoặc answer-attempt state; embedding unavailable/incompatible thì dùng lexical/taxonomy fallback. Graph hiện tại không có model/provider fallback; route không phù hợp trả `provider-unavailable`, còn candidate tương lai không được bypass capability.

Generation và support đều coi question, paragraph và evidence JSON là untrusted data. Support verifier nhận system instruction riêng yêu cầu bỏ qua mọi instruction, prompt, role hoặc yêu cầu đổi verdict nằm trong user JSON; model chỉ được áp dụng system instruction và trả schema support cố định. Evidence content không thể tự nâng vai trò hoặc thay đổi policy gate.

Contract dùng hai shape loại trừ nhau: `answered` có paragraph/citation không rỗng và `refusalReason=null`; `refused` có arrays rỗng và reason code. Public citation vẫn cấp đoạn. Internal provider contract buộc từng paragraph trả supporting block IDs; verifier chạy một constrained check cho toàn answer trên đúng blocks và trả `supported|unsupported|uncertain`. Chỉ `supported` được persist; MVP chuyển hai verdict còn lại thành refusal, không gọi repair. Primary/fallback generation và support verifier đều dùng route-specific capability/admission/circuit/eval. Final chat/attempt/quota write conditionally touch `users._id`, `status=active`, exact captured `sessionVersion` và current article/takedown visibility trong cùng transaction; account deletion hoặc takedown thắng race thì output provider bị bỏ và không được tái tạo user data/citation.

#### 6.7.1. Evidence budget, final fence và transaction session

Q&A dùng một evidence budget cố định trước khi gọi provider:

- chọn tối đa 6 evidence blocks;
- chọn tối đa 2 article từ mỗi source;
- nội dung canonical của mỗi block tối đa 2.100 ký tự sau khi loại URL ngoài và delimiter;
- block có wrapper `<evidence-block>` tối đa 2.400 ký tự;
- generation prompt phải nhỏ hơn 30.000 ký tự;
- support verifier chỉ nhận paragraph đã được trích dẫn và evidence blocks tương ứng, với tổng paragraph tối đa 10.000 ký tự và payload JSON nhỏ hơn 30.000 ký tự.

`evidenceAdmissionFence` hash đúng text bounded mà provider nhận và exact citation metadata do server hydrate: article/source identity, title, original URL, publish time và source name theo canonical projection. Fence không hash `updatedAt`; timestamp vận hành không phải evidence content. Finalization chỉ kiểm tra và khóa các article có citation thực sự xuất hiện trong answer cùng các source duy nhất của chúng. Nó dùng `findOneAndUpdate` để ghi `qnaFenceToken` nội bộ trong cùng Mongo transaction, không ghi `updatedAt` và không trả token qua serializer. Article/source không còn khớp status, version, policy, visibility, evidence hash hoặc citation metadata hash thì transaction trả conflict và bỏ provider output.

Mọi operation trong cùng Mongo transaction phải chạy tuần tự trên cùng session. Không dùng `Promise.all` cho các Mongo operation dùng transaction session. Nếu session bị dùng đồng thời, Mongo có thể trả code 117 (`ConflictingOperationInProgress`); application map lỗi hạ tầng này sang canonical `503 service_unavailable` và không để raw Mongo error đi tới client.

Migration `qa-evidence-fence` mở rộng validator của `articles` và `sources` để cho phép `qnaFenceToken` tùy chọn kiểu `objectId`, giữ nguyên schema đóng và mọi nhánh tombstone hiện có. Vì `provider-routing-v2` và `governance` có bước `collMod` article riêng, hai migration tổng hợp này phải reapply `qa-evidence-fence` sau validator nền để không xóa field fence. Runtime chỉ phục vụ Q&A sau khi migration, validator/index và signed schema attestation `qa-evidence-fence-v1` đã sẵn sàng. Cold start không chỉ tin attestation: sau khi verify chữ ký, Q&A đọc live collection metadata và yêu cầu exact fenced validator trên cả `articles` và `sources`. `db:verify -- qa-evidence-fence --require-role` phải chứng minh capability transaction và quyền `find/update` cần thiết trên hai collection. Thiếu migration, live validator, attestation hoặc runtime capability trả trạng thái unavailable; đây là lỗi hạ tầng Mongo và được serialize thành HTTP 503.

Downgrade guard của migration coi `sources`, `articles`, `indexing-jobs` và `chat-sessions` là unsafe older targets sau khi provider-routing-v2 marker đã tồn tại. Operator không được chạy lại migration `sources` cũ để thay closed source validator và xóa `qnaFenceToken`; chỉ migration successor explicit như `provider-routing-v2`, `qa-evidence-fence` hoặc repair aggregate được phép.

Nếu actor/session, evidence policy hoặc Mongo readiness thay đổi trong provider stage, router đánh dấu lỗi là local control interruption. Provider admission release reservation với outcome `cancelled`; provider-domain circuit không nhận failure, không mở circuit và không kích hoạt fallback. Client vẫn nhận đúng `401`, `409` hoặc `503` từ local boundary thay vì một provider refusal giả.

Provider failure-domain half-open chỉ cho một probe reservation hoạt động. Nếu probe không report outcome, reservation hết hạn sau một cooldown window. Admission sau đó clear stale probe và cho phép probe mới; domain không bị khóa vĩnh viễn ở half-open. Probe `succeeded` đóng circuit; retryable provider failure mở lại circuit và tạo cooldown mới; local-control `cancelled` chỉ release probe ownership.

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
→ deletes saved/chat/answer-attempt receipts idempotently
→ derives every non-retired HMAC version and deletes/zero-verifies user Q&A quota
→ unset every user field outside the closed lifecycle tombstone allowlist
→ verify every completion flag
→ mark completed and append terminal audit event
```

Account deletion không cần admin approval và không dùng content takedown state machine. API không nhận free-form reason; server derive `user-request`. Admin chỉ xem safe progress/error và retry remaining steps; retry không restore session hoặc identity. Request acceptance chứng minh `sessionsRevoked=true`; `sessionsDeleted`/`answerAttemptsDeleted`/`userQuotaDataDeleted` chỉ true sau direct delete + zero-match. Shared IP anti-abuse buckets không bị xóa. `identityAnonymized=true` yêu cầu raw user document chỉ còn `_id`, deleted lifecycle timestamps/reference, `sessionVersion`, `createdAt`, `updatedAt`; role/preferences/suspension context đều bị unset. Request document có stable unique user identity: expired-run recovery và admin retry exact-fence CAS chính request về `queued`, tăng attempt, giữ completion flags và không tạo linked child.

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

| Namespace             | Key                                | Operations dùng chung key                             |
| --------------------- | ---------------------------------- | ----------------------------------------------------- |
| Ingestion             | `ingestion:source:<sourceId>`      | cron, admin trigger, retry cùng source                |
| Indexing              | `indexing:article:<articleId>`     | summary, embedding, visibility reconcile cùng article |
| Source reconciliation | `reconciliation:source:<sourceId>` | marker claim/cursor/fan-out/retry cùng source         |

Suffix là lowercase opaque ID 1–128 ký tự chỉ gồm `[a-z0-9_-]`; cấm email, actor, invocation, random job ID và namespace tùy ý. Job/checkpoint/article/artifact commit chạy trong transaction ngắn và phải conditionally touch lease record với exact active owner + generation + unexpired authoritative timestamp trước target write. Reacquire tạo write conflict/conditional miss nên stale worker abort. Ingestion commit còn match exact source ID + current policy/config version + active/eligible state + connector config/discriminant; AI artifact commit match `sources.policyVersion == job.expectedSourcePolicyVersion`. Output/candidate bị bỏ nếu conditional touch thất bại.

Account deletion là stable-workflow exception theo ADR-0014. `accountDeletionRequests` giữ inline owner token, expiry và generation. Mọi cleanup checkpoint/terminal write match exact inline lease trong cùng transaction; expired recovery requeue cùng request và giữ completion flags. Shared `jobLeases` chỉ dùng cho ingestion, indexing và reconciliation.

Step 4 cung cấp queue adapter/registry contract: `queueName`, `selectDue`, `claimAndExecute`, `recoverExpired` và `recoveryStrategy`. Step 4 đăng ký ingestion; Step 9 đăng ký indexing; Step 11 đăng ký account deletion. Maintenance task registry dùng cùng fixed-scope adapter nhưng ownership riêng: Step 4 ingestion, Step 9 indexing, Step 10 answer-attempt, Step 11 governance/audit-IP. Unregistered queue phải trả zero counters mà không query collection; HTTP response luôn giữ đúng ba summary keys.

### 7.3. Due-work coordinator

Cron và admin manual run gọi cùng coordinator service nhưng qua adapter/auth riêng. Mỗi invocation có hai bounded phase:

1. **Recovery:** lấy tối đa `maxRecoveries` lease có active owner hết hạn. Ingestion/indexing exact owner/generation transaction terminalize immutable parent thành `failed/lease_expired`, tạo tối đa một deterministic linked retry và clear ownership. Đồng thời, phục hồi các orphaned running jobs (job mang `status=running` nhưng lease tương ứng đã bị giải phóng hoặc bị thế hệ sau ghi đè mà worker chưa kịp cập nhật) chuyển dứt điểm sang `failed/lease_expired`. Account deletion dùng registered `same-request` strategy: CAS chính request từ expired `running` về `queued`, tăng attempt, giữ completion flags, clear transient error/running timestamps rồi clear lease; không tạo child. Acquire không được tự chiếm expired owner chưa recovery.
2. **Reserved due work:** mỗi registered queue chạy hai query đóng. Aged lane trước: `status=queued`, `availableAt<=now`, `agingEligibleAt<=now`, sort `agingEligibleAt → availableAt → created/requestedAt → _id`. Nếu không có, normal lane sort `priority desc → availableAt → created/requestedAt → _id`. `agingEligibleAt` server derive (account deletion 5 phút; ingestion/indexing 30 phút), caller không set. `maxJobs` phải >= số registered queue và invocation reserve deadline/claim margin cho toàn reserved phase trước recovery/execution; budget thiếu thì fail safe, không spill. Canonical order `account-deletion → indexing → ingestion` thử claim tối đa một due item/queue trước.
3. **Spill capacity:** slot reserved không dùng và slot còn lại chọn oldest due head giữa registered queues; tie-break theo canonical order, priority không so trực tiếp xuyên queue. `nextAvailableAt` là minimum queued `availableAt` còn lại, và chỉ `null` khi không còn queued item.
4. Dừng nhận work trước safety margin; item dở dang được checkpoint/`partial` hoặc crash-recovery ở invocation sau.
5. Cron response trả recovery counts và counters cho đúng ba queue `ingestion|indexing|account-deletion`, cùng `nextAvailableAt`; không serialize heterogeneous job documents.
6. Backlog/stale signal dùng để admin manual recovery nhưng không thay thế durable state.

Mỗi lane có exact compound index kết thúc bằng `_id`; `db:verify` dùng `explain("executionStats")` để reject `COLLSCAN` và blocking sort trên mixed due/not-due fixture. Priority không được so xuyên queue. Manual idempotency key được giữ tối thiểu 14 ngày; job cleanup không chạy trước `idempotencyExpiresAt`.

### 7.4. Retry policy

| Error class                 | Ví dụ                                              | Hành vi                                                                                 |
| --------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Validation/policy           | blocked source, scope violation                    | Không retry; đưa review/audit                                                           |
| Permanent upstream          | 404 feed, invalid payload lặp lại                  | Không auto-retry; pause/review source                                                   |
| Retryable upstream          | 429, timeout, 5xx                                  | Exponential backoff có jitter, tối đa cấu hình nhỏ                                      |
| Model route unavailable     | Model-scoped 429/timeout/5xx                       | Chỉ `model-retryable` mới chọn same-provider model fallback                             |
| Provider domain unavailable | Shared transport/control-plane outage              | Chỉ `provider-retryable` mới chọn cross-provider-domain fallback                        |
| Embedding route unavailable | Compatible route thiếu hoặc compatibility mismatch | Chỉ fallback cùng `artifactCompatibilityId`; nếu không thì pending/failed + text search |
| Function deadline           | Còn items khi gần deadline                         | Checkpoint và `partial`, không coi là crash                                             |
| Unknown                     | exception ngoài dự kiến                            | `failed`, log request/job ID, cần admin review                                          |

LLM/embedding adapter phải phân loại lỗi. `model-retryable` chỉ cho phép same-provider model fallback; `provider-retryable` chỉ cho phép cross-provider-domain fallback. Policy/privacy/validation/schema/support hoặc ambiguous outcome không được fallback.

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

### 8.3. Q&A embedding-assisted candidate acquisition

- Q&A tạo tối đa một query embedding từ câu hỏi đã qua privacy admission bằng configured `embedding` workload. Bootstrap chỉ truyền function khi capability của embedding route bằng hoặc mạnh hơn `qa-generation.requiredCapability`.
- Repository nhận query vector kèm `model`, `dimensions`, `version` và `artifactCompatibilityId`; chỉ candidate có metadata tương thích tuyệt đối mới được tính cosine. Vector không được đưa vào prompt và không persist trong chat/answer-attempt.
- Khi query embedding unavailable hoặc incompatible, Q&A degrade về lexical + bounded topic-alias retrieval; nếu evidence vẫn không đủ thì trả deterministic `insufficient-evidence`. `sensitive-input` vẫn refuse trước mọi embedding/provider call.
- Current OpenRouter/BGE-M3 embedding route là `nonconfidential`, tương thích với current DeepSeek Q&A `nonconfidential`; route vẫn chịu provider admission, evidence expiry và capability checks.

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
  async summarize(input) {
    throw new Error('Not implemented')
  }

  /** @param {object} input @returns {Promise<object>} */
  async answer(input) {
    throw new Error('Not implemented')
  }
}

export class EmbeddingProvider {
  /** @param {object} input @returns {Promise<object>} */
  async embed(input) {
    throw new Error('Not implemented')
  }
}
```

Application chỉ nhận result đã qua runtime schema validation. Provider adapter chịu trách nhiệm auth, timeout, closed error taxonomy và schema parse. Application gọi workload policy, không chứa vendor/model string. Không expose model picker hoặc arbitrary endpoint cho admin/client.

Mỗi generated artifact lưu provider/model/version/input hash và thời điểm tạo. Log chỉ giữ metadata vận hành, không giữ prompt chứa full text.

Provider config là server/operator-owned graph, không phải admin input:

```text
Installed adapter: adapterId, protocol, supportedOperations
examples: openai-compatible-chat, openai-compatible-embedding, gemini-native

Provider failure domain: providerFailureDomainId, configVersion,
failureThreshold=3, cooldownSeconds=60

Provider instance: providerId, providerFailureDomainId, adapterId,
trustedEndpointProfileId

Admission domain: admissionDomainId, providerId, credentialEnvName,
maxConcurrency<=8, budgetLimit, budgetWindow

Route: routeId, providerId, admissionDomainId, model, operations,
capability: zdr-verified|nonconfidential,
evidenceUrl, reviewedAt, evidenceExpiresAt, artifactCompatibilityId,
embeddingDimensions, embeddingVersion, enabled,
routeFailureThreshold=3, routeCooldownSeconds=60

Workload policy: workloadId, maxExternalAttempts,
primaryRouteId, modelFallbackRouteIds, providerFallbackRouteIds
```

`providerFailureDomainId` đại diện shared transport/control-plane outage. `admissionDomainId` đại diện credential/account/billing pool của đúng một `providerId`; route `providerId` phải bằng provider của admission domain. `trustedEndpointProfileId` chỉ chọn profile đã cài/review với exact HTTPS origin/path, không URL credential, không redirect và không arbitrary env URL. Startup fail nếu graph có dangling/cycle/duplicate reference, adapter/profile không hỗ trợ operation, endpoint profile không exact-safe, credential bị tách domain, route/provider/admission mapping sai, evidence thiếu/hết hạn hoặc workload route hạ capability. Embedding route bắt buộc khai báo `embeddingDimensions`, `embeddingVersion` và `artifactCompatibilityId`; non-embedding route không được khai báo hai field embedding numeric này. Startup còn enforce model fallback dùng model khác trong cùng failure domain, provider fallback dùng failure domain khác, summary/Q&A `maxExternalAttempts` theo workload policy và mọi embedding fallback có cùng compatibility identity, dimensions và version. Current DeepSeek Q&A route dùng capability `nonconfidential`; sensitive-input/source-policy gate vẫn chặn dữ liệu không được admit. ZDR không thay thế quyền publisher/source policy.

Mongo `providerAdmissionStates` có một document cho mỗi `admissionDomainId`: mọi route cùng credential tranh chung atomic concurrency/cost budget và giữ route circuits. `providerFailureDomainStates` có một document cho mỗi shared transport/control-plane domain, kể cả khi domain đó phục vụ nhiều credentials. Router skip toàn bộ route của open provider domain. Current DeepSeek graph không có model/provider fallback. Summary và Q&A generation vẫn giữ policy cap `maxExternalAttempts=2`, nhưng không có candidate thứ hai nên mỗi operation chỉ dispatch tối đa một provider call; Q&A support có cap 1. Model/provider outage trả unavailable hoặc bounded job retry. Policy/privacy/sensitive-input/config/schema/support error và ambiguous in-flight outcome là terminal. Nếu owner bật candidate fallback trong tương lai, candidate phải nhận exact same immutable admitted input và lặp lại source-policy, capability/evidence, admission/circuit và output validation. Provider/admission log chỉ có domain/route/model/call-kind/latency/result/error code, không raw question/evidence/payload; question chỉ persist trong user-owned chat contract.

Embedding provider fallback chỉ hợp lệ khi candidate có cùng `artifactCompatibilityId`: model revision, dimensions, preprocessing/normalization và embedding version. Candidate khác compatibility identity không được dùng runtime; hệ thống degrade về text search hoặc chạy controlled version cutover + full re-index.

Q&A idempotency ưu tiên không duplicate side effect hơn transparent retry: duplicate cùng key/hash poll/reuse attempt. `provider-running` quá reservation deadline chuyển bằng CAS sang terminal safe `ambiguous_provider_outcome`; cùng key không được phát thêm provider call vì hệ thống không chứng minh call cũ chưa ra ngoài. User có thể chủ động retry bằng intent/key mới và quota mới sau khi UI giải thích outcome không chắc chắn.

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
- `413` cho request target/body vượt bound; `415` cho non-JSON hoặc non-identity content encoding;
- `GET /api/v1/me` bootstrap session-bound CSRF token; mutation cookie-auth yêu cầu header và không dùng localStorage;
- admin mutation yêu cầu CSRF và action-specific allowlisted `reasonCode` khi operation nhạy cảm; requester/account case text không được copy vào audit;
- grounded answer, article status/topics/media patch và manual job/source-reconciliation/deletion/retry hỗ trợ `Idempotency-Key`; reuse khác request hash trả `409 idempotency_mismatch`; answer window 24 giờ, job/governance tối thiểu 14 ngày.
- Vercel Cron dùng protected `GET /api/internal/cron/due-work`; manual admin trigger vẫn là POST;
- maintenance dùng protected fixed-enum `GET /api/internal/maintenance/{taskName}`; browser/admin auth và caller filter/cutoff bị reject;
- stable error code dùng enum trong OpenAPI; client không branch theo message;
- rate-limit trả `429` và `Retry-After`.

OpenAPI là authority cho payload/nullability/enum/error. Prose trong file này không được dùng để âm thầm đổi shape.

## 11. Security controls

| Boundary                        | Control bắt buộc                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → API                   | same-origin only, exact Origin, strict 8 KiB target/64 KiB identity-encoded JSON, flat query parser, `__Host-` cookie, session, CSRF, trusted-IP rate limit                                                                                                                     |
| Admin route                     | session + role + transition validation + atomic safe audit                                                                                                                                                                                                                      |
| Cron → API                      | GET + Bearer `CRON_SECRET`, no cookie/CSRF, idempotency                                                                                                                                                                                                                         |
| API → source URL                | canonical HTTPS không credential; normalize mapped address, validate mọi A/AAAA, reject answer set có bất kỳ private/loopback/link-local/unspecified/multicast/reserved IP, pin connection vào validated public IP, manual redirect validation, timeout/size/content-type limit |
| Browser → media host            | current media policy, HTTPS host allowlist, CSP `img-src`, referrer policy, no arbitrary backend proxy                                                                                                                                                                          |
| Source payload/text → parser/AI | safe fetch + decoded limits, no-network XML parser, policy gate, sanitize/extract, delimit untrusted evidence, no tools                                                                                                                                                         |
| API → provider                  | privacy capability + sensitive-input gate, idempotent attempt, concurrency/budget/circuit, scoped input, timeout, metadata-only log                                                                                                                                             |
| API → MongoDB                   | least-privilege connection, indexed queries, no raw secret/full text                                                                                                                                                                                                            |
| Machine → maintenance           | cron bearer, fixed task table, indexed deadline + `_id`, batch<=100, safe aggregate only                                                                                                                                                                                        |

Safe-fetch không được validate hostname rồi để HTTP client tự resolve lại. IPv4-mapped IPv6 phải normalize về IPv4 trước CIDR classification; nếu một answer không public thì reject toàn bộ mixed answer set. Adapter chọn một IP từ tập A/AAAA đã validate và pin actual connection tới IP đó trong khi giữ original hostname cho HTTP Host/TLS SNI/certificate verification. Redirect dùng `redirect=manual`, tối đa cấu hình nhỏ; mỗi `Location` được resolve/canonicalize/validate/pin lại. URL rendered ra browser cũng phải qua canonical `HttpsUrl`, cấm username/password; external anchor dùng `rel="noopener noreferrer external"`.

Source response giữ wire bytes tối đa 1 MiB, decoded bytes tối đa 4 MiB và expansion ratio tối đa 20; vượt bound abort trước parse. RSS/Atom chỉ chấp nhận `application/rss+xml`, `application/atom+xml`, `application/xml`, `text/xml`. XML parser cấm `DOCTYPE`, external general/parameter entity, XInclude, entity expansion và mọi network resolver; depth<=64, node<=20.000, item<=100, field<=20.000 ký tự, parse deadline 2 giây. Reject tạo redacted `source_payload_rejected`, không retry vô hạn và test phải chứng minh zero secondary DNS/network call.

Password dùng password hashing library được duy trì với cost cấu hình. Session token và reset-like token chỉ lưu hash. Log structured luôn có `requestId`; job log thêm `jobId`/`sourceId` nhưng không chứa credential, session ID, source body hoặc private chat.

Login, register, AI Q&A, admin trigger và source technical check dùng atomic Mongo-backed rate-limit/quota buckets. `subjectType`/scope mapping là `login|register→ip`, `answer-*→user`, `admin-trigger→admin`, `source-test→source`; login=10/15 phút, register=5/60 phút và check trước password hash/write. Vercel adapter lấy platform-overwritten `x-forwarded-for` theo [official request-header contract](https://vercel.com/docs/headers/request-headers); application không chọn arbitrary caller chain. Local/test adapter phải explicit.

`keyHash` là keyed HMAC của opaque subject, không là email/raw IP; mỗi bucket giữ thêm `keyFingerprint` để phát hiện secret bị thay khi giữ nguyên version. Keyring env có một current + tối đa hai retiring versions nhưng không là lifecycle authority. `hmacKeyLifecycleSnapshots` giữ full version inventory bằng append-only revision/hash-chain; mỗi snapshot mới giữ nguyên mọi predecessor, chỉ cho `current→retiring→retired`, chặn missing revision/hash, version rollback, fingerprint/successor contradiction. Successor activation lấy từ lần transition được Mongo ghi nhận, không từ operator timestamp. Retirement transaction đọc durable history, check riêng successor >=30 ngày và zero exact-version record trong rateLimitBuckets/sessions/adminAuditLogs rồi append snapshot có zero evidence. Startup reconcile trước khi serve và sau đó vẫn reject unknown version/fingerprint. Read/delete derive mọi non-retired version và migrate/consolidate transactionally. Account deletion direct-delete answer attempts và mọi-version user Q&A buckets, không đụng shared IP anti-abuse state.

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

### 12.2. Audit integrity boundary

Audit event có deterministic unique `eventId`. Direct mutation dùng **một transaction-capable Mongo client/credential/session**: custom role cấp mutation cần thiết trên domain collections nhưng chỉ `insert/find` trên `techpulse_app.adminAuditLogs`, `insert/find` trên append-only `hmacKeyLifecycleSnapshots` và `insert/find` trên governance suppression collection; không có update/delete ở ba boundary này. Vì cùng identity/session, domain mutation + audit insert và terminal deletion/takedown + signed suppression insert có thể commit/rollback atomically across pre-created collections/databases; MongoDB chính thức hỗ trợ transaction qua nhiều database trong cùng deployment ([MongoDB Transactions](https://www.mongodb.com/docs/v8.0/core/transactions/)). Integration test bằng credential thật phải chứng minh audit/suppression insert fail thì domain transaction rollback và audit/lifecycle update/delete bị từ chối.

IP-HMAC field-unset dùng client/credential riêng qua `MONGODB_MAINTENANCE_URI_ENV`, fixed task predicate và batch<=100. URI/identity phải khác runtime; thiếu config chỉ disable `purge-audit-ip-hmac` và làm maintenance-retention release gate fail, không được fallback sang runtime credential. Full event purge, offline checkpoint key custody, signed retention manifest và restore verifier thuộc recovery track hậu MVP; không là điều kiện phục vụ MVP.

### 12.3. Backup/restore serving gate hậu MVP

MVP không thực hiện hoặc yêu cầu backup/restore rehearsal. Recovery track hậu MVP dùng manual `mongodump` khi owner phê duyệt. Dump `techpulse_app` dùng read-only backup credential tách runtime, lưu tối đa 7 ngày trong owner-only OS/provider-encrypted private storage ngoài repo, không upload public và destruction được ghi vào runbook. Đây là backup copy, không phải live system of record. Cùng inventory tạo signed read-only sidecar export của `techpulse_governance` để khôi phục khi cả Atlas deployment mất; inventory ghi backup ID/time/database/checkpoint/key IDs/location/access owner/destroyAt, không ghi secret.

Restore mặc định vào isolated non-serving `techpulse_app_restore_*` database với credential không có trong production Vercel; không overwrite `techpulse_governance`. Trước promotion, restore runner đọc current signed suppression/checkpoint từ governance database. Nếu Atlas deployment mất, operator restore governance sidecar trước bằng owner credential rồi verify chain/signature; thiếu/invalid sidecar thì serving gate đóng. Account-deletion entry chỉ giữ `deletionRequestId`, opaque `userId`, `effectiveAt`; takedown entry chỉ giữ `takedownRequestId`, `targetType`, opaque `targetIds`, `requestedScope`, `effectiveAt`. Không giữ email, requester contact/reason, chat hoặc source text. Signed checkpoint phải cover terminal governance event mới nhất; mất continuity hoặc governance database không available thì serving gate đóng.

Runner replay ledger bằng fixed reconciliation. Restore luôn direct-delete toàn bộ sessions, rate-limit/quota buckets, answer-attempt receipts và active provider admission reservations; provider failure-domain state phải được reconcile với current config version trước traffic, không tin circuit state từ snapshot cũ. Unset audit IP-HMAC nếu key continuity không chứng minh được. Với từng deletion entry, runner xóa saved/chat còn phục hồi và re-apply closed user tombstone; với từng takedown entry, runner re-apply artifact/citation suppression. Sau đó verify target-specific zero matches + audit checkpoint; thiếu current entry/actionable target thì serving gate đóng. Production restore rotate session/CSRF/HMAC material liên quan và runtime Mongo credential trước traffic; credential cũ bị revoke để stale function không ghi vào target. Rehearsal bắt đầu bằng snapshot trước deletion+takedown và chỉ pass khi restored PII/session/available citations đã bị loại lại.

## 13. Testing strategy

| Layer                   | Mục tiêu                                                                                                                             | Requirement tiêu biểu                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| Unit                    | state transition, scope gate, HTTPS canonicalization, dedupe, score                                                                  | SRC-004..007, ING-007..009, SEARCH-004 |
| Contract                | request/response, cookie/cache/ingress/idempotency và invalid conditional fixtures validate cùng OpenAPI                             | AUTH/USER/ART/ADMIN endpoints          |
| Integration             | Mongo indexes/explain, repository predicates, fencing/idempotency, HMAC rotation, session/deletion                                   | AUTH-002..006, ING-004, ART-002        |
| Connector               | fixture RSS/arXiv/HN, XXE/XInclude/entity/nesting/decompression → bounded candidate/error                                            | ING-001, ING-007                       |
| Provider adapter/router | graph validation, privacy admission, credential budget, route/provider circuits, failure-class fallback; không network thật mặc định | AI-001..010, QA-008                    |
| Media policy/UI         | mode/host/attribution, null/fallback, broken remote image, video link-only                                                           | SRC-009, ART-007, ADMIN-008, NFR-011   |
| Retrieval eval          | top-5 relevance, refusal, hidden-content exclusion, citation precision                                                               | SEARCH-005..006, QA-002..007           |
| E2E                     | login → feed → detail → source; admin source → job → audit                                                                           | MVP gates                              |

Test quan trọng nhất là negative invariant: một article hidden/removed/review-needed hoặc source bị blocked tuyệt đối không xuất hiện trong feed, search hay evidence context; `community-signal` không xuất hiện trong Q&A evidence nhưng vẫn có ở feed/search. Tương tự, media từ host/mode không được duyệt không được serialize và media `not-analyzed` không hỗ trợ factual claim. Contract test còn phải reject cookie/header/Origin/CORS sai, oversized/compressed/non-JSON ingress, unknown/duplicate/operator query, `/answers` thiếu idempotency, answered rỗng/không citation, refused có factual paragraph, policy/connector mismatch, unavailable citation còn URL/title, deleted user còn role/email và operation-specific reason code sai.

Integration/security suite phải có: concurrent register/login trusted-IP atomic limit và spoofed forwarding header; 20 same-session/key answers → one quota/provider/chat append; cùng-credential admission contention; model failure chọn same-domain model fallback; provider outage mở provider-domain circuit và chọn cross-domain fallback; policy/privacy/ambiguous errors không fallback; email/token sentinel không tới nonconfidential route; embedding compatibility mismatch degrade về text; real visible nhưng irrelevant evidence block phải refuse; XXE/parameter entity/XInclude/decompression tạo zero secondary network; old-HMAC bucket rotation giữ quota và deletion zero-verifies; lifecycle kill-test bỏ đồng thời retiring key + config declaration vẫn giữ predecessor, age/three-collection zero gate và hash-chain rollback detection; due/retention/source-citation/account-deletion recovery `explain` không scan/sort blocking; deleted raw tombstone closed allowlist; fixed maintenance auth/scope; real runtime Mongo role rollback domain mutation khi audit/suppression insert denied và deny update/delete; actual configured Atlas deployment probe chứng minh transaction ghi được vào pre-created `runtimeCapabilityProbes` ở cả hai logical database bằng cùng client/session, cleanup/abort để zero residue; crash/fencing/reconciliation/delayed-write/takedown races cũ.

Recovery track hậu MVP bổ sung: governance checkpoint phát hiện tamper/old app restore; pre-deletion app snapshot + sidecar rehearsal reject old sessions/PII/citations; isolated restore reconciliation và serving gate. Các kiểm thử này không chặn MVP.

MongoDB hỗ trợ transaction qua nhiều database khi chúng nằm trong cùng deployment ([MongoDB Transactions](https://www.mongodb.com/docs/manual/core/transactions/)), nhưng đây không được coi là bằng chứng cho cấu hình Atlas cụ thể của dự án. Step 11 phải chạy probe cross-database thật bằng runtime credential/role trên cluster đã cấu hình. Probe fail, transaction bị deployment/role chặn hoặc không thể pre-create/index governance collection đều **block handoff**; không được âm thầm chuyển sang eventual write, best-effort export hay system of record khác.

## 14. Failure/degradation behavior

| Dependency lỗi                                   | User/admin thấy gì                                          | Dữ liệu/hành vi                                                                                                                                         |
| ------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MongoDB                                          | `503` có request ID                                         | Không fake success; mutation không được ghi nhận                                                                                                        |
| RSS/arXiv/HN                                     | Job partial/failed                                          | Existing articles vẫn phục vụ; retry bounded                                                                                                            |
| Model route lỗi retryable                        | Có thể thử model fallback                                   | Chỉ route cùng provider domain; tối đa hai external attempts                                                                                            |
| Provider domain lỗi retryable                    | Có thể thử provider fallback                                | Route fallback phải thuộc failure domain khác và pass privacy/admission                                                                                 |
| Không còn candidate hợp lệ                       | Summary/Q&A unavailable rõ ràng                             | Feed/detail/citation nguồn vẫn dùng được; không hạ policy                                                                                               |
| Provider privacy/admission/circuit không phù hợp | Q&A refused/unavailable + retry hint                        | Không gửi raw question, không reserve thêm quota/provider call trùng                                                                                    |
| Embedding unavailable/incompatible               | Q&A fallback về lexical + taxonomy; search fallback về text | Vector chỉ dùng khi version/input/compatibility còn hợp lệ; `sensitive-input` refuse trước embedding                                                    |
| Ảnh remote lỗi/bị chặn                           | Visual fallback, link bài gốc vẫn hoạt động                 | Không backend-proxy hoặc lưu bản sao để che lỗi                                                                                                         |
| Cron due-work không chạy                         | Admin overview cảnh báo stale queues/ingestion              | Manual trigger dùng cùng service; durable queued/running state không mất                                                                                |
| Maintenance credential thiếu                     | Audit IP-HMAC retention báo unavailable                     | Chỉ `purge-audit-ip-hmac` bị disable và maintenance-retention release gate fail; core runtime/fixed task khác không dùng runtime credential để thay thế |
| Audit write lỗi trong direct admin mutation      | Mutation thất bại với request ID                            | Mongo transaction abort; không có state change không audit                                                                                              |
| Account deletion cleanup lỗi                     | Admin thấy failed item an toàn                              | Session vẫn revoked; retry chỉ item chưa hoàn tất, không restore identity                                                                               |
| Live governance evidence thiếu                   | Mutation/serving fail closed                                | Không ghi terminal suppression khi governance unavailable hoặc signature invalid                                                                        |

## 15. Architecture acceptance checklist

- [ ] Mọi endpoint implementation map tới operation trong OpenAPI.
- [ ] Same-origin/CORS, exact Origin, `__Host-` cookie/clear tuple, no-store/private cache và strict target/body/query ingress pass browser/contract tests.
- [ ] Frontend JavaScript client/JSDoc và mock được derive từ OpenAPI.
- [ ] Repository user-facing dùng visibility predicate chung.
- [ ] Source scope được kiểm tra ngay trước mọi provider call.
- [ ] Job/lease/idempotency test vượt qua duplicate, request-hash mismatch, crash recovery, generation high-water persistence và stale lease-generation case.
- [ ] Canonical key test chứng minh cron/manual cùng source contend; heartbeat hết hạn không resurrect; account deletion recovery giữ same request/flags.
- [ ] Queue-local priority + reserved fairness cho mỗi registered due queue bounded progress; unregistered queue zero counter và không query collection.
- [ ] Two-lane queue selection và mọi retention/citation deadline path dùng exact index + `_id`; `explain` không có COLLSCAN/blocking sort.
- [ ] Ingestion final transaction fail nếu source policy/config/state đổi và không advance checkpoint.
- [ ] Reconciliation marker mutation CAS exact version/status/cursor; worker N không ghi lên N+1.
- [ ] AI artifact commit thất bại nếu current source policy version khác job expectation.
- [ ] Safe-fetch pin actual connection tới validated public IP; DNS rebinding/mixed/mapped/redirect-to-private fixtures đều bị chặn.
- [ ] Mọi rendered external URL là HTTPS không credential và external anchor có rel an toàn.
- [ ] Text search hoạt động khi embedding adapter bị tắt.
- [ ] Citation serializer không nhận URL do model tạo.
- [ ] Q&A same-key concurrency chỉ tạo một attempt/quota/provider/chat result; sensitive input không tới DeepSeek nonconfidential route, admitted input qua community/irrelevant-block support gates và current graph không tạo fallback call.
- [ ] Q&A generation/support giữ generation/support payload dưới 30.000 ký tự, support chỉ nhận cited blocks và final fence bind exact bounded text + citation metadata của cited targets.
- [ ] Support verifier coi toàn bộ question/paragraph/evidence JSON là untrusted data và bỏ qua embedded instructions.
- [ ] Local-control interruption release provider admission bằng `cancelled`, không poison provider circuit hoặc kích hoạt fallback.
- [ ] Half-open provider-domain probe hết hạn sau cooldown và có thể được probe mới thay thế; stale probe không khóa circuit vĩnh viễn.
- [ ] Q&A cold start verify exact live `qa-evidence-fence` validators sau signed attestation; `provider-routing-v2` và `governance` reapply fenced validator cuối migration tổng hợp.
- [ ] Migration downgrade guard chặn chạy lại `sources|articles|indexing-jobs|chat-sessions` cũ sau provider-routing-v2 marker.
- [ ] XML parser cấm DOCTYPE/entity/XInclude/network resolver và wire/decoded/depth/node/time limits pass adversarial fixtures.
- [ ] Takedown ẩn trước, redacts historical citation URL/title, xóa/index cleanup sau và chỉ completed khi chat evidence true.
- [ ] Account deletion revoke session trước, direct-delete/zero-verify session/answer-attempt, zero-verify user quota theo mọi key version còn hiệu lực và closed user tombstone trước `completed`; shared IP bucket không bị xóa, delayed Q&A không tái tạo user data.
- [ ] Retention owner tạo TTL/indexed cleanup cùng migration; TTL không được dùng làm authorization, completion evidence hoặc fencing.
- [ ] Fixed maintenance route chỉ nhận enum task + machine bearer; caller không điều khiển collection/filter/cutoff/batch.
- [ ] HMAC keyring rotation không reset quota; append-only lifecycle không quên predecessor khi env bỏ key và old key chỉ retire sau Mongo-recorded 30 ngày + zero dependent rate-limit/session/audit records.
- [ ] Direct admin mutation không thể commit nếu safe audit event không commit.
- [ ] Same runtime session/identity rollback domain mutation khi audit/suppression insert fail; audit/suppression update/delete bị deny; live governance signature/checkpoint state fail closed khi invalid.
- [ ] Actual Atlas deployment probe commit/rollback cross-database transaction qua pre-created `techpulse_app` + `techpulse_governance` collections bằng runtime role; probe fail block handoff và không có best-effort fallback.
- [ ] MVP không phụ thuộc backup/restore rehearsal; recovery evidence được theo dõi ở post-MVP runbook.
- [ ] Không có raw HTML/full text/secret trong MongoDB hoặc log fixture.
- [ ] Không có binary/base64/GridFS media; media ngoài policy bị loại và broken image có fallback.
- [ ] Video chỉ link-only và mọi media MVP mang `mediaEvidenceStatus=not-analyzed`.
- [ ] Build local và Vercel dùng cùng application composition.

## 16. Traceability

| Architecture area                   | PRD requirements                             |
| ----------------------------------- | -------------------------------------------- |
| Session/RBAC                        | AUTH-001..006, ADMIN-005..007                |
| Source Registry/policy gate         | SRC-001..009, AI-001..004/007, QA-004/007    |
| Durable jobs/connectors             | ING-001..009, NFR-001/005/006                |
| Article repository/visibility/media | ART-001..007, SEARCH-002, QA-004, NFR-011    |
| Search/retrieval                    | SEARCH-001..006, QA-002/006                  |
| Provider adapters/citations         | AI-001..006, QA-001..008                     |
| Takedown/audit                      | ADMIN-004/006/007                            |
| Contract/testing                    | NFR-007..010 và toàn bộ MVP acceptance gates |

Mọi thay đổi boundary phải bắt đầu từ PRD/ADR nếu thay đổi ý định, hoặc OpenAPI/data contract nếu chỉ thay đổi interface triển khai.
