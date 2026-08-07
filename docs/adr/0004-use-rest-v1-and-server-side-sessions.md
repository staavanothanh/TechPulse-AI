# ADR-0004: Use REST v1 and server-side cookie sessions

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Backfill of an approved MVP decision

## Context

Một React client tiêu thụ Node.js API cho cả user và admin. MVP cần resource/action rõ, generated JavaScript client/JSDoc contract và kiểm tra `401/403`; không cần subscription hoặc graph query phức tạp. Admin/user cùng authentication backend và project yêu cầu revoke session ngay khi suspend account.

## Decision

API dùng REST JSON dưới `/api/v1` với OpenAPI 3.1 là canonical contract. Authentication dùng opaque server-side session trong MongoDB và cookie `HttpOnly`/`Secure`/`SameSite`; mutation dùng CSRF token, admin route thêm backend role check.

## Alternatives Considered

### Alternative 1: GraphQL

- **Pros**: Client chọn field và schema typed.
- **Cons**: Thêm resolver, authorization/query complexity và không cần cho UI nhỏ.
- **Why not**: REST resource/task response đủ cho consumer jobs và dễ demo hơn.

### Alternative 2: JWT trong `localStorage`

- **Pros**: Stateless validation và implementation phổ biến.
- **Cons**: Token đọc được bởi JavaScript, revoke khó và role/status cũ có thể tồn tại tới expiry.
- **Why not**: Server-side session đáp ứng immediate revocation và giảm exposure ở client.

### Alternative 3: Managed auth service

- **Pros**: Nhiều control production-ready có sẵn.
- **Cons**: Thêm vendor/API và che bớt phần server-side development cần trình bày.
- **Why not**: Hai role và một seeded admin đủ nhỏ để tự triển khai an toàn trong scope.

## Consequences

### Positive

- Frontend/backend/mock cùng derive từ một OpenAPI artifact.
- Session có thể revoke ngay và admin authorization luôn kiểm tra server-side.
- HTTP status/error/pagination nhất quán.

### Negative

- MongoDB chịu session lookup và cần TTL/revocation cleanup.
- Cookie session yêu cầu CSRF/Origin controls và same-origin deployment discipline.

### Risks

- Client chỉ ẩn admin UI nhưng quên backend check; integration test bắt buộc mọi `/admin/*` trả đúng `401/403`.
- Contract và code drift; contract-first workflow sinh type và runtime-validate serialized response.
