# ADR-0002: Use MongoDB as the MVP system of record

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

Học phần yêu cầu MongoDB và dữ liệu TechPulse có article/source/job payload thay đổi theo connector. Vercel Function không cung cấp state bền vững trong memory hoặc filesystem. MVP cần lưu session, policy, article, vector, job checkpoint, takedown và audit ở một nơi với quy mô nhỏ.

## Decision

MongoDB Atlas là system of record duy nhất cho MVP, bao gồm server-side session và durable job state. Application dùng schema validation, indexes, atomic conditional update và idempotent workflow; không lưu full text hoặc secret.

## Alternatives Considered

### Alternative 1: SQL Server làm primary database

- **Pros**: Quan hệ và transaction rõ; cũng thuộc nội dung học kỳ.
- **Cons**: Thêm deployment/database stack và mapping cho payload connector/vector linh hoạt.
- **Why not**: Tech stack đồ án đã chốt MongoDB; dùng hai database vượt scope solo bốn tuần.

### Alternative 2: MongoDB cho content, memory/filesystem cho session/job

- **Pros**: Ít collection hơn.
- **Cons**: Session/job mất khi cold start/deploy và không đồng bộ giữa instance.
- **Why not**: Vi phạm trực tiếp reliability invariant của serverless deployment.

### Alternative 3: MongoDB cộng Redis/queue service

- **Pros**: Lease, rate limit và queue chuyên dụng hơn.
- **Cons**: Thêm dịch vụ, credential, chi phí và failure mode.
- **Why not**: Dataset/job rate của MVP chưa chứng minh cần dependency này.

## Consequences

### Positive

- Một persistence model dễ seed, backup và giải thích khi demo.
- Atomic single-document operation và unique index hỗ trợ idempotency.
- Document model phù hợp metadata/provenance và generated artifacts.

### Negative

- Multi-document consistency phải thiết kế fail-closed và reconcile thay vì dựa vào relational constraint.
- Application-level cosine cần đọc candidate vectors vào Node.js.

### Risks

- Query drift có thể làm lộ article không visible; mọi user repository dùng shared visibility predicate và negative integration tests.
- Schema-less misuse có thể tạo field cấm; dùng Mongo validator, JavaScript runtime schema và database scan test.
