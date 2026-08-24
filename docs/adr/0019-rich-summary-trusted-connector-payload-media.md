# ADR-0019: Tóm tắt chi tiết, tin cậy payload connector và media an toàn

- **Trạng thái:** đề xuất
- **Ngày:** 2026-08-24

## Bối cảnh

Feed cần một tóm tắt ngắn để quét nhanh, trong khi trang chi tiết cần một bản tổng hợp nhiều đoạn, có đủ thông tin và đi thẳng vào ý chính của bài gốc. Ba connector hiện tại cũng cần giữ được media hợp lệ để hiển thị trực tiếp mà không lưu binary hoặc raw HTML.

## Quyết định

1. Mỗi lần tạo summary sinh một gói duy nhất gồm `titleVi`, `summaryVi` và `summaryParagraphsVi`. Feed chỉ đọc `summaryVi`; trang chi tiết đọc `summaryParagraphsVi` khi `summaryDetailStatus=ready` và fallback về summary ngắn khi detail chưa sẵn sàng.
2. `summary-detail-v1` thêm hai trường bắt buộc `summaryParagraphsVi` và `summaryDetailStatus`, backfill theo batch có giới hạn, không tạo giả một đoạn chi tiết từ summary cũ. Migration chỉ chạy với writers đang `paused`, sau đó mới lập validator strict; không có cơ chế `dual-write-ready` giả danh.
3. Payload đã được duyệt theo exact `sourceKey` của ba connector seed (`rss:the-verge`, `arxiv:cs-ai`, `hn:topstories`) và ba key demo tương ứng (`demo:rss-the-verge`, `demo:arxiv-cs-ai`, `demo:hn-topstories`) được phép vượt qua bộ lọc nhận diện email/credential/token cho mục đích summary. Đây không phải là tin cậy tùy ý: payload vẫn nằm trong delimiter, không được coi là instruction và không được gọi tool.
4. Q&A chỉ nhận evidence của source primary/editorial theo visibility gate hiện hành; Hacker News vẫn là `community-signal` và không được dùng làm evidence grounded. Evidence fence lưu hash và exact `sourceKey` để phát hiện policy drift.
5. Embedding chỉ dùng các trường derived (`titleOriginal`, `titleVi`, `summaryVi`, `topics`) và vẫn giữ privacy gate; không gửi raw full text để tránh mở rộng mặt phẳng dữ liệu nhạy cảm.
6. Media chỉ được hiển thị qua HTTPS remote preview nếu host nằm trong allowlist policy hiện tại. Video chỉ hiển thị liên kết đến trang nguồn; CSP và safe-URL đều fail closed. Không persist raw HTML, media binary, base64 hoặc provider payload.

## Hệ quả

- Summary chi tiết tốn thêm chi phí LLM và cần xử lý bất đồng bộ; trang chi tiết phải hiển thị trạng thái pending/failed rõ ràng.
- Mỗi thay đổi source policy có thể reset summary detail và media qua visibility reconciliation.
- Exact source key là một phần của policy; nếu thay đổi seed source phải cập nhật review/policy và test fence, không chỉ đổi connector type.
- Media host policy có thể cần restart/reload runtime để CSP snapshot nhận policy mới.
