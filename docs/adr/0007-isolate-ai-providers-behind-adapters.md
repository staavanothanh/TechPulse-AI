# ADR-0007: Isolate AI providers behind controlled adapters

**Date**: 2026-08-08  
**Status**: superseded by [ADR-0013](0013-use-config-driven-provider-routing.md)
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

ADR-0013 giữ adapter isolation nhưng thay thế quyết định fixed OpenCode/DeepSeek routing bằng config-driven model/provider fallback.

## Context

Free LLM endpoint có thể không ổn định vào ngày demo và embedding dùng provider/model riêng. Business flow không được phụ thuộc payload, error hoặc streaming behavior của một vendor. Tuy vậy, cho admin/user chọn arbitrary model/endpoint sẽ mở rộng security, cost và test surface.

## Decision

Application dùng hai JavaScript port có JSDoc và runtime validation, `LlmProvider` và `EmbeddingProvider`; adapter map config, request, response và error của từng provider. LLM router chỉ fallback từ configured OpenCode Zen primary sang configured low-cost DeepSeek với lỗi retryable; embedding model được pin và không runtime-fallback qua vector model khác.

## Alternatives Considered

### Alternative 1: Gọi provider SDK trực tiếp trong controller/service

- **Pros**: Ít file và nhanh ở lần gọi đầu.
- **Cons**: Vendor payload/error lan vào business logic, khó fake và đổi endpoint.
- **Why not**: Availability risk đã biết và adapter là boundary cần thiết cho test/demo.

### Alternative 2: Generic provider framework hỗ trợ mọi model

- **Pros**: Rất linh hoạt.
- **Cons**: Abstraction/config/security surface lớn hơn nhu cầu hai LLM route và một embedding model.
- **Why not**: Vi phạm scope/simplicity của MVP.

### Alternative 3: Không có LLM fallback

- **Pros**: Deterministic model và ít nhánh.
- **Cons**: Free endpoint outage có thể làm hỏng phần AI trong demo.
- **Why not**: Một controlled fallback giá thấp giảm rủi ro có chủ đích.

## Consequences

### Positive

- Provider có thể fake trong test và đổi bằng server config.
- Retry/fallback/policy error có semantic thống nhất.
- Client/admin không thấy key hoặc arbitrary endpoint.

### Negative

- Cần runtime schema validation và contract fixture cho output của từng adapter.
- Hai LLM có thể tạo chất lượng/format khác nhau nên evaluation phải chạy cả primary và fallback path.

### Risks

- Fallback vô tình chạy khi policy gate chặn; router chỉ nhận request sau policy gate và chỉ xử lý retryable provider error.
- Embedding provider/model đổi làm vector không tương thích; tăng version và full re-index thay vì per-request fallback.
