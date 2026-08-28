# TechPulse AI — Product Requirements & Capability Contract

> Trạng thái: Plan-of-Record; Steps 1–11 đã implement, ADR-0013/0014 là pre-Step-12 architecture amendment
> Phiên bản: 1.8
> Cập nhật: 15/08/2026
> Product rationale: [PRODUCT-BRIEF.md](./PRODUCT-BRIEF.md)  
> Nguồn quyết định chi tiết: [TechPulse-AI.md](./TechPulse-AI.md)

## 1. Capability

TechPulse AI cung cấp cho sinh viên CNTT và developer Việt Nam một feed công nghệ có nguồn được quản trị, summary tiếng Việt và AI Q&A chỉ trả lời từ bằng chứng đã truy xuất. Sau MVP, người dùng có thể đi từ một chủ đề đến bài gốc để kiểm chứng; admin có thể giải thích nguồn nào được dùng, phạm vi nào được gửi tới AI và điều gì đã xảy ra trong mỗi ingestion/indexing job.

### 1.1. Product promise

> Người dùng nắm nhanh nội dung công nghệ bằng tiếng Việt, biết mỗi kết luận đến từ đâu và có thể mở nguồn nguyên bản để kiểm chứng.

### 1.2. Thành công của capability

- Một nguồn mới chỉ tham gia pipeline sau khi có policy record.
- Một article hợp lệ đi qua ingestion, normalization, summary và retrieval mà không mất provenance.
- Một câu trả lời AI không có evidence phù hợp phải từ chối thay vì dùng kiến thức nền để đoán.
- Mọi citation mở được article gốc và gắn đúng answer block.
- Admin có thể vận hành hệ thống mà không thấy secret hoặc truy cập trực tiếp hạ tầng worker.

## 2. Constraints

### 2.1. Fixed product policy

| Policy                  | Quyết định cố định cho MVP                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Thời gian/nguồn lực     | 4 tuần, scope đủ để một người hoàn thành                                                            |
| Connector               | RSS/Atom, arXiv, Hacker News                                                                        |
| Dataset                 | Khoảng 250–400 article                                                                              |
| Ngôn ngữ output         | Tiếng Việt                                                                                          |
| Citation                | Cấp bài ở detail/summary; cấp đoạn ở AI Q&A                                                         |
| Full text               | Không lưu; chỉ xử lý tạm nếu `fulltext-temporary`                                                   |
| Implementation language | JavaScript/JSX (`.js`, `.jsx`); không dùng TypeScript/TSX trong MVP                                 |
| Media                   | Ảnh remote-preview theo Source Registry; video link-only; không rehost hoặc AI-analyze binary media |
| External content        | Luôn là untrusted data                                                                              |
| Source approval         | Technical check tự động, policy approval thủ công                                                   |
| Human role              | `user`, `admin`                                                                                     |
| Internal actor          | `system-worker`                                                                                     |
| Deployment              | Vercel Hobby, public URL tạm thời phục vụ chấm đồ án                                                |

### 2.2. Reversible architecture preferences

| Area               | Lựa chọn MVP                                                                                        | Điều kiện thay đổi                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Database           | MongoDB Atlas                                                                                       | Chỉ đổi sau MVP                                                                                              |
| Keyword search     | MongoDB text index                                                                                  | Có thể chuyển Atlas Search khi scale tăng                                                                    |
| Embedding          | Route cấu hình theo workload, với pinned compatibility identity                                     | Đổi vector space phải tăng version và re-index toàn corpus                                                   |
| Semantic search    | Cosine similarity trong Node.js                                                                     | Chuyển Vector Search khi dataset lớn                                                                         |
| LLM primary        | Server chọn route từ workload policy; route chứa provider, model, operation và capability evidence  | Provider/model cụ thể là deployment config, không là business invariant                                      |
| Model fallback     | Model khác trong cùng provider failure domain                                                       | Chỉ lỗi `model-retryable`; không được hạ privacy capability                                                  |
| Provider fallback  | Route thuộc provider failure domain khác                                                            | Chỉ lỗi `provider-retryable` hoặc domain unavailable; vẫn pass admission/support gate                        |
| Q&A provider route | Current route được owner chấp thuận ở capability `nonconfidential` cho DeepSeek `deepseek-v4-flash` | Sensitive input vẫn refuse; route unavailable thì refuse/unavailable, không có fallback trong graph hiện tại |
| Scheduler          | Vercel Cron + admin trigger                                                                         | Có thể chuyển durable worker hậu MVP                                                                         |

### 2.3. Trust boundaries

- Browser là untrusted client; role và object authorization luôn kiểm tra ở backend.
- Source URL/config do admin nhập vẫn là untrusted input.
- RSS/API/article body là untrusted content và có thể chứa prompt injection.
- Vercel Cron request chỉ được tin cậy sau khi xác thực `CRON_SECRET`.
- LLM/embedding provider là third party; input phải qua policy gate và redaction.
- MongoDB Atlas là system of record duy nhất: `techpulse_app` giữ runtime state; `techpulse_governance` giữ signed suppression/checkpoint/retention state.
- `techpulse_governance` là trust boundary runtime riêng. Backup sidecar và restore target thuộc recovery track hậu MVP; MVP không cam kết backup/restore hoặc serving sau restore.

## 3. Implementation contract

### 3.1. Actors

| Actor              | Mục tiêu                         | Quyền chính                                                     |
| ------------------ | -------------------------------- | --------------------------------------------------------------- |
| Guest              | Truy cập entry/auth surface      | Đăng ký, đăng nhập                                              |
| User               | Theo dõi và hỏi về tin công nghệ | Feed, search, detail, save, AI Q&A                              |
| Admin              | Vận hành và xử lý ngoại lệ       | Sources, jobs, articles/index, users, takedowns, audit          |
| System worker      | Thực thi bounded job             | Ingest, normalize, summarize, embed, index                      |
| Cron caller        | Kích hoạt lịch                   | Gọi protected ingestion endpoint                                |
| Maintenance caller | Chạy retention task cố định      | Machine bearer + fixed task name; không có caller filter/cutoff |
| Publisher/source   | Cung cấp dữ liệu ngoài           | Không có quyền trong hệ thống; bị giới hạn bởi Source Registry  |
| AI provider        | Tạo summary/answer/vector        | Chỉ nhận input đã được policy gate cho phép                     |

### 3.2. User-facing surfaces

1. Register/Login.
2. Topic onboarding/preferences.
3. News feed.
4. Search/filter results.
5. Article detail.
6. Saved articles.
7. AI Q&A panel/page.
8. Account/data controls.

### 3.3. Admin surfaces

1. Overview.
2. Sources.
3. Ingestion Jobs.
4. Articles & AI Index.
5. Takedown Requests.
6. Users.
7. Audit Logs.

## 4. Functional requirements

### 4.1. Authentication và account

| ID       | Requirement                                                     | Acceptance summary                                                                                                                                                                                                        |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-001 | Guest có thể đăng ký account `user`                             | Client không thể đặt role khác                                                                                                                                                                                            |
| AUTH-002 | User/admin có thể login/logout                                  | Session lưu server-side; cookie HttpOnly/SameSite/Secure                                                                                                                                                                  |
| AUTH-003 | Backend phân biệt unauthenticated và unauthorized               | Trả `401` và `403` đúng trường hợp                                                                                                                                                                                        |
| AUTH-004 | Admin đầu tiên được tạo bằng seed/deployment operation          | Không có public admin registration                                                                                                                                                                                        |
| AUTH-005 | Khóa user làm mất hiệu lực mọi session hiện có                  | Request tiếp theo bị từ chối                                                                                                                                                                                              |
| AUTH-006 | User có thể yêu cầu xóa account bằng durable automatic workflow | Session bị revoke rồi direct-delete/verify; chat/saved/answer-attempt và mọi user Q&A quota bucket theo key version còn hiệu lực bị xóa, shared IP security bucket giữ riêng; mọi cleanup có completion evidence và audit |
| AUTH-007 | Browser auth/API là same-origin với cookie contract đóng        | `__Host-techpulse_session`, Secure/HttpOnly/Path=/SameSite=Lax/no Domain; exact Origin, no credentialed CORS, no-store auth responses                                                                                     |
| AUTH-008 | Login/register chống abuse bằng trusted client-IP bucket        | Fixed atomic limits chạy trước password hash/write; arbitrary forwarding header không tạo bucket mới                                                                                                                      |

### 4.2. User preferences và saved articles

| ID       | Requirement                         | Acceptance summary                                  |
| -------- | ----------------------------------- | --------------------------------------------------- |
| USER-001 | User chọn topic quan tâm            | Preferences tồn tại qua session                     |
| USER-002 | User lưu/bỏ lưu article             | Operation idempotent, không tạo duplicate           |
| USER-003 | User xem danh sách saved articles   | Chỉ thấy dữ liệu của chính mình                     |
| USER-004 | User xóa saved history/chat history | Dữ liệu liên quan bị xóa hoặc anonymize theo policy |

### 4.3. Source Registry

| ID      | Requirement                                                   | Acceptance summary                                                                                               |
| ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| SRC-001 | Admin tạo/sửa source definition                               | Validate connector-specific config                                                                               |
| SRC-002 | System chạy technical check                                   | HTTPS/no-credential URL; validate mọi A/AAAA, pin actual connection và kiểm tra từng redirect/content type/parse |
| SRC-003 | Admin ghi nhận publisher, Terms/License và evidence           | Có reviewedBy/reviewedAt                                                                                         |
| SRC-004 | Source có rights status độc lập operational status            | Không trộn `paused` với `metadata-only`                                                                          |
| SRC-005 | Không rõ quyền thì mặc định `metadata-only`                   | Không có implicit `permitted`                                                                                    |
| SRC-006 | Backend enforce `llmInputScope` và `storageScope`             | Request vượt scope bị chặn/log                                                                                   |
| SRC-007 | Source `blocked`/`review-needed` không chạy production ingest | Technical sample là ngoại lệ có giới hạn                                                                         |
| SRC-008 | Admin pause/archive source                                    | Không tự xóa historical article                                                                                  |
| SRC-009 | Source có `mediaPolicy` độc lập với quyền dùng text           | Ảnh/video chỉ hiển thị theo mode và host đã duyệt                                                                |
| SRC-010 | Policy fields tuân theo compatibility matrix                  | Contract-valid payload không thể nâng quyền xử lý                                                                |
| SRC-011 | Terms change đưa source về re-review fail-closed              | Source tự pause, tăng policyVersion và atomically persist pending reconciliation marker                          |
| SRC-012 | Reconciliation worker không được ghi đè policy marker mới     | Mọi marker mutation CAS exact policy version/status/cursor; completed version bằng required version              |

### 4.4. Ingestion và normalization

| ID      | Requirement                                                             | Acceptance summary                                                                                                |
| ------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ING-001 | Ba connector hoạt động qua common interface                             | Output normalize về common article schema                                                                         |
| ING-002 | Protected cron chạy bounded cross-queue due work                        | Materialize daily ingestion intent idempotently; trả recovery + per-queue aggregate, không trả heterogeneous jobs |
| ING-003 | Admin có thể trigger cùng job service                                   | Không bypass policy/lock                                                                                          |
| ING-004 | Job có idempotency key và distributed lock                              | Duplicate invocation không duplicate article                                                                      |
| ING-005 | Job ghi new/duplicate/skipped/error counts                              | Admin xem được lỗi đã redact                                                                                      |
| ING-006 | Retry chỉ áp dụng lỗi retryable và có giới hạn                          | Không retry vô hạn                                                                                                |
| ING-007 | Canonicalize URL/time/language/topic                                    | Output nhất quán giữa connector                                                                                   |
| ING-008 | Deduplicate bằng URL, external ID, normalized title/hash                | Ambiguous merge vào review queue                                                                                  |
| ING-009 | Raw HTML không đi thẳng vào AI                                          | Main content được extract/sanitize/chunk                                                                          |
| ING-010 | Lease fencing high-water tồn tại qua expire/release                     | Lease không TTL; crash-after-claim recovery parent trước linked retry và stale worker không commit                |
| ING-011 | Ingestion candidate/checkpoint commit theo current source policy/config | Capture version trước fetch; state/version/config đổi thì discard candidate và không advance checkpoint           |
| ING-012 | Cross-queue due work có bounded fairness                                | Canonical resource keys; mỗi registered due queue có reserved progress trước spill capacity                       |
| ING-013 | RSS/Atom parse fail closed dưới hostile XML/compression                 | No DOCTYPE/entity/XInclude/network resolver; wire/decoded/depth/node/field/time bounds và typed redacted error    |

### 4.5. Article lifecycle, feed và detail

| ID      | Requirement                                                                 | Acceptance summary                                                                      |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ART-001 | Article có provenance và rights snapshot                                    | sourceId, originalUrl, publishedAt luôn có                                              |
| ART-002 | Chỉ `published` xuất hiện ở user surfaces                                   | Hidden/review/removed bị loại ở mọi query                                               |
| ART-003 | Feed filter theo topic/source/time                                          | Pagination ổn định                                                                      |
| ART-004 | Detail hiển thị original metadata, summary basis và CTA nguồn               | Không hiển thị full article/image trái scope                                            |
| ART-005 | Admin hide/restore article theo invariant                                   | Index được đồng bộ                                                                      |
| ART-006 | Admin merge duplicate nhưng giữ mọi source link                             | Provenance không mất                                                                    |
| ART-007 | Article có thể có `leadMedia` đã qua policy                                 | Ảnh được preview hoặc fallback; video chỉ là link và ghi `not-analyzed`                 |
| ART-008 | Mọi external link render cho user/admin là canonical HTTPS không credential | `javascript:`, `data:`, `file:` và credential-bearing URL bị reject trước serialization |

### 4.6. Keyword và semantic search

| ID         | Requirement                                               | Acceptance summary                |
| ---------- | --------------------------------------------------------- | --------------------------------- |
| SEARCH-001 | Search keyword trên original/VI title, VI summary, topics | Hỗ trợ query bỏ dấu               |
| SEARCH-002 | Filter kết hợp status/source/topic/time                   | Không leak non-published article  |
| SEARCH-003 | Published article có thể được embed từ allowed fields     | Lưu model/dimension/version/hash  |
| SEARCH-004 | Query/document dùng cùng embedding model/version          | Mismatch bị từ chối hoặc re-index |
| SEARCH-005 | Backend xếp hạng cosine trên dataset MVP                  | Trả top candidates có score       |
| SEARCH-006 | Embedding outage fallback text search                     | User vẫn nhận kết quả có nguồn    |

### 4.7. Summary và ngôn ngữ

| ID     | Requirement                                                                                  | Acceptance summary                                                                                                                                                                |
| ------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-001 | System tạo `summaryVi` ngắn và `summaryParagraphsVi` chi tiết từ allowed input               | Feed dùng summary ngắn; detail dùng 2–5 đoạn khi detail status `ready`                                                                                                            |
| AI-002 | Summary lưu `summaryBasis`, model và status độc lập cho short/detail                         | Biết được tạo từ metadata/excerpt/fulltext-temp/official-payload và không hiển thị artifact chưa sẵn sàng                                                                         |
| AI-003 | Giữ title/excerpt/language/URL gốc                                                           | Không overwrite source data                                                                                                                                                       |
| AI-004 | Không lưu full text sau xử lý tạm                                                            | Không có field/collection chứa article body lâu dài                                                                                                                               |
| AI-005 | Summary lỗi có retry/review flow                                                             | Không publish summary hỏng như thành công                                                                                                                                         |
| AI-006 | UI gắn nhãn AI dịch/tổng hợp                                                                 | Người dùng biết giới hạn                                                                                                                                                          |
| AI-007 | AI không dùng chi tiết chỉ tồn tại trong media chưa xử lý                                    | Không claim từ ảnh/video có `mediaEvidenceStatus=not-analyzed`                                                                                                                    |
| AI-008 | AI artifact commit match current Source Policy version                                       | Policy đổi trong lúc provider chạy làm output cũ bị discard, không persist                                                                                                        |
| AI-009 | Provider route có capability evidence và expiry                                              | Q&A raw question/evidence đã admit chỉ đi DeepSeek `deepseek-v4-flash` trên `nonconfidential`; sensitive-input/source-policy gate không được bypass                               |
| AI-010 | Admission và route/provider circuits bảo vệ cost và availability                             | Routes dùng cùng credential tranh chung Mongo admission-domain concurrency/budget; route circuit tách provider-domain circuit; một logical operation tối đa hai external attempts |
| AI-011 | Ba connector seed được phép dùng payload đã normalize cho summary với prompt-injection fence | Exact `sourceKey` được duyệt; nội dung vẫn là untrusted data trong delimiter, không gọi tool và không lưu raw HTML/provider payload                                               |

### 4.8. AI Q&A và citation

| ID     | Requirement                                                                                                    | Acceptance summary                                                                                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA-001 | User hỏi theo article/topic/time range                                                                         | Input được validate và rate-limit                                                                                                                     |
| QA-002 | Backend retrieve evidence trước LLM call                                                                       | Không answer trực tiếp từ model memory                                                                                                                |
| QA-003 | Mỗi answer paragraph có citations[]                                                                            | Citation mở đúng original URL                                                                                                                         |
| QA-004 | Citation chỉ trỏ published/allowed article                                                                     | Hidden/removed không được dùng                                                                                                                        |
| QA-005 | Conflicting sources được trình bày riêng                                                                       | Không tự che giấu mâu thuẫn                                                                                                                           |
| QA-006 | Thiếu evidence dẫn tới refusal                                                                                 | Không bịa câu trả lời                                                                                                                                 |
| QA-007 | Prompt injection trong evidence không thay đổi instruction/tool use                                            | External text chỉ là quoted data                                                                                                                      |
| QA-008 | Current DeepSeek graph không có model/provider fallback; lỗi retryable dùng unavailable hoặc bounded job retry | Không gửi cùng admitted input sang route khác; policy/privacy/validation/schema/support hoặc ambiguous outcome luôn terminal                          |
| QA-009 | Delayed Q&A không tái tạo dữ liệu sau deletion/takedown                                                        | Final write match active user + exact sessionVersion + current article lifecycle; CAS miss discard output                                             |
| QA-010 | Grounded answer có actor/session-scoped idempotency                                                            | Same key/hash chỉ reserve một quota/provider/chat result; khác hash trả `409`                                                                         |
| QA-011 | Community signal chỉ dùng discovery                                                                            | HN vẫn ở feed/search nhưng không eligible cho Q&A evidence/citation                                                                                   |
| QA-012 | Citation runtime kiểm tra support trên exact evidence blocks                                                   | Paragraph trả internal block IDs; unsupported/uncertain deterministic refuse trong MVP                                                                |
| QA-013 | User question qua privacy admission trước provider routing                                                     | Credential/high-risk identifier trả `sensitive-input`; admitted input chỉ tới DeepSeek `deepseek-v4-flash` nonconfidential route và metadata-only log |

### 4.9. Admin operations và governance

| ID                   | Requirement                                                             | Acceptance summary                                                                                                                                    |
| -------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADMIN-001            | Overview hiển thị exceptions cần xử lý                                  | Counts phản ánh source/job/article/index/takedown/account deletion                                                                                    |
| ADMIN-002            | Admin xem/retry/cancel mọi bounded job qua một operational view         | Ingestion/indexing/reconciliation/deletion đều poll và recovery được                                                                                  |
| ADMIN-003            | Admin regenerate summary/re-index article                               | Respect source policy và version                                                                                                                      |
| ADMIN-004            | Admin xử lý takedown end-to-end                                         | Metadata/media reference/summary/vector bị loại đúng scope                                                                                            |
| ADMIN-005            | Admin suspend/restore user                                              | Session revocation hoạt động                                                                                                                          |
| ADMIN-006            | Mọi state-changing admin action có safe structured audit                | Actor/target/changedFields/safe transition/action-specific reasonCode/result/time; không snapshot hoặc free-form case text                            |
| ADMIN-007            | Dashboard không hiển thị secret/private chat/password hash              | Redaction được kiểm thử                                                                                                                               |
| ADMIN-008            | Admin review/đổi media policy và ẩn media độc lập                       | Thay đổi có allowlisted reasonCode, policyVersion và audit                                                                                            |
| ADMIN-009            | Admin xem safe article provenance/artifact diagnostics                  | Không expose excerpt/full text/vector/provider payload/private data                                                                                   |
| ADMIN-010            | Takedown redacts historical chat citations trước completion             | Citation unavailable cấm URL/title; completion có machine-readable chat cleanup evidence                                                              |
| ADMIN-011            | Retention cleanup dùng fixed authorized indexed task                    | Machine-only enum, batch<=100, caller không chọn collection/filter/cutoff; deadline query có stable `_id`                                             |
| ADMIN-012 (post-MVP) | Governance/audit survives app restore without resurrecting deleted data | Separate `techpulse_governance` Mongo DB + signed sidecar; terminal suppression insert atomic với workflow, isolated app restore replay trước serving |

## 5. States và transitions

### 5.1. Source

```text
operationalStatus: draft → testing → active ↔ paused → archived
licenseStatus: review-needed → permitted | metadata-only | blocked
```

Rules:

- `active` chỉ hợp lệ khi license là `permitted` hoặc `metadata-only`.
- `blocked` luôn vô hiệu production ingestion.
- Terms change chuyển license về `review-needed`, pause source, tăng `policyVersion` và persist durable pending reconciliation marker trong cùng source mutation; Step 9 mới materialize marker thành visibility/artifact jobs.
- `reviewedBy` và `reviewedAt` do server lấy từ session/time hiện tại; browser không được khai báo hai field này.

#### 5.1.1. Source Policy compatibility matrix

| `licenseStatus` | `llmInputScope` hợp lệ                                  | Ràng buộc `storageScope`                                                                  | Media/user visibility                                  |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `review-needed` | `none`                                                  | Không tạo artifact mới; dữ liệu hiện hữu fail-closed và chờ reconciliation                | Source không active; media không serialize             |
| `blocked`       | `none`                                                  | `metadata/excerpt/summary/embedding=false` cho processing mới                             | Source không active; media mode `none`                 |
| `metadata-only` | `none` hoặc `metadata`                                  | `metadata=true`, `excerpt=false`; `summary/embedding` chỉ được true khi input là metadata | Chỉ field metadata đã duyệt; media theo policy độc lập |
| `permitted`     | `none`, `metadata`, `excerpt` hoặc `fulltext-temporary` | Không có full-text storage; `summary/embedding=true` yêu cầu input scope khác `none`      | Media vẫn phải qua policy/host riêng                   |

Các ràng buộc bổ sung:

- `llmInputScope=none` bắt buộc `summary=false` và `embedding=false`.
- `attributionRequired=true` bắt buộc có `attributionText` đã sanitize.
- Hacker News luôn có `authorityTier=community-signal`; arXiv luôn dùng API và `authorityTier=primary`.
- Connector kind, access method và authority tier phải được validate như một discriminated unit, không phải các field độc lập.

### 5.2. Article

```text
processing → review-needed | published | hidden | removed
published ↔ hidden
hidden → removed
```

- `removed` chỉ restore qua explicit reviewed action nếu nghĩa vụ gỡ cho phép.
- User query luôn thêm predicate `status=published`.

### 5.3. Ingestion/indexing job

```text
queued → running → succeeded | partial | failed | cancelled
failed | partial → queued (retry mới)
```

- Retry tạo attempt mới, giữ link tới original job.
- `running` quá timeout hoặc mất lease (orphaned running job khi lease đã bị giải phóng hoặc bị thế hệ sau ghi đè) được bounded recovery transaction đánh dấu `failed/lease_expired` trước khi tạo tối đa một linked retry (nếu còn lượt attempt).
- `queued` có `availableAt`; từng queue sort theo effective priority, `availableAt`, creation time và `_id`. Coordinator reserve deadline/claim margin rồi cấp một selection attempt cho mỗi registered due queue trước khi spill slot; budget không đủ thì fail safe, priority không so trực tiếp xuyên queue.
- Mỗi shared logical lease key giữ persistent `generationHighWater` không TTL; acquisition sau recovery tăng generation, release chỉ clear active owner.
- Shared lease key derive server-side cho source ingestion, article indexing và source reconciliation; cấm actor/invocation/random job ID. Account deletion là ADR-0014 stable-request exception với inline owner/generation/deadline.
- Ingestion/indexing/reconciliation checkpoint, transition và article/artifact commit conditionally touch exact shared active owner + generation + unexpired lease trong cùng transaction; account deletion cleanup/terminal commit conditionally touch exact inline lease. Ingestion còn match current source version/state/config.

#### 5.3.1. Account deletion recovery

```text
queued → running → completed | failed
expired running | failed → queued (same stable request)
```

- Recovery/admin retry CAS exact request + lease fence, tăng attempt và giữ mọi completion flag đã true.
- Không tạo linked child hoặc `parentJobId`; cleanup chỉ chạy flag còn false.

### 5.4. Summary/embedding

```text
pending → processing → ready | failed | removed
failed → pending (retry)
ready → pending (input/model/version changed)
```

### 5.5. User

```text
active ↔ suspended
active | suspended → deletion-pending → deleted
```

- Account deletion là workflow riêng, tự động và idempotent; không đi qua content takedown hoặc admin approval.
- Tạo deletion request phải revoke toàn bộ session và chuyển user sang `deletion-pending` trước khi cleanup tiếp tục.
- `deleted` chỉ hợp lệ khi sessions, saved articles, chats, answer-attempt receipts và user-scoped quota data đã được xóa/zero-verify; raw document khớp closed tombstone allowlist và mọi completion flag đều được xác minh. Shared IP anti-abuse state không thuộc điều kiện này.
- Audit chỉ giữ opaque user/request ID và safe reason category; không giữ email hoặc nội dung chat đã xóa.

### 5.6. Takedown

```text
received → reviewing → approved | rejected
approved → completed
```

- Takedown MVP chỉ áp dụng cho target `source|article` và scope `metadata|media-metadata|summary|embedding`.
- Quyết định là all-or-nothing: `approved` nghĩa toàn bộ `requestedScope` được duyệt; MVP không có partial approval hoặc `approvedScope` riêng.
- `completed` chỉ hợp lệ khi mọi completion flag tương ứng `requestedScope` đã được xác minh.
- `completed` luôn yêu cầu historical chat citations đã chuyển sang unavailable shape hoặc scan xác nhận không có citation; unavailable citation không còn URL/title/publishedAt.
- Account deletion không được biểu diễn bằng `targetType=user-data` hoặc `scope=account-data`.

## 6. Capability invariants

1. Chỉ article `published` xuất hiện trong feed, search, saved result và AI retrieval.
2. Mọi AI/citation output truy ngược được tới sourceId và originalUrl.
3. `llmInputScope` được kiểm tra server-side trước LLM và embedding call.
4. `metadata-only` không được nâng scope bởi connector hoặc article parser.
5. Full text tạm thời không được persist trong MongoDB/log/cache.
6. Document/query vectors chỉ so sánh khi cùng model, dimensions và version.
7. Source blocked/review-needed không tạo production ingestion job.
8. Job lặp lại không tạo duplicate side effect.
9. Admin UI không phải security boundary; mọi quyền kiểm tra tại backend.
10. State mutation quản trị luôn tạo audit log.
11. External content không được thực thi như instruction hoặc tool call.
12. Deleting/hiding article phải đồng bộ summary, search và embedding visibility.
13. MongoDB không lưu binary/base64/GridFS của ảnh/video nguồn; chỉ lưu metadata, URL và policy snapshot cần thiết.
14. Media chỉ hiển thị khi current source `mediaPolicy` cho phép; video MVP luôn link-only và không được xem là AI evidence.
15. `answered` luôn có paragraph/citation không rỗng, citation resolve tới visible primary/editorial evidence và internal block support verdict là `supported`; `refused` không chứa factual paragraph và có refusal reason.
16. Public serializer chỉ trả summary khi `summaryStatus=ready`; artifact `removed` phải unset content/model/hash và không xuất hiện ở feed/detail/retrieval.
17. Direct admin mutation và audit record commit atomically; workflow dài ghi audit intent trước và terminal result idempotently.
18. Idempotency identity gồm actor scope, key và canonical request hash; reuse key cho intent khác trả conflict.
19. Account deletion completion độc lập content takedown và có machine-readable evidence riêng cho session revoke/delete, answer-attempt delete, mọi-version user quota cleanup, closed tombstone và từng cleanup item còn lại.
20. Delayed user-owned write chỉ commit khi user còn `active` và `sessionVersion` đúng snapshot; account deletion thắng race thì không persist answer-attempt/chat/quota.
21. Reconciliation marker mutation và ingestion article/checkpoint commit đều fence bằng current source policy/config version.
22. Mỗi registered due queue đang có work phải tiến triển trong số invocation hữu hạn dù queue khác backlog liên tục.
23. Shared IP anti-abuse bucket không phải user-owned data; account deletion chỉ xóa bucket `subjectType=user` cho Q&A quota.
24. TTL không là bằng chứng authorization, account deletion completion hoặc lease fencing; retention/cutoff được enforce tại query/worker path.
25. Browser mutation không dựa vào CORS/cookie default mơ hồ: exact Origin, `__Host-` tuple và no-store auth response là invariant.
26. Request vượt ingress bounds hoặc có unknown/duplicate/operator/prototype query bị reject trước route/repository.
27. Q&A privacy/idempotency/provider admission/support gate áp dụng cho current DeepSeek route; graph không có fallback và không route nào được bypass gate.
28. `community-signal` chỉ discovery, không là Q&A evidence trong MVP.
29. HMAC rotation không reset quota; append-only Mongo lifecycle không được quên predecessor khi env bỏ key, deletion derive mọi non-retired key version và old key chỉ retire sau successor >=30 ngày cùng zero dependent records.
30. Live governance database/signature không khả dụng thì terminal governance mutation fail closed; backup/restore serving gate là yêu cầu hậu MVP.

### 6.1. Recovery invariants hậu MVP

Các invariant sau không thuộc MVP release gate: restored app database không overwrite `techpulse_governance` và không serve trước current signed suppression replay, ephemeral auth/quota cleanup, secret rotation và audit checkpoint verification.

## 7. Data ownership và implications

| Data                            | Owner/system of record                           | Retention rule                                                                                                 |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Account/session                 | TechPulse AI / MongoDB                           | Idle 24h, absolute 7d; direct delete/verify khi account deletion                                               |
| Source policy/evidence          | TechPulse AI / MongoDB                           | Giữ audit history                                                                                              |
| Article metadata                | Publisher-originated, TechPulse stores record    | Gỡ theo policy/takedown                                                                                        |
| Media metadata/remote URL       | Publisher-originated, TechPulse stores reference | Không lưu binary; ẩn/xóa theo media policy hoặc takedown                                                       |
| Full text temporary             | Publisher-originated, memory only                | Discard sau request/job                                                                                        |
| SummaryVi                       | TechPulse AI generated artifact                  | Gắn source/model/basis; xóa cùng article nếu cần                                                               |
| Embedding                       | TechPulse AI derived index                       | Rebuildable; xóa cùng article                                                                                  |
| Chat history                    | User/TechPulse AI                                | User xóa trực tiếp; tự hết hạn 30 ngày sau hoạt động cuối                                                      |
| User Q&A quota                  | TechPulse AI / MongoDB                           | TTL theo window; direct delete khi account deletion                                                            |
| Q&A answer-attempt receipt      | TechPulse AI / MongoDB                           | Không raw question; 24 giờ; direct delete khi account deletion                                                 |
| Provider admission/circuit      | TechPulse AI / `techpulse_app` MongoDB           | Per credential admission domain + route/provider-domain circuits; no raw input; project lifetime               |
| Shared IP anti-abuse state      | TechPulse AI / MongoDB                           | TTL 24h; không bị xóa theo user                                                                                |
| Audit log                       | TechPulse AI / `techpulse_app` MongoDB           | Minimized event 180 ngày; IP HMAC unset sau 30 ngày; digest anchored vào signed governance checkpoint          |
| Suppression/checkpoint/manifest | TechPulse AI / `techpulse_governance` MongoDB    | Signed actionable opaque targets + continuity; app dump/restore không overwrite; không case text/PII trực tiếp |
| Backup copy (post-MVP)          | Project owner private encrypted storage          | App dump + signed read-only governance sidecar tối đa 7 ngày; copy phục hồi, không là live SoR                 |

## 8. Security, privacy và policy requirements

- Password hash bằng algorithm phù hợp; không log credential.
- Browser API same-origin only; production không credentialed CORS. Session chỉ ở host-only `__Host-techpulse_session` với Secure/HttpOnly/Path=/SameSite=Lax/no Domain, auth responses no-store/private và exact Origin + CSRF trên mutation.
- Global ingress: request target<=8 KiB, JSON<=64 KiB, `application/json` + identity encoding only; flat allowlisted query parser reject unknown/duplicate/nested/operator/prototype key và oversized IDs.
- Rate limit login, register, AI Q&A, admin triggers và source tests; Vercel-aware IP adapter không tin arbitrary forwarded chain.
- Rate-limit/quota state dùng shared Mongo bucket hoặc platform-native shared limiter; không dùng per-process counter trên Vercel. Mỗi bucket có `subjectType`; user Q&A quota dùng keyed HMAC của opaque user ID, còn shared IP anti-abuse state không thuộc account-deletion cleanup.
- SSRF defense cho source URL: chỉ HTTPS không credential; normalize IPv4-mapped IPv6, validate toàn bộ A/AAAA và reject cả answer set nếu có private/loopback/link-local/unspecified/multicast/reserved IP; actual connection pin vào validated public IP trong khi giữ hostname/SNI; mỗi redirect tự resolve/validate/pin lại; có timeout và response-size limit.
- External source/citation/media/admin link dùng canonical `HttpsUrl`; browser anchor dùng `rel="noopener noreferrer external"`.
- Media URL phải là HTTPS, thuộc exact canonical public-host allowlist của source; wildcard/IP literal/localhost/private resolution bị cấm. Client dùng `referrerPolicy=no-referrer`, không gửi credential và CSP `img-src` chỉ allow `'self'` + reviewed hosts, không blanket `https:`; backend không làm arbitrary media proxy.
- Server-side DNS pinning chỉ bảo vệ server safe-fetch, không bảo vệ direct browser preview; remote media không được coi là trusted evidence và luôn có visual fallback.
- CRON_SECRET/service secret tách khỏi admin/user credential.
- Provider credential chỉ được resolve từ environment/secret-store reference; endpoint profile là server-owned và không nhận từ HTTP/admin.
- Không gửi credential/high-risk identifier, email, token, unapproved chat history hoặc unapproved full text tới provider. Raw Q&A hiện tại chỉ được gửi sau privacy/source admission tới DeepSeek `deepseek-v4-flash` trên capability `nonconfidential`; dữ liệu được gửi có rủi ro retention do DeepSeek không có bằng chứng ZDR hiện hành. Query embedding chỉ được tạo từ câu hỏi đã qua privacy admission và chỉ gửi tới embedding route có capability không thấp hơn Q&A policy; embedding failure/incompatibility phải degrade về lexical/taxonomy retrieval.
- Mọi route có privacy evidence được review và có expiry. Graph hiện tại không có model/provider fallback; nếu bổ sung candidate, candidate không được hạ capability hoặc đổi admitted input.
- RSS/Atom XML parser không network/DOCTYPE/entity/XInclude và có wire/decoded/depth/node/field/deadline bounds.
- Quota/IP HMAC keyring có một current + tối đa hai retiring versions; rate-limit bucket lưu fingerprint để phát hiện đổi secret khi giữ nguyên version. Stable version config không làm lifecycle authority: append-only Mongo snapshot revision/hash-chain giữ history và runtime role chỉ được find/insert. Governance runtime signer dùng keyring tách biệt; offline checkpoint keys và sidecar retention thuộc recovery track hậu MVP, chỉ owner giữ ngoài repo/runtime/DB. Không lưu raw subject/secret/key material.
- Direct domain mutation/audit dùng một transaction-capable runtime Mongo identity/session với per-collection role: domain mutation cần thiết nhưng audit/suppression chỉ insert/find. Separate maintenance/offline credentials không tham gia direct transaction.
- Retention maintenance là machine-only fixed task; full audit-event purge chỉ là owner-offline fixed task có signed retention manifest trong governance DB. Checkpoint phát hiện rollback/tamper ngoài manifest hợp lệ.
- Backup credential, private encrypted app dump, signed governance sidecar và isolated app restore là hậu MVP; không dùng chúng làm điều kiện phục vụ traffic trong MVP.
- Takedown và account deletion có audit nhưng audit không lưu deleted secret/content.

## 9. Non-functional requirements

| ID      | Category                  | Requirement                                                                                                                                                        |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NFR-001 | Reliability               | Job idempotent và recover được sau timeout/cold start                                                                                                              |
| NFR-002 | Performance               | Feed/text search mục tiêu p95 dưới 2 giây, không tính Vercel cold start                                                                                            |
| NFR-003 | AI latency                | Q&A phải hiển thị loading/stream state; timeout có retry/fallback rõ ràng                                                                                          |
| NFR-004 | Scale                     | Hoạt động ổn định với 250–400 article và tối thiểu 10 concurrent demo users                                                                                        |
| NFR-005 | Cost                      | Có daily/user quota; tránh gọi lại summary/embedding khi input hash không đổi                                                                                      |
| NFR-006 | Observability             | Structured logs có request/job/source IDs, không chứa secret/full text                                                                                             |
| NFR-007 | Accessibility             | Core flow dùng được bằng keyboard, có label/focus/error state cơ bản                                                                                               |
| NFR-008 | Portability               | Provider/model/config đổi bằng environment/config, không hard-code business logic                                                                                  |
| NFR-009 | Testability               | Connector, policy gate, retrieval và provider adapter có dependency injection                                                                                      |
| NFR-010 | Legal safety              | Từng source có evidence và review date trước khi active                                                                                                            |
| NFR-011 | Media safety              | Preview có attribution/alt/fallback; host không được duyệt hoặc media lỗi không làm hỏng core flow                                                                 |
| NFR-012 | Durable fencing           | Lease generation high-water không bị TTL/reset; stale worker không commit sau recovery/reacquire                                                                   |
| NFR-013 | Audit minimization        | Audit chỉ lưu allowlisted reasonCode; requester/account case text có access/retention riêng và không được copy                                                     |
| NFR-014 | Privacy retention         | Retention duration được khóa trước migration của collection owner; TTL chỉ cleanup best-effort, không thay correctness check                                       |
| NFR-015 | Secure ingress            | Cookie/CORS/Origin/cache, target/body/query parser và 413/415 được test như common boundary trước business route                                                   |
| NFR-016 | Provider safety           | Privacy capability, credential admission domain, route/provider failure-domain circuit, idempotency và evidence-block support fail closed trên mọi candidate route |
| NFR-017 | Live governance integrity | Indexed cleanup, HMAC rotation và tamper-evident audit không resurrect deleted/taken-down data                                                                     |

Canonical media attribution do server resolve theo thứ tự media credit → source `attributionText` → source name và luôn trả non-empty `leadMedia.attribution`; frontend không tự dựng attribution từ field nullable.

## 10. MVP acceptance gate

MVP chỉ được xem là hoàn thành khi tất cả gate sau đạt:

### Product gate

- Một user mới hoàn thành login → feed → detail → citation → original source.
- User thực hiện được Q&A theo topic/time và hiểu citation thuộc đoạn nào.
- UI tiếng Việt không hiển thị full source content.
- Article có ảnh được phép hiển thị remote-preview; ảnh thiếu/lỗi dùng visual fallback và video quan trọng chỉ mở link nguồn với nhãn AI chưa phân tích.

### Data gate

- Cả ba connector chạy end-to-end.
- Demo seed gồm 8–10 RSS feed, 3 arXiv query và 3 HN streams.
- Duplicate invocation không tạo duplicate article.
- Source policy snapshot tồn tại cho mọi source active.

### AI/retrieval gate

- Text search hoạt động độc lập embedding.
- Configured embedding route trả source relevant trong top 5 cho bộ test/version đã chốt.
- Citation precision mục tiêu ≥90% trên evaluation set.
- Refusal cases không tạo unsupported claim.
- Hidden/removed/review-needed article không xuất hiện trong context.
- HN/community-only scope refuse `insufficient-evidence`; irrelevant visible evidence block không pass support gate.
- Sensitive-input sentinel không tới DeepSeek nonconfidential provider; admitted input pass privacy/support evaluation và current graph không tạo fallback call.

Evaluation protocol được version-control cùng fixture:

- tối thiểu 30 prompt gồm grounded, insufficient-evidence, conflicting-source, hidden/policy-blocked, prompt-injection và media-only cases;
- factual paragraph được tách thành atomic claims trước khi chấm; dataset version và adjudication note không đổi giữa các lần so sánh;
- citation precision = số claim-citation pair thực sự hỗ trợ claim / tổng pair được trích;
- claim coverage = số factual claim có ít nhất một citation hỗ trợ / tổng factual claim;
- unsupported-claim rate = số factual claim không được evidence hỗ trợ / tổng factual claim;
- refusal accuracy = số case cần refuse được refuse đúng / tổng refusal-required case;
- release target: citation precision và claim coverage ≥90%, unsupported-claim rate ≤5%, refusal accuracy ≥90%.

### Operations/security gate

- User không gọi được admin endpoint.
- Hostile/missing Origin, credentialed CORS, sai cookie/cache tuple, oversized/compressed/non-JSON body và query pollution đều bị reject trước repository.
- Concurrent register/login dùng trusted-IP atomic buckets; spoofed forwarding header không mint bucket.
- Cron/manual job dùng persistent fencing, actor-scoped idempotency và cùng canonical source lease key.
- Vercel Cron gọi protected `GET /api/internal/cron/due-work`, recover expired work rồi trả aggregate cho ingestion/indexing/account-deletion; admin manual POST dùng cùng runner nhưng trust boundary riêng.
- Crash-after-claim ingestion/indexing tạo terminal parent + linked retry đúng một lần; account deletion requeue cùng request và giữ completion flags. Lease generation mới lớn hơn generation cũ, expired heartbeat/stale worker không commit.
- Sustained backlog test chứng minh ingestion, indexing và account deletion due queue đều tiến triển hữu hạn; unregistered adapter không query collection và trả zero counter.
- Aged/normal due lanes, retention deadlines và source/article citation cleanup dùng intended index + `_id`; `explain` không COLLSCAN/blocking sort.
- Source bị block/policy/config đổi giữa ingestion fetch làm candidate bị discard, checkpoint không advance; reconciliation N không mutate marker N+1.
- Policy đổi trong lúc fake provider đang chạy làm artifact commit cũ thất bại.
- DNS rebinding/mixed A/AAAA/mapped-private/redirect-to-private và rendered `javascript:|data:|file:`/credential URL đều bị chặn.
- XXE/entity/XInclude/extreme nesting/source decompression bị chặn với zero secondary network call.
- Secret/full text không xuất hiện trong logs/dashboard/database.
- Database scan không có binary/base64 ảnh/video; host media ngoài policy/IP literal không được serialize ra user API và CSP không mở blanket `https:`.
- Takedown xóa/ẩn đúng metadata, media reference, summary/vector và redacts historical citation URL/title trước `completed`.
- Mọi admin mutation có audit record với action-specific `reasonCode`, không có free-form admin reason.
- Same-key Q&A concurrency chỉ reserve/call/append một lần; hai route dùng cùng provider credential tranh một aggregate domain cap/budget; circuit storm chặn thêm primary/fallback và trả retry hint an toàn.
- Account deletion test chứng minh session/answer-attempt direct-delete/zero-match, user quota zero-match theo mọi HMAC version còn hiệu lực và closed tombstone trước `completed`; shared IP bucket không bị xóa; fake delayed Q&A không tạo lại dữ liệu.
- Fixed maintenance task không nhận caller predicate; full audit-event purge không có HTTP route. Real Mongo-role test chứng minh audit insert fail rollback domain mutation và runtime role không update/delete audit. Ordered restore/replay verification là hậu MVP.

### Deployment gate

- Production build deploy thành công trên Vercel Hobby.
- MongoDB Atlas connection/config được lấy từ environment.
- Có local fallback và seed/demo script hoặc documented demo steps.
- Production build, Vercel deployment, Atlas runtime-role/capability evidence và local fallback hoạt động. Backup/restore rehearsal không thuộc MVP deployment gate; recovery track hậu MVP được ghi riêng trong `BACKUP-RESTORE-RUNBOOK.md`.

## 11. Non-goals

- GitHub, YouTube, X, Facebook, Instagram connector.
- Arbitrary web crawler.
- Full-text archive/translation/republication.
- Download/cache/rehost binary media nguồn; arbitrary media proxy.
- Official video embed, transcript extraction và AI image/video analysis.
- Claim-level citation.
- Multi-admin RBAC, MFA, SSO, superadmin.
- Payment, advertising, affiliate hoặc commercial workspace.
- Dedicated vector database/search cluster.
- Fine-tuning proprietary model.
- Production SLA hoặc unrestricted public launch.
- Backup/restore rehearsal, governance sidecar export, offline checkpoint-key custody và serving sau restore.

## 12. Execution questions không chặn Step 1

Các semantics account deletion, takedown all-or-nothing, audit atomicity và scope MVP đã được chốt. Các item sau chỉ cần xác nhận gần step sở hữu:

1. Danh sách cuối cùng của 8–10 RSS feed và evidence đi kèm.
2. Benchmark retrieval để chốt embedding compatibility identity/version/dimensions cho corpus tiếng Việt.
3. Availability/quota của free LLM endpoint tại thời điểm triển khai.
4. Ngày tắt deployment sau khi chấm đồ án.

Các item này không được dùng để mở rộng scope MVP.

## 13. Handoff

Capability contract đã được phản ánh vào [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md), [DATA-MODEL.md](./DATA-MODEL.md), canonical [OpenAPI](./contracts/openapi.json), ADR log và [construction blueprint](./plans/techpulse-ai-mvp.md). Implementation bắt đầu ở Step 1; product intent đổi phải cập nhật PRD trước, còn HTTP shape đổi phải sửa OpenAPI trước consumer/provider code.
