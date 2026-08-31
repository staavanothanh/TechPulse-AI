# Hồ sơ quyết định kiến trúc

ADR-0001..0009 backfill những quyết định đã được project owner chốt trong [TechPulse-AI.md](../TechPulse-AI.md); ADR mới hơn được ghi khi decision draft được phê duyệt. Mỗi ADR ghi lý do và trade-off; contract triển khai nằm ở [TECHNICAL-DESIGN.md](../TECHNICAL-DESIGN.md), [DATA-MODEL.md](../DATA-MODEL.md) và [contracts/openapi.json](../contracts/openapi.json).

| ADR | Tiêu đề | Trạng thái | Ngày |
|---|---|---|---|
| [0001](0001-deploy-react-and-express-on-vercel.md) | Deploy React and Express together on Vercel | accepted | 2026-08-08 |
| [0002](0002-use-mongodb-as-system-of-record.md) | Use MongoDB as the MVP system of record | accepted | 2026-08-08 |
| [0003](0003-use-bounded-durable-serverless-jobs.md) | Use bounded durable jobs for serverless ingestion | accepted | 2026-08-08 |
| [0004](0004-use-rest-v1-and-server-side-sessions.md) | Use REST v1 and server-side cookie sessions | accepted | 2026-08-08 |
| [0005](0005-use-hybrid-search-with-application-cosine.md) | Use hybrid search with application-level cosine similarity | accepted | 2026-08-08 |
| [0006](0006-enforce-source-rights-as-executable-policy.md) | Enforce source rights as executable policy | accepted | 2026-08-08 |
| [0007](0007-isolate-ai-providers-behind-adapters.md) | Isolate AI providers behind controlled adapters | superseded by ADR-0013 | 2026-08-08 |
| [0008](0008-use-javascript-and-jsx-for-implementation.md) | Use JavaScript and JSX for implementation | accepted | 2026-08-08 |
| [0009](0009-display-permitted-external-media-without-rehosting.md) | Display permitted external media without rehosting | accepted | 2026-08-08 |
| [0010](0010-preserve-durable-fencing-and-recover-expired-jobs.md) | Preserve durable fencing and recover expired serverless jobs | accepted | 2026-08-08 |
| [0011](0011-coordinate-durable-work-scopes-recovery-and-fairness.md) | Coordinate durable work scopes, recovery and queue fairness | accepted | 2026-08-08 |
| [0012](0012-separate-privacy-cleanup-and-retention-boundaries.md) | Separate privacy cleanup and retention boundaries | accepted | 2026-08-08 |
| [0013](0013-use-config-driven-provider-routing.md) | Use configuration-driven provider routing and bounded failover | accepted | 2026-08-15 |
| [0014](0014-use-inline-leases-for-stable-deletion-workflows.md) | Use inline leases for stable account-deletion workflows | accepted | 2026-08-15 |
| [0015](0015-adopt-gemini-for-llm-workloads.md) | Chuyển summary và Q&A sang Gemini, giữ embedding BGE-M3 | superseded by ADR-0016 | 2026-08-21 |
| [0016](0016-adopt-deepseek-v4-flash-for-llm-workloads.md) | Chuyển summary và Q&A sang DeepSeek V4 Flash, giữ embedding BGE-M3 | accepted | 2026-08-23 |
| [0017](0017-add-bounded-indexing-drain-after-fair-queue-turn.md) | Thêm drain indexing có giới hạn sau lượt queue công bằng | accepted | 2026-08-23 |
| [0018](0018-harden-indexing-drain-ownership-and-query-plans.md) | Gia cố quyền sở hữu drain indexing và query plan | accepted | 2026-08-23 |
| [0019](0019-rich-summary-trusted-connector-payload-media.md) | Tóm tắt chi tiết, payload connector tin cậy có fence và media an toàn | proposed | 2026-08-24 |
| [0020](0020-add-google-oauth-login.md) | Thêm đăng nhập Google OAuth theo redirect có state được ký | accepted | 2026-08-24 |
| [0021](0021-add-vietqr-donation-page.md) | Thêm trang ủng hộ công khai bằng VietQR không cố định số tiền | accepted | 2026-08-24 |
| [0022](0022-defer-email-verification-and-google-account-linking.md) | Hoãn xác minh quyền sở hữu email và liên kết tài khoản Google | accepted | 2026-08-26 |
| [0023](0023-profiled-iterative-due-work-orchestration.md) | Điều phối due-work theo profile, kẹp hạn chót toàn cục và cách ly lease candidate | accepted | 2026-08-29 |
| [0024](0024-pause-temporary-fulltext-input.md) | Tạm dừng fulltext input, quay về policy v2 metadata-only | accepted | 2026-08-31 |

## Lifecycle

```text
proposed → accepted → deprecated | superseded by ADR-NNNN
```

- Không sửa rationale lịch sử để hợp thức hóa lựa chọn mới.
- Quyết định thay thế tạo ADR mới và cập nhật status/link của ADR cũ.
- Quyết định mới chỉ được ghi sau khi project owner duyệt draft.

Mẫu thủ công: [template.md](template.md).
