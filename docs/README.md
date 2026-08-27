# TechPulse AI — Documentation Index

> Trạng thái: Plan-of-Record v1.8 — Steps 1–11 đã implement; ADR-0013 remediation đã hoàn tất; Step 12 release evidence đang chờ
> Cập nhật: 15/08/2026
> Phạm vi: MVP solo-owner + coding-agent, React (JavaScript/JSX) + Node.js/Express (JavaScript) + MongoDB + AI; bốn tuần là planning horizon

## 1. Đọc theo thứ tự nào?

1. [PRODUCT-BRIEF.md](./PRODUCT-BRIEF.md) — vì sao sản phẩm nên tồn tại, thesis và priority.
2. [PRD.md](./PRD.md) — capability contract, requirement IDs, invariant và acceptance gates.
3. [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md) — architecture/component boundaries và runtime flows.
4. [DATA-MODEL.md](./DATA-MODEL.md) — MongoDB collections, indexes, lifecycle và consistency rules.
5. [API-CONTRACT.md](./API-CONTRACT.md) — ownership/change protocol cho HTTP boundary.
6. [contracts/openapi.json](./contracts/openapi.json) — canonical machine-readable HTTP contract.
7. [adr/README.md](./adr/README.md) — quyết định kiến trúc và lý do/trade-off.
8. [plans/techpulse-ai-mvp.md](./plans/techpulse-ai-mvp.md) — blueprint 12 step cho bốn tuần.
9. [ORCHESTRATION-GUIDE.md](./ORCHESTRATION-GUIDE.md) — ready-to-paste ECC chains cho từng step; không tự chạy.

[TechPulse-AI.md](./TechPulse-AI.md) giữ idea log và toàn bộ quyết định/ràng buộc gốc. Nó hữu ích để hiểu lịch sử, nhưng PRD/contract chuyên biệt ở trên là authority khi implementation bắt đầu.

### Google OAuth local setup

Google OAuth dùng authorization-code redirect. Frontend gọi `GET /api/v1/auth/google`, nhận `data.authUrl`, rồi chuyển trình duyệt tới URL đó. Callback `GET /api/v1/auth/google/callback` kiểm tra state đã ký, tạo session và redirect về cùng origin.

Để bật flow trong môi trường local:

1. Khai báo bốn tên biến trong `.env`: `GOOGLE_OAUTH_CLIENT_ID_ENV`, `GOOGLE_OAUTH_CLIENT_SECRET_ENV`, `GOOGLE_OAUTH_REDIRECT_URI_ENV` và `GOOGLE_OAUTH_STATE_SECRET_ENV`.
2. Cấp các giá trị tương ứng cho `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` và `GOOGLE_OAUTH_STATE_SECRET`. Dùng callback URI chính xác của origin đang chạy, ví dụ `http://localhost:3000/api/v1/auth/google/callback`.
3. Apply và verify migration `google-oauth` trước khi bật runtime:
   `npm run db:migrate -- --to google-oauth`
   `npm run db:verify -- google-oauth`
4. Mở landing page và chọn `Đăng nhập bằng Google`. Khi URL không tạo được, UI giữ người dùng trên form và hiển thị lỗi accessible.

Không đưa client secret, state secret hoặc authorization code vào frontend, log, test fixture hoặc MongoDB. Xem [ADR-0020](./adr/0020-add-google-oauth-login.md) để biết invariant bảo mật và callback contract.

## 2. Authority map

| Câu hỏi | Tài liệu authority |
|---|---|
| Sản phẩm giải quyết gì, cho ai? | Product Brief |
| Feature/invariant nào bắt buộc? | PRD |
| Component phụ thuộc nhau thế nào? | Technical Design |
| Field/index/retention nào tồn tại? | Data Model |
| Request/response/error chính xác ra sao? | OpenAPI JSON |
| Vì sao chọn Vercel/Mongo/session/search/provider policy? | ADR log |
| Thứ tự build và exit criteria? | Construction Blueprint |
| Chain ECC nào dùng cho một step? | Orchestration Guide |

Không duy trì payload shape ở nhiều nơi. Nếu prose/example mâu thuẫn OpenAPI thì sửa contract-first; không sửa frontend/backend interface riêng lẻ.

## 3. Bộ artifact hiện có

```text
docs/
├── README.md
├── TechPulse-AI.md
├── PRODUCT-BRIEF.md
├── PRD.md
├── TECHNICAL-DESIGN.md
├── DATA-MODEL.md
├── API-CONTRACT.md
├── ORCHESTRATION-GUIDE.md
├── contracts/
│   └── openapi.json
├── adr/
│   ├── README.md
│   ├── template.md
│   └── 0001..0019
└── plans/
    └── techpulse-ai-mvp.md
```

## 4. Current baseline

- MVP có ba connector: RSS/Atom, arXiv và Hacker News; GitHub/social nằm hậu MVP.
- Implementation dùng JavaScript/JSX (`.js`, `.jsx`), không dùng TypeScript/TSX trong MVP; OpenAPI, runtime validation, JSDoc tùy chọn và test bù cho việc không có static type checker.
- Step 2 dùng MongoDB Node driver `7.5.0`, MongoDB là SoR; migration `auth-core` tạo validator/index/TTL cho users, sessions, rateLimitBuckets, savedArticles, adminAuditLogs và append-only hmacKeyLifecycleSnapshots. Password dùng built-in `node:crypto` scrypt, không thêm password-hashing package.
- Quota HMAC ghi stable `currentVersion`/`retiringVersions` qua runtime env; bucket lưu `keyFingerprint` để phát hiện đổi secret cùng version. Mongo snapshot revision/hash-chain giữ mọi predecessor đã quan sát; startup chỉ append transition và retire từng version sau successor >=30 ngày cùng zero rate-limit/session/audit dependents. Runtime role không update/delete lifecycle history.
- Auth HTTP đã có register/login/logout/current-user/preferences và admin user foundation; session token chỉ lưu hash, CSRF giữ trong memory, public register luôn role `user`.
- UI, summary và Q&A dùng tiếng Việt; giữ title/language/URL nguồn nguyên bản.
- Summary feed dùng `summaryVi` ngắn; trang chi tiết dùng `summaryParagraphsVi` 2–5 đoạn khi `summaryDetailStatus=ready`, có fallback rõ ràng khi đang chờ hoặc lỗi. Prompt summary/Q&A luôn coi dữ liệu nguồn là untrusted và chặn prompt injection.
- Citation cấp bài ở detail/summary và cấp đoạn ở Q&A.
- Không lưu full text; chỉ xử lý tạm khi source policy cho phép.
- Ảnh nguồn chỉ được remote-preview khi Source Registry cho phép; video quan trọng là link-only và phải ghi rõ AI chưa phân tích video. Không tải về/rehost binary ảnh hoặc video trong MongoDB.
- Vercel Hobby host React/Express/cron; MongoDB Atlas là SoR duy nhất với `techpulse_app` runtime DB và `techpulse_governance` signed governance boundary DB. Backup/restore sidecar là recovery track hậu MVP.
- Text search là degradation baseline; semantic retrieval dùng pinned embedding compatibility identity và không runtime-fallback qua vector space khác.
- Admin/user dùng server-side session; system worker không phải login account.
- `/me` bootstrap CSRF token gắn ổn định với session sau reload; token chỉ ở memory, không ở localStorage và bootstrap ở tab khác không revoke token đang hợp lệ.
- Source text/media rights là executable policy, không phải ghi chú tùy chọn.
- Vercel Cron dùng protected `GET /api/internal/cron/due-work`, recover expired work rồi trả aggregate cho ingestion/indexing/account-deletion; admin manual POST gọi cùng runner qua trust boundary riêng.
- Ingestion/indexing/reconciliation có `availableAt`, actor-scoped idempotency/request hash và shared persistent lease high-water không TTL. Account deletion là ADR-0014 stable-workflow exception với inline exact lease.
- Ingestion/indexing crash recovery tạo linked retry; account deletion requeue cùng stable request và giữ completion flags. Queue-local priority + reserved slot bảo đảm mỗi registered due queue tiến triển hữu hạn.
- Source re-review atomically ghi reconciliation marker; mọi marker mutation CAS exact version/status/cursor. Ingestion/AI job capture expected policy version và stale-policy output/candidate không được commit hoặc advance checkpoint.
- Mọi rendered/fetched external URL là canonical HTTPS không credential; safe-fetch pin actual connection vào validated public IP để chặn DNS rebinding.
- Content takedown all-or-nothing tách khỏi automatic account deletion; takedown dùng bounded per-chat cleanup + zero-match citation evidence, còn delayed Q&A phải match user session/article lifecycle trước persistence.
- Account deletion tách `sessionsRevoked` khỏi direct `sessionsDeleted`; xóa direct user-owned chat/saved/answer-attempt data và mọi user Q&A quota bucket theo các HMAC key version còn hiệu lực, còn shared IP anti-abuse bucket có `subjectType=ip` và không thuộc cleanup.
- Retention schedule cho session/quota/chat/job/governance đã khóa theo ADR-0012; TTL không là deletion-completion hoặc fencing evidence.
- Browser API same-origin với exact Origin, `__Host-` cookie, no-store auth response và strict target/JSON/query ingress; RSS XML parser fail closed dưới entity/decompression input.
- Q&A dùng 24h idempotent attempt, credential admission domain, route/provider failure-domain circuits và exact evidence-block support. Current graph dùng DeepSeek `deepseek-v4-flash` trên capability `nonconfidential`; sensitive-input/source-policy/support gates vẫn bắt buộc và `community-signal` chỉ feed/search. Query embedding dùng configured embedding workload sau privacy admission khi capability route bằng hoặc mạnh hơn Q&A policy; OpenRouter/BGE-M3 `nonconfidential` hiện đủ điều kiện, còn unavailable/incompatible thì fallback về lexical + taxonomy retrieval.
- ADR-0013 tách protocol adapter, provider failure domain, credential admission domain, route và workload policy. Current DeepSeek graph chỉ có một route cho mỗi LLM workload, không có model/provider fallback và dùng bounded retry; nếu bổ sung fallback phải giữ failure-class, capability và admitted-input gates.
- Cleanup có fixed machine-only task table + deadline/source-citation indexes; HMAC keyring, closed tombstone và signed `techpulse_governance` checkpoint/suppression state bảo vệ runtime governance. Restore replay và backup sidecar là hậu MVP.
- Mirrored `runtimeCapabilityProbes` ở hai logical DB chứng minh runtime cross-database transaction/role; probe chỉ có opaque ID/timestamps, TTL 5 phút và immediate cleanup/abort zero residue.
- Audit IP-HMAC field cleanup dùng Mongo maintenance client/credential riêng; thiếu credential không được fallback sang runtime identity.
- Audit chỉ lưu safe changed fields/state transition/action-specific `reasonCode`; không snapshot arbitrary document hoặc free-form case text.
- Blueprint có 12 step, direct mode và milestone cutline Day 5/10/15; coding-agent support không hạ verification gate.

## 5. Change routing

| Loại thay đổi | Cập nhật trước | Sau đó |
|---|---|---|
| Product scope/acceptance | PRD | Product Brief/idea log nếu rationale đổi; blueprint |
| Architecture choice | ADR draft + project-owner approval | Technical Design/Data Model/blueprint |
| HTTP field/status/operation | OpenAPI | Generated JavaScript client/JSDoc artifact, provider/consumer, runtime contract tests |
| Persistence/index | Data Model | Idempotent migration, repository/tests |
| Step dependency/scope | Blueprint mutation record | Orchestration Guide |
| Provider/source policy | Source Registry contract/ADR nếu architectural | Tests, runbook và affected artifacts |

## 6. Trạng thái implementation và bước tiếp theo

Steps 1–11 đã có implementation commits và focused verification. Canonical OpenAPI hiện có 56 operations. Step 12 MVP release evidence gồm contract/integration/E2E/security, Atlas role/capability và deployment evidence; backup/restore không thuộc MVP gate và được theo dõi ở recovery track hậu MVP.

ADR-0013 đã được implement trước Step 12 bằng provider graph, protocol adapter, workload router, route/provider-domain circuit và migration `provider-routing-v2`. Provider/model selection không còn nằm trong application/bootstrap routing; deployment phải áp migration v2, cập nhật graph environment và verify runtime role trước khi bật provider workloads. Thay đổi này không đổi HTTP contract và không tạo client/admin model picker.

Các release item còn mở:

- chọn và review chính xác 8–10 RSS feed;
- benchmark embedding route theo compatibility identity trước khi khóa version;
- kiểm tra quota/capability evidence của DeepSeek gần ngày demo; nếu bật provider fallback hậu kỳ thì phải cấu hình thêm failure domain độc lập và evidence tương đương;
- verify account-deletion inline recovery index/query plan và mirrored capability-probe role trên Atlas;
- chốt ngày tắt public deployment sau khi chấm.

### Historical implementation status

Step 1 đã đóng contract/ingress toolchain; Steps 2–11 đã thêm auth, source/content, connectors, feed/search, indexing, grounded Q&A và governance/admin. Các con số operation/gate trong review record cũ là historical evidence tại thời điểm đó, không là current contract status. Local command baseline là Node.js `24.14.1` + npm `11`.
