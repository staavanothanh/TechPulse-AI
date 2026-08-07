# ADR-0006: Enforce source rights as executable policy

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

RSS/API access hoặc dự án phi thương mại không tự động cấp quyền lưu, dịch hay gửi full text tới AI. Các publisher có policy khác nhau và policy có thể thay đổi. Chỉ ghi lưu ý pháp lý trong tài liệu không ngăn connector/provider vô tình xử lý vượt phạm vi.

## Decision

Source Registry lưu rights evidence, `licenseStatus`, `llmInputScope`, `storageScope` và policy version. Backend policy gate reload current policy ngay trước ingestion/provider/retrieval; không rõ quyền mặc định `metadata-only`, và full text nếu được phép chỉ tồn tại tạm trong memory.

## Alternatives Considered

### Alternative 1: Connector tự quyết định field nào được dùng

- **Pros**: Ít central policy code.
- **Cons**: Rule drift giữa connector và khó audit một provider request.
- **Why not**: Quyền sử dụng là invariant xuyên suốt, không phải chi tiết connector.

### Alternative 2: Gửi mọi cleaned article text cho LLM vì phi thương mại

- **Pros**: Summary/RAG có evidence giàu hơn.
- **Cons**: Rủi ro bản quyền/terms/provider transfer và dễ tạo output thay thế bài gốc.
- **Why not**: Trái quyết định không “lách luật” và phạm vi đã chốt.

### Alternative 3: Chỉ quản lý allowlist URL

- **Pros**: UI/source config đơn giản.
- **Cons**: Không phân biệt access, publisher, license, storage và AI scope.
- **Why not**: Một URL được phép fetch không có nghĩa mọi processing purpose đều được phép.

## Consequences

### Positive

- Mọi provider input có thể giải thích bằng source policy/version.
- Source bị review/blocked có thể fail-closed ngay cả trước cleanup.
- Takedown và re-review có target rõ cho metadata/summary/vector.

### Negative

- Admin phải nghiên cứu và lưu evidence cho từng source.
- Metadata-only source tạo summary/retrieval nghèo hơn fulltext-permitted source.

### Risks

- Policy thay đổi nhưng article snapshot cũ còn allowed; query/provider luôn kiểm tra current source state và enqueue reconciliation.
- AI hiểu sai Terms; AI chỉ hỗ trợ trích xuất, project owner/admin mới phê duyệt policy.
