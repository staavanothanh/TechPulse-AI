# ADR-0003: Use bounded durable jobs for serverless ingestion

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

Vercel Cron gọi function chứ không tạo một worker sống liên tục, và invocation có thể lặp hoặc kết thúc trước khi toàn bộ backlog xong. Ingestion còn phụ thuộc nguồn ngoài, LLM và embedding nên có lỗi retryable lẫn lỗi policy không được retry. Admin trigger phải dùng cùng logic với cron và không tạo article trùng.

## Decision

Cron/admin gọi một shared bounded job runner. Job, idempotency key, checkpoint, counters và Mongo lease có expiry được lưu bền vững; runner dừng trước deadline và trả `partial` để lần sau resume.

## Alternatives Considered

### Alternative 1: `node-cron` và queue trong memory

- **Pros**: Dễ viết và quan sát khi chạy local.
- **Cons**: Mất state khi cold start/deploy, split giữa instance và không phù hợp serverless.
- **Why not**: Không đáp ứng durability hoặc distributed exclusion.

### Alternative 2: Xử lý toàn bộ corpus trong một request

- **Pros**: Luồng code tuyến tính.
- **Cons**: Dễ timeout, retry lặp side effect và khó recovery từng phần.
- **Why not**: Không an toàn với provider latency và function deadline.

### Alternative 3: Durable queue/worker bên ngoài

- **Pros**: Scheduling, retry và concurrency tốt hơn ở quy mô lớn.
- **Cons**: Thêm hạ tầng và integration ngoài mục tiêu học kỳ.
- **Why not**: Chưa cần cho 250–400 article; là upgrade path sau MVP.

## Consequences

### Positive

- Duplicate cron/manual invocation không tạo duplicate side effect.
- Admin xem được trạng thái/counter/lỗi và retry có kiểm soát.
- Job có thể recover sau timeout/cold start.

### Negative

- Workflow cần checkpoint, lease owner token và retry classification.
- Một daily run có thể không drain hết backlog; seed/demo cần manual runs được kiểm soát.

### Risks

- TTL cleanup không tức thời; lock acquisition phải kiểm tra `expiresAt`, không dựa riêng vào TTL monitor.
- Worker chết sau side effect nhưng trước checkpoint; item operation và provider artifact dùng unique key/input hash để chạy lại an toàn.
