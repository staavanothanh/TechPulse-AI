# Architecture Decision Records

Các ADR này backfill những quyết định đã được project owner chốt trong [TechPulse-AI.md](../TechPulse-AI.md) ngày 08/08/2026. Mỗi ADR ghi lý do và trade-off; contract triển khai nằm ở [TECHNICAL-DESIGN.md](../TECHNICAL-DESIGN.md), [DATA-MODEL.md](../DATA-MODEL.md) và [contracts/openapi.json](../contracts/openapi.json).

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-deploy-react-and-express-on-vercel.md) | Deploy React and Express together on Vercel | accepted | 2026-08-08 |
| [0002](0002-use-mongodb-as-system-of-record.md) | Use MongoDB as the MVP system of record | accepted | 2026-08-08 |
| [0003](0003-use-bounded-durable-serverless-jobs.md) | Use bounded durable jobs for serverless ingestion | accepted | 2026-08-08 |
| [0004](0004-use-rest-v1-and-server-side-sessions.md) | Use REST v1 and server-side cookie sessions | accepted | 2026-08-08 |
| [0005](0005-use-hybrid-search-with-application-cosine.md) | Use hybrid search with application-level cosine similarity | accepted | 2026-08-08 |
| [0006](0006-enforce-source-rights-as-executable-policy.md) | Enforce source rights as executable policy | accepted | 2026-08-08 |
| [0007](0007-isolate-ai-providers-behind-adapters.md) | Isolate AI providers behind controlled adapters | accepted | 2026-08-08 |
| [0008](0008-use-javascript-and-jsx-for-implementation.md) | Use JavaScript and JSX for implementation | accepted | 2026-08-08 |
| [0009](0009-display-permitted-external-media-without-rehosting.md) | Display permitted external media without rehosting | accepted | 2026-08-08 |

## Lifecycle

```text
proposed → accepted → deprecated | superseded by ADR-NNNN
```

- Không sửa rationale lịch sử để hợp thức hóa lựa chọn mới.
- Quyết định thay thế tạo ADR mới và cập nhật status/link của ADR cũ.
- Quyết định mới chỉ được ghi sau khi project owner duyệt draft.

Mẫu thủ công: [template.md](template.md).
