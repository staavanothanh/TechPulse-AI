# TechPulse AI — Product Requirements & Capability Contract

> Trạng thái: Plan-of-Record repair locked for implementation
> Phiên bản: 1.2
> Cập nhật: 08/08/2026  
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

| Policy | Quyết định cố định cho MVP |
|---|---|
| Thời gian/nguồn lực | 4 tuần, scope đủ để một người hoàn thành |
| Connector | RSS/Atom, arXiv, Hacker News |
| Dataset | Khoảng 250–400 article |
| Ngôn ngữ output | Tiếng Việt |
| Citation | Cấp bài ở detail/summary; cấp đoạn ở AI Q&A |
| Full text | Không lưu; chỉ xử lý tạm nếu `fulltext-temporary` |
| Implementation language | JavaScript/JSX (`.js`, `.jsx`); không dùng TypeScript/TSX trong MVP |
| Media | Ảnh remote-preview theo Source Registry; video link-only; không rehost hoặc AI-analyze binary media |
| External content | Luôn là untrusted data |
| Source approval | Technical check tự động, policy approval thủ công |
| Human role | `user`, `admin` |
| Internal actor | `system-worker` |
| Deployment | Vercel Hobby, public URL tạm thời phục vụ chấm đồ án |

### 2.2. Reversible architecture preferences

| Area | Lựa chọn MVP | Điều kiện thay đổi |
|---|---|---|
| Database | MongoDB Atlas | Chỉ đổi sau MVP |
| Keyword search | MongoDB text index | Có thể chuyển Atlas Search khi scale tăng |
| Embedding | OpenRouter `baai/bge-m3` | Đổi model phải re-index toàn corpus |
| Semantic search | Cosine similarity trong Node.js | Chuyển Vector Search khi dataset lớn |
| LLM primary | OpenCode Zen `deepseek-v4-flash-free` | Phụ thuộc availability/quota |
| LLM fallback | `deepseek-v4-flash` | Kích hoạt khi lỗi retryable hoặc primary unavailable |
| Scheduler | Vercel Cron + admin trigger | Có thể chuyển durable worker hậu MVP |

### 2.3. Trust boundaries

- Browser là untrusted client; role và object authorization luôn kiểm tra ở backend.
- Source URL/config do admin nhập vẫn là untrusted input.
- RSS/API/article body là untrusted content và có thể chứa prompt injection.
- Vercel Cron request chỉ được tin cậy sau khi xác thực `CRON_SECRET`.
- LLM/embedding provider là third party; input phải qua policy gate và redaction.
- MongoDB là system of record cho user, session, job, source policy, article và audit.

## 3. Implementation contract

### 3.1. Actors

| Actor | Mục tiêu | Quyền chính |
|---|---|---|
| Guest | Truy cập entry/auth surface | Đăng ký, đăng nhập |
| User | Theo dõi và hỏi về tin công nghệ | Feed, search, detail, save, AI Q&A |
| Admin | Vận hành và xử lý ngoại lệ | Sources, jobs, articles/index, users, takedowns, audit |
| System worker | Thực thi bounded job | Ingest, normalize, summarize, embed, index |
| Cron caller | Kích hoạt lịch | Gọi protected ingestion endpoint |
| Publisher/source | Cung cấp dữ liệu ngoài | Không có quyền trong hệ thống; bị giới hạn bởi Source Registry |
| AI provider | Tạo summary/answer/vector | Chỉ nhận input đã được policy gate cho phép |

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

| ID | Requirement | Acceptance summary |
|---|---|---|
| AUTH-001 | Guest có thể đăng ký account `user` | Client không thể đặt role khác |
| AUTH-002 | User/admin có thể login/logout | Session lưu server-side; cookie HttpOnly/SameSite/Secure |
| AUTH-003 | Backend phân biệt unauthenticated và unauthorized | Trả `401` và `403` đúng trường hợp |
| AUTH-004 | Admin đầu tiên được tạo bằng seed/deployment operation | Không có public admin registration |
| AUTH-005 | Khóa user làm mất hiệu lực mọi session hiện có | Request tiếp theo bị từ chối |
| AUTH-006 | User có thể yêu cầu xóa account bằng durable automatic workflow | Session bị revoke trước; saved/chat/quota/identity có completion evidence và audit |

### 4.2. User preferences và saved articles

| ID | Requirement | Acceptance summary |
|---|---|---|
| USER-001 | User chọn topic quan tâm | Preferences tồn tại qua session |
| USER-002 | User lưu/bỏ lưu article | Operation idempotent, không tạo duplicate |
| USER-003 | User xem danh sách saved articles | Chỉ thấy dữ liệu của chính mình |
| USER-004 | User xóa saved history/chat history | Dữ liệu liên quan bị xóa hoặc anonymize theo policy |

### 4.3. Source Registry

| ID | Requirement | Acceptance summary |
|---|---|---|
| SRC-001 | Admin tạo/sửa source definition | Validate connector-specific config |
| SRC-002 | System chạy technical check | Kiểm tra protocol, URL, redirect, host, content type, parse |
| SRC-003 | Admin ghi nhận publisher, Terms/License và evidence | Có reviewedBy/reviewedAt |
| SRC-004 | Source có rights status độc lập operational status | Không trộn `paused` với `metadata-only` |
| SRC-005 | Không rõ quyền thì mặc định `metadata-only` | Không có implicit `permitted` |
| SRC-006 | Backend enforce `llmInputScope` và `storageScope` | Request vượt scope bị chặn/log |
| SRC-007 | Source `blocked`/`review-needed` không chạy production ingest | Technical sample là ngoại lệ có giới hạn |
| SRC-008 | Admin pause/archive source | Không tự xóa historical article |
| SRC-009 | Source có `mediaPolicy` độc lập với quyền dùng text | Ảnh/video chỉ hiển thị theo mode và host đã duyệt |
| SRC-010 | Policy fields tuân theo compatibility matrix | Contract-valid payload không thể nâng quyền xử lý |
| SRC-011 | Terms change đưa source về re-review fail-closed | Source tự pause, tăng policyVersion và enqueue reconciliation |

### 4.4. Ingestion và normalization

| ID | Requirement | Acceptance summary |
|---|---|---|
| ING-001 | Ba connector hoạt động qua common interface | Output normalize về common article schema |
| ING-002 | Cron tạo bounded ingestion run mỗi ngày | Có job record và kết quả |
| ING-003 | Admin có thể trigger cùng job service | Không bypass policy/lock |
| ING-004 | Job có idempotency key và distributed lock | Duplicate invocation không duplicate article |
| ING-005 | Job ghi new/duplicate/skipped/error counts | Admin xem được lỗi đã redact |
| ING-006 | Retry chỉ áp dụng lỗi retryable và có giới hạn | Không retry vô hạn |
| ING-007 | Canonicalize URL/time/language/topic | Output nhất quán giữa connector |
| ING-008 | Deduplicate bằng URL, external ID, normalized title/hash | Ambiguous merge vào review queue |
| ING-009 | Raw HTML không đi thẳng vào AI | Main content được extract/sanitize/chunk |

### 4.5. Article lifecycle, feed và detail

| ID | Requirement | Acceptance summary |
|---|---|---|
| ART-001 | Article có provenance và rights snapshot | sourceId, originalUrl, publishedAt luôn có |
| ART-002 | Chỉ `published` xuất hiện ở user surfaces | Hidden/review/removed bị loại ở mọi query |
| ART-003 | Feed filter theo topic/source/time | Pagination ổn định |
| ART-004 | Detail hiển thị original metadata, summary basis và CTA nguồn | Không hiển thị full article/image trái scope |
| ART-005 | Admin hide/restore article theo invariant | Index được đồng bộ |
| ART-006 | Admin merge duplicate nhưng giữ mọi source link | Provenance không mất |
| ART-007 | Article có thể có `leadMedia` đã qua policy | Ảnh được preview hoặc fallback; video chỉ là link và ghi `not-analyzed` |

### 4.6. Keyword và semantic search

| ID | Requirement | Acceptance summary |
|---|---|---|
| SEARCH-001 | Search keyword trên original/VI title, VI summary, topics | Hỗ trợ query bỏ dấu |
| SEARCH-002 | Filter kết hợp status/source/topic/time | Không leak non-published article |
| SEARCH-003 | Published article có thể được embed từ allowed fields | Lưu model/dimension/version/hash |
| SEARCH-004 | Query/document dùng cùng embedding model/version | Mismatch bị từ chối hoặc re-index |
| SEARCH-005 | Backend xếp hạng cosine trên dataset MVP | Trả top candidates có score |
| SEARCH-006 | Embedding outage fallback text search | User vẫn nhận kết quả có nguồn |

### 4.7. Summary và ngôn ngữ

| ID | Requirement | Acceptance summary |
|---|---|---|
| AI-001 | System tạo `summaryVi` ngắn từ allowed input | Không dùng field ngoài `llmInputScope` |
| AI-002 | Summary lưu `summaryBasis`, model và status | Biết được tạo từ metadata/excerpt/fulltext-temp |
| AI-003 | Giữ title/excerpt/language/URL gốc | Không overwrite source data |
| AI-004 | Không lưu full text sau xử lý tạm | Không có field/collection chứa article body lâu dài |
| AI-005 | Summary lỗi có retry/review flow | Không publish summary hỏng như thành công |
| AI-006 | UI gắn nhãn AI dịch/tổng hợp | Người dùng biết giới hạn |
| AI-007 | AI không dùng chi tiết chỉ tồn tại trong media chưa xử lý | Không claim từ ảnh/video có `mediaEvidenceStatus=not-analyzed` |

### 4.8. AI Q&A và citation

| ID | Requirement | Acceptance summary |
|---|---|---|
| QA-001 | User hỏi theo article/topic/time range | Input được validate và rate-limit |
| QA-002 | Backend retrieve evidence trước LLM call | Không answer trực tiếp từ model memory |
| QA-003 | Mỗi answer paragraph có citations[] | Citation mở đúng original URL |
| QA-004 | Citation chỉ trỏ published/allowed article | Hidden/removed không được dùng |
| QA-005 | Conflicting sources được trình bày riêng | Không tự che giấu mâu thuẫn |
| QA-006 | Thiếu evidence dẫn tới refusal | Không bịa câu trả lời |
| QA-007 | Prompt injection trong evidence không thay đổi instruction/tool use | External text chỉ là quoted data |
| QA-008 | Primary provider lỗi retryable có thể dùng configured fallback | Không fallback khi lỗi policy/validation |

### 4.9. Admin operations và governance

| ID | Requirement | Acceptance summary |
|---|---|---|
| ADMIN-001 | Overview hiển thị exceptions cần xử lý | Counts phản ánh source/job/article/index/takedown/account deletion |
| ADMIN-002 | Admin xem/retry/cancel mọi bounded job qua một operational view | Ingestion/indexing/reconciliation/deletion đều poll và recovery được |
| ADMIN-003 | Admin regenerate summary/re-index article | Respect source policy và version |
| ADMIN-004 | Admin xử lý takedown end-to-end | Metadata/media reference/summary/vector bị loại đúng scope |
| ADMIN-005 | Admin suspend/restore user | Session revocation hoạt động |
| ADMIN-006 | Mọi state-changing admin action có safe structured audit | Actor/target/changedFields/safe transition/reason/result/time; không snapshot document |
| ADMIN-007 | Dashboard không hiển thị secret/private chat/password hash | Redaction được kiểm thử |
| ADMIN-008 | Admin review/đổi media policy và ẩn media độc lập | Thay đổi có reason, policyVersion và audit |
| ADMIN-009 | Admin xem safe article provenance/artifact diagnostics | Không expose excerpt/full text/vector/provider payload/private data |

## 5. States và transitions

### 5.1. Source

```text
operationalStatus: draft → testing → active ↔ paused → archived
licenseStatus: review-needed → permitted | metadata-only | blocked
```

Rules:

- `active` chỉ hợp lệ khi license là `permitted` hoặc `metadata-only`.
- `blocked` luôn vô hiệu production ingestion.
- Terms change chuyển license về `review-needed`, pause source, tăng `policyVersion` và enqueue visibility/artifact reconciliation trong cùng application workflow.
- `reviewedBy` và `reviewedAt` do server lấy từ session/time hiện tại; browser không được khai báo hai field này.

#### 5.1.1. Source Policy compatibility matrix

| `licenseStatus` | `llmInputScope` hợp lệ | Ràng buộc `storageScope` | Media/user visibility |
|---|---|---|---|
| `review-needed` | `none` | Không tạo artifact mới; dữ liệu hiện hữu fail-closed và chờ reconciliation | Source không active; media không serialize |
| `blocked` | `none` | `metadata/excerpt/summary/embedding=false` cho processing mới | Source không active; media mode `none` |
| `metadata-only` | `none` hoặc `metadata` | `metadata=true`, `excerpt=false`; `summary/embedding` chỉ được true khi input là metadata | Chỉ field metadata đã duyệt; media theo policy độc lập |
| `permitted` | `none`, `metadata`, `excerpt` hoặc `fulltext-temporary` | Không có full-text storage; `summary/embedding=true` yêu cầu input scope khác `none` | Media vẫn phải qua policy/host riêng |

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
- `running` quá timeout được recovery process đánh dấu `failed` trước khi retry.
- `queued` có `availableAt`; coordinator lấy due work theo priority, `availableAt`, `createdAt` và request budget ổn định.
- Mỗi lease acquisition tăng `leaseGeneration`; mọi checkpoint, transition và artifact commit phải match generation hiện hành.

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
- `deleted` chỉ hợp lệ khi sessions, saved articles, chats và quota/rate-limit data đã được xóa, identity đã anonymize và các completion flag đều được xác minh.
- Audit chỉ giữ opaque user/request ID và safe reason category; không giữ email hoặc nội dung chat đã xóa.

### 5.6. Takedown

```text
received → reviewing → approved | rejected
approved → completed
```

- Takedown MVP chỉ áp dụng cho target `source|article` và scope `metadata|media-metadata|summary|embedding`.
- Quyết định là all-or-nothing: `approved` nghĩa toàn bộ `requestedScope` được duyệt; MVP không có partial approval hoặc `approvedScope` riêng.
- `completed` chỉ hợp lệ khi mọi completion flag tương ứng `requestedScope` đã được xác minh.
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
15. `answered` luôn có paragraph/citation không rỗng và mọi citation ID resolve tới article đang visible; `refused` không chứa factual paragraph và có refusal reason.
16. Public serializer chỉ trả summary khi `summaryStatus=ready`; artifact `removed` phải unset content/model/hash và không xuất hiện ở feed/detail/retrieval.
17. Direct admin mutation và audit record commit atomically; workflow dài ghi audit intent trước và terminal result idempotently.
18. Idempotency identity gồm actor scope, key và canonical request hash; reuse key cho intent khác trả conflict.
19. Account deletion completion độc lập content takedown và có machine-readable evidence cho từng cleanup item.

## 7. Data ownership và implications

| Data | Owner/system of record | Retention rule |
|---|---|---|
| Account/session | TechPulse AI / MongoDB | Xóa/revoke theo user lifecycle |
| Source policy/evidence | TechPulse AI / MongoDB | Giữ audit history |
| Article metadata | Publisher-originated, TechPulse stores record | Gỡ theo policy/takedown |
| Media metadata/remote URL | Publisher-originated, TechPulse stores reference | Không lưu binary; ẩn/xóa theo media policy hoặc takedown |
| Full text temporary | Publisher-originated, memory only | Discard sau request/job |
| SummaryVi | TechPulse AI generated artifact | Gắn source/model/basis; xóa cùng article nếu cần |
| Embedding | TechPulse AI derived index | Rebuildable; xóa cùng article |
| Chat history | User/TechPulse AI | User có thể xóa; không đưa vào model training |
| Audit log | TechPulse AI governance record | Append-only ở application layer |

## 8. Security, privacy và policy requirements

- Password hash bằng algorithm phù hợp; không log credential.
- Session ID chỉ ở secure cookie; session record trong MongoDB.
- CSRF protection phù hợp session cookie; CORS/rewrite policy tối thiểu.
- Rate limit login, AI Q&A, admin triggers và source tests.
- Rate-limit/quota state dùng shared Mongo bucket hoặc platform-native shared limiter; không dùng per-process counter trên Vercel.
- SSRF defense cho source URL: protocol allowlist, DNS/IP validation, redirect validation, timeout và response-size limit.
- Media URL phải là HTTPS, thuộc host allowlist của source; client áp dụng CSP/referrer policy, backend không làm arbitrary media proxy.
- CRON_SECRET/service secret tách khỏi admin/user credential.
- Provider API key chỉ ở Vercel Environment Variables.
- Không gửi email, token, private chat hoặc unapproved full text tới provider.
- OpenRouter logging/opt-in tắt; ưu tiên ZDR endpoint khi khả dụng.
- Takedown và account deletion có audit nhưng audit không lưu deleted secret/content.

## 9. Non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Reliability | Job idempotent và recover được sau timeout/cold start |
| NFR-002 | Performance | Feed/text search mục tiêu p95 dưới 2 giây, không tính Vercel cold start |
| NFR-003 | AI latency | Q&A phải hiển thị loading/stream state; timeout có retry/fallback rõ ràng |
| NFR-004 | Scale | Hoạt động ổn định với 250–400 article và tối thiểu 10 concurrent demo users |
| NFR-005 | Cost | Có daily/user quota; tránh gọi lại summary/embedding khi input hash không đổi |
| NFR-006 | Observability | Structured logs có request/job/source IDs, không chứa secret/full text |
| NFR-007 | Accessibility | Core flow dùng được bằng keyboard, có label/focus/error state cơ bản |
| NFR-008 | Portability | Provider/model/config đổi bằng environment/config, không hard-code business logic |
| NFR-009 | Testability | Connector, policy gate, retrieval và provider adapter có dependency injection |
| NFR-010 | Legal safety | Từng source có evidence và review date trước khi active |
| NFR-011 | Media safety | Preview có attribution/alt/fallback; host không được duyệt hoặc media lỗi không làm hỏng core flow |

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
- BGE-M3 retrieval trả source relevant trong top 5 cho bộ test đã chốt.
- Citation precision mục tiêu ≥90% trên evaluation set.
- Refusal cases không tạo unsupported claim.
- Hidden/removed/review-needed article không xuất hiện trong context.

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
- Cron/manual job dùng lock và idempotency.
- Vercel Cron gọi protected GET adapter; admin manual POST dùng cùng coordinator nhưng trust boundary riêng.
- Due work không nằm queued vô hạn; stale worker không commit được sau khi mất lease generation.
- Secret/full text không xuất hiện trong logs/dashboard/database.
- Database scan không có binary/base64 ảnh/video; host media ngoài policy không được serialize ra user API.
- Takedown xóa/ẩn đúng metadata, media reference, summary và vector.
- Mọi admin mutation có audit record.
- Account deletion test chứng minh session/saved/chat/quota cleanup và identity anonymization trước `completed`.

### Deployment gate

- Production build deploy thành công trên Vercel Hobby.
- MongoDB Atlas connection/config được lấy từ environment.
- Có local fallback và seed/demo script hoặc documented demo steps.

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

## 12. Execution questions không chặn Step 1

Các semantics account deletion, takedown all-or-nothing, audit atomicity và scope MVP đã được chốt. Các item sau chỉ cần xác nhận gần step sở hữu:

1. Danh sách cuối cùng của 8–10 RSS feed và evidence đi kèm.
2. Benchmark retrieval để chốt BGE-M3 version/dimensions cho corpus tiếng Việt.
3. Availability/quota của free LLM endpoint tại thời điểm triển khai.
4. Ngày tắt deployment sau khi chấm đồ án.

Các item này không được dùng để mở rộng scope MVP.

## 13. Handoff

Capability contract đã được phản ánh vào [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md), [DATA-MODEL.md](./DATA-MODEL.md), canonical [OpenAPI](./contracts/openapi.json), ADR log và [construction blueprint](./plans/techpulse-ai-mvp.md). Implementation bắt đầu ở Step 1; product intent đổi phải cập nhật PRD trước, còn HTTP shape đổi phải sửa OpenAPI trước consumer/provider code.
