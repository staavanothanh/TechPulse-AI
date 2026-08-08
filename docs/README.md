# TechPulse AI — Documentation Index

> Trạng thái: Plan-of-Record v1.3 đã repair và sẵn sàng cho Step 1
> Cập nhật: 08/08/2026  
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
│   └── 0001..0009
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
- Vercel Hobby host React/Express/cron; MongoDB Atlas giữ mọi state bền vững.
- Text search là baseline; BGE-M3/cosine là semantic path có fallback.
- Admin/user dùng server-side session; system worker không phải login account.
- `/me` bootstrap lại CSRF token sau reload; token chỉ ở memory, không ở localStorage.
- Source text/media rights là executable policy, không phải ghi chú tùy chọn.
- Vercel Cron dùng protected GET adapter; admin manual POST gọi cùng due-work coordinator qua trust boundary riêng.
- Job có `availableAt`, actor-scoped idempotency/request hash và lease-generation fencing; indexing job observable/retry/cancel được.
- Content takedown all-or-nothing tách khỏi automatic account deletion; cả hai có completion evidence riêng.
- Audit chỉ lưu safe changed fields/state transition; không snapshot arbitrary document.
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

Plan-of-Record repair trước Step 1 đã hoàn tất ở PRD/OpenAPI/Data Model/Technical Design/blueprint: cron transport, answer conditional, Source Policy matrix, CSRF bootstrap, due work/fencing, indexing controls, account deletion/takedown và audit no-leak đều có authority/owner/test gate.

Các item execution chưa chặn Step 1:

- chọn và review chính xác 8–10 RSS feed;
- benchmark BGE-M3 trước khi khóa `embeddingVersion=1`;
- kiểm tra quota/availability Vercel, OpenCode Zen, DeepSeek và OpenRouter gần ngày demo;
- chốt ngày tắt public deployment sau khi chấm.
