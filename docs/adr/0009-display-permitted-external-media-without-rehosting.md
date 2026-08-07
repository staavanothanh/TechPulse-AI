# ADR-0009: Display permitted external media without rehosting

**Date**: 2026-08-08  
**Status**: accepted  
**Deciders**: Project owner  
**Record type**: Approved MVP decision

## Context

Feed hoàn toàn không có hình ảnh kém hấp dẫn, nhưng một asset công khai không mặc nhiên được phép sao chép hoặc lưu lại. Video đôi khi là nội dung chính, trong khi tải xuống, transcript và AI video analysis vượt phạm vi bốn tuần. Dự án cần tách rõ link tới nguồn, quyền hiển thị preview/embed và quyền dùng media làm AI input.

## Decision

Source Registry có media policy độc lập. MVP có thể remote-preview ảnh từ HTTPS host đã duyệt, hiển thị attribution/alt khi cần và dùng visual fallback do TechPulse sở hữu; video quan trọng chỉ là link tới trang nguồn với nhãn AI chưa phân tích. TechPulse không tải về, proxy tùy ý, cache hoặc lưu binary/base64/GridFS media nguồn; MongoDB chỉ giữ URL/metadata/policy snapshot. Official embed, transcript và AI image/video analysis nằm hậu MVP.

## Alternatives Considered

### Alternative 1: Không hiển thị media

- **Pros**: Ít rủi ro quyền, security và broken link nhất.
- **Cons**: Feed khó quét và kém hấp dẫn trong demo.
- **Why not**: Một remote-preview được kiểm soát tạo giá trị UX đủ lớn với scope nhỏ.

### Alternative 2: Hotlink mọi media công khai

- **Pros**: Nhiều hình, không tốn database storage.
- **Cons**: Bỏ qua Terms/license, có privacy/referrer risk và dễ hỏng do anti-hotlink.
- **Why not**: “Publicly reachable” không phải executable permission.

### Alternative 3: Download/rehost media

- **Pros**: Hiển thị ổn định và kiểm soát performance tốt hơn.
- **Cons**: Tạo bản sao, storage/retention/takedown/security surface và nghĩa vụ quyền lớn hơn.
- **Why not**: Không phù hợp MVP và không cần thiết để chứng minh thesis.

## Consequences

### Positive

- Feed/detail có visual khi được phép nhưng vẫn fail closed theo source.
- MongoDB Free không bị tiêu tốn bởi binary và takedown media đơn giản hơn.
- AI disclosure chính xác vì media chưa xử lý không bị dùng làm evidence.

### Negative

- Ảnh remote có thể chậm, hỏng hoặc bị publisher chặn.
- Admin phải review media host/attribution riêng với text rights.
- Video MVP chỉ cung cấp link, không có rich playback hoặc transcript.

### Risks

- URL độc hại/tracking; chỉ HTTPS, exact host allowlist, CSP/referrer policy và không backend-proxy.
- Policy thay đổi sau ingest; serializer reload current policy, trả `leadMedia=null` khi không còn hợp lệ và enqueue reconciliation.
- Preview tạo cảm giác TechPulse sở hữu nội dung; luôn gắn nguồn/credit và CTA mở trang gốc.
