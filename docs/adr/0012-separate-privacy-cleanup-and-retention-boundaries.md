# ADR-0012: Tách ranh giới xóa dữ liệu riêng tư và thời hạn lưu giữ

**Date**: 2026-08-08\\
**Status**: accepted\\
**Deciders**: Project owner thông qua remediation từ review độc lập của Claude Code

## Context

Thu hồi session chỉ làm token mất hiệu lực, không xóa ngay document session vẫn chứa hash token/CSRF và metadata client tối thiểu cho đến khi TTL chạy bất đồng bộ. `rateLimitBuckets` cũng đồng thời chứa quota của user và trạng thái chống lạm dụng dùng chung theo IP, nên account deletion không thể chứng minh đã xóa đúng dữ liệu của user mà không vô tình xóa state bảo vệ user khác. Một số collection nhạy cảm trước đây chỉ nói thời hạn lưu giữ sẽ quyết định sau, còn cleanup citation của takedown có thể bị hiểu nhầm là cần một Mongo transaction không giới hạn.

## Decision

Account deletion lưu evidence riêng cho `sessionsRevoked`, `sessionsDeleted` và `userQuotaDataDeleted`. Khi nhận request, hệ thống revoke session ngay; worker sau đó trực tiếp xóa và xác minh không còn session document của user, đồng thời xóa quota Q&A thuộc user trước khi workflow được `completed`. Shared IP anti-abuse bucket không thuộc account deletion.

Mọi `rateLimitBuckets` có `subjectType` tường minh (`user`, `ip`, `admin` hoặc `source`) và `keyHash` là keyed HMAC của subject opaque phù hợp với scope. MVP không nhận hoặc lưu free-form account-deletion reason; server tự ghi category an toàn `user-request`.

Retention phải được khóa trước migration của collection owner: session/quota ở Step 2, ingestion/indexing job ở Steps 4/9, chat ở Step 10, takedown/account-deletion/audit ở Step 11. TTL chỉ là cleanup vật lý best-effort, không là bằng chứng authorization, deletion completion hoặc fencing. Takedown hide target trước, rồi cập nhật từng chat document atomically theo bounded batch có index; chỉ zero-match verification mới được đặt completion flag lịch sử.

## Alternatives Considered

### Alternative 1: Coi session revoke là session delete

- **Pros**: Ít completion flag hơn và không cần cleanup query trực tiếp.
- **Cons**: Session document vẫn có thể tồn tại đến khi TTL chạy trễ dù account deletion đã hoàn tất.
- **Why not**: Revoke và physical deletion có bảo đảm privacy khác nhau, nên phải được quan sát riêng.

### Alternative 2: Xóa mọi rate-limit bucket liên quan đến IP

- **Pros**: Cleanup query đơn giản khi user xóa account.
- **Cons**: Mất anti-abuse state dùng chung của user khác cùng IP.
- **Why not**: Shared IP security state không phải dữ liệu do một user sở hữu và không được broad-delete.

### Alternative 3: Một transaction cho toàn bộ historical chat citation

- **Pros**: Câu chữ all-or-nothing có vẻ đơn giản.
- **Cons**: Transaction time và số document tăng theo chat history, khó resume và có thể vượt giới hạn MongoDB.
- **Why not**: Hide-first + per-document atomic update + final zero-match scan giữ safety mà không cần transaction không giới hạn.

## Consequences

### Positive

- Completion evidence phân biệt revoke tức thì với session delete đã xác minh.
- User quota cleanup không thể vô tình xóa shared IP protection.
- Retention trở thành requirement tại migration thay vì quyết định ở release stage.
- Takedown cleanup bounded, retryable và tương thích delayed Q&A lifecycle fence.

### Negative

- Account deletion có thêm session cleanup flag và direct cleanup query.
- Rate-limit validator/index phải enforce scope-to-subject mapping.
- Terminal workflow/audit cleanup cần bounded script rõ ràng, không chỉ dựa vào TTL.

### Risks

- Subject type sai có thể phân loại bucket sai; validator, key-derivation helper và negative test phải reject scope/subject pair không hợp lệ.
- Worker có thể crash giữa delete và set flag; retry phải re-query idempotently trước khi set flag.
- Cleanup script có thể chạy trễ trên Vercel Cron; request/worker path luôn phải enforce expiry/cutoff độc lập với physical cleanup timing.
