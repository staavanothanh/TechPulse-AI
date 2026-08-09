# TechPulse AI — Documentation Index

> Trạng thái: Plan-of-Record baseline v1.7 — GO WITH CONDITIONS cho Step 1; Step 2 chờ extended contract/security gates
> Cập nhật: 09/08/2026
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
│   └── 0001..0012
└── plans/
    └── techpulse-ai-mvp.md
```

## 4. Current baseline

- MVP có ba connector: RSS/Atom, arXiv và Hacker News; GitHub/social nằm hậu MVP.
- Implementation dùng JavaScript/JSX (`.js`, `.jsx`), không dùng TypeScript/TSX trong MVP; OpenAPI, runtime validation, JSDoc tùy chọn và test bù cho việc không có static type checker.
- UI, summary và Q&A dùng tiếng Việt; giữ title/language/URL nguồn nguyên bản.
- Citation cấp bài ở detail/summary và cấp đoạn ở Q&A.
- Không lưu full text; chỉ xử lý tạm khi source policy cho phép.
- Ảnh nguồn chỉ được remote-preview khi Source Registry cho phép; video quan trọng là link-only và phải ghi rõ AI chưa phân tích video. Không tải về/rehost binary ảnh hoặc video trong MongoDB.
- Vercel Hobby host React/Express/cron; MongoDB Atlas là SoR duy nhất với `techpulse_app` runtime DB và `techpulse_governance` signed restore/audit boundary DB.
- Text search là degradation baseline; BGE-M3/cosine là planned-MVP predecessor/release gate của grounded Q&A.
- Admin/user dùng server-side session; system worker không phải login account.
- `/me` bootstrap lại CSRF token sau reload; token chỉ ở memory, không ở localStorage.
- Source text/media rights là executable policy, không phải ghi chú tùy chọn.
- Vercel Cron dùng protected `GET /api/internal/cron/due-work`, recover expired work rồi trả aggregate cho ingestion/indexing/account-deletion; admin manual POST gọi cùng runner qua trust boundary riêng.
- Job có `availableAt`, actor-scoped idempotency/request hash và persistent lease high-water không TTL; canonical resource key làm cron/admin/retry cùng target tranh chấp đúng fence.
- Ingestion/indexing crash recovery tạo linked retry; account deletion requeue cùng stable request và giữ completion flags. Queue-local priority + reserved slot bảo đảm mỗi registered due queue tiến triển hữu hạn.
- Source re-review atomically ghi reconciliation marker; mọi marker mutation CAS exact version/status/cursor. Ingestion/AI job capture expected policy version và stale-policy output/candidate không được commit hoặc advance checkpoint.
- Mọi rendered/fetched external URL là canonical HTTPS không credential; safe-fetch pin actual connection vào validated public IP để chặn DNS rebinding.
- Content takedown all-or-nothing tách khỏi automatic account deletion; takedown dùng bounded per-chat cleanup + zero-match citation evidence, còn delayed Q&A phải match user session/article lifecycle trước persistence.
- Account deletion tách `sessionsRevoked` khỏi direct `sessionsDeleted`; xóa direct user-owned chat/saved/answer-attempt data và mọi user Q&A quota bucket theo các HMAC key version còn hiệu lực, còn shared IP anti-abuse bucket có `subjectType=ip` và không thuộc cleanup.
- Retention schedule cho session/quota/chat/job/governance đã khóa theo ADR-0012; TTL không là deletion-completion hoặc fencing evidence.
- Browser API same-origin với exact Origin, `__Host-` cookie, no-store auth response và strict target/JSON/query ingress; RSS XML parser fail closed dưới entity/decompression input.
- Q&A dùng 24h idempotent attempt, privacy-verified route, aggregate provider-account admission domain + per-route circuit và exact evidence-block support; `community-signal` chỉ feed/search.
- Cleanup có fixed machine-only task table + deadline/source-citation indexes; HMAC keyring, closed tombstone và signed `techpulse_governance` checkpoint/suppression state ngăn app restore làm dữ liệu đã xóa xuất hiện lại.
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

## 6. Bắt đầu implementation

Điểm bắt đầu duy nhất là [Step 1 — Scaffold application and contract toolchain](./plans/techpulse-ai-mvp.md#step-1). Không paste toàn bộ batch orchestration cùng lúc; chỉ chạy step tiếp theo khi dependency có verification evidence và handoff.

Plan-of-Record baseline v1.7 trước Step 1 đã hoàn tất security-boundary authority cho browser/API/XML/provider/Mongo maintenance/backup cùng các control v1.6. OpenAPI hiện có 54 operations và 413/415 cho mọi JSON-body operation; Step 1 phải đóng `x-persistence`, 400/503 completeness và generated ingress/auth/idempotency fixtures trước handoff Step 2.

Các item execution chưa chặn Step 1:

- chọn và review chính xác 8–10 RSS feed;
- benchmark BGE-M3 trước khi khóa `embeddingVersion=1`;
- kiểm tra quota/availability Vercel, OpenCode Zen, DeepSeek và OpenRouter gần ngày demo;
- chốt ngày tắt public deployment sau khi chấm.

### Step 1 scaffold status

Step 1 đã tạo scaffold JavaScript/JSX với React/Vite, Express/Vercel entrypoint, generated OpenAPI client/schema, strict ingress boundary, health route và contract/test/lint/build scripts. Local command baseline là Node.js `24.14.1` + npm `11`; chạy `npm ci`, sau đó `npm run dev` trên port 3000. Database, authentication persistence, connector, provider và business UI vẫn thuộc các step sau.
