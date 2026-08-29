# ADR-0023: Điều phối due-work theo profile, kẹp hạn chót toàn cục và cách ly lease candidate

- **Trạng thái**: accepted
- **Ngày**: 2026-08-29
- **Mở rộng**: ADR-0011, ADR-0017

## Bối cảnh

Hệ thống điều phối cron hằng ngày (`GET /api/internal/cron/due-work`) trước đây sử dụng `createCoordinatorRunner` với ngân sách bắt đầu cố định 8 giây và 3 attempt cho mọi lượt chạy. Khi một nguồn dữ liệu ban đầu (như arXiv) mất hơn 30 giây để hoàn tất việc fetch và kiểm tra policy qua mạng:
1. Ngân sách 8 giây bị cạn kiệt ngay sau lượt chạy của nguồn đầu tiên.
2. Vòng lặp coordinator kết thúc và chuyển thẳng sang `cronIndexingDrainRunner` (được cấp riêng 240 giây chỉ để xử lý indexing), không có luồng quay lại để tiếp tục cào các nguồn dữ liệu tiếp theo trong ngày (như The Verge, Hacker News).
3. Do Vercel Cron chỉ kích hoạt mỗi ngày một lần, các job ingestion còn lại cùng các bài viết chưa cào bị kẹt vĩnh viễn ở trạng thái `queued`.
4. Khi một candidate ingestion gặp xung đột lease 409 (hoặc candidate cũ), adapter cũ đánh dấu defer toàn bộ hàng đợi ingestion, làm tê liệt các nguồn độc lập khác.

## Quyết định

1. **Quản lý Hạn chót Toàn cục theo Phase-Start Admission:**
   - Thiết lập hạn chót toàn cục duy nhất ngay từ đầu cron request: `globalDeadline = startedAt + CRON_DUE_WORK_PROFILE.budgetMs` (240 giây, để lại 60 giây dự phòng trước trần 300 giây của Vercel serverless function).
   - Truyền hạn chót tuyệt đối xuyên suốt từ `createCronDueWorkRunner` sang `coordinatorRunner` và `createProfiledIndexingDrainRunner`.
   - Áp dụng ngữ nghĩa **phase-start admission**: Một tác vụ mạng hoặc materializer đang chạy dở có thể kết thúc trễ hơn mốc dự kiến, nhưng hệ thống bảo đảm **không có bất kỳ pha mới nào (materialization page, coordinator turn, indexing task slice)** được phép bắt đầu nếu hạn chót 240s đã trôi qua hoặc thời gian còn lại dưới 1.000 ms.

2. **Chốt chặn Bắt đầu Pha & Phản hồi Quá hạn (Overdue Skip Response):**
   - Kiểm tra hạn chót toàn cục trước mọi trang materialization (kể cả trang 0).
   - Nếu prework chạy quá hạn (hoặc thời gian còn lại < 1.000 ms), bỏ qua hoàn toàn coordinator và indexing drain, trả về kết quả tổng hợp `runId: 'cron-overdue-skip'`.
   - Trong tình huống quá hạn này, hệ thống chủ động trả về `nextAvailableAt: null` mà không thực hiện thêm truy vấn database nào để tránh kéo dài thêm độ trễ khi ngân sách đã cạn; xem `nextAvailableAt: null` như một tín hiệu chưa xác định (omitted backlog signal) thay vì một mốc thời gian chính xác.

3. **Phân định 3 Execution Profiles chuyên biệt:**
   - `CRON_DUE_WORK_PROFILE` (240s / 200 jobs): Dành riêng cho cron tự động hàng ngày, cho phép coordinator cào cuốn chiếu các nguồn active và drain indexing.
   - `ADMIN_DUE_WORK_PROFILE` (150s / 24 jobs): Dành riêng cho thao tác thủ công *"Chạy queue bounded"* trên Admin Dashboard.
   - `LEGACY_QUICK_KICK` (8s / 3 jobs): Giữ nguyên vẹn cho thao tác auto-kick nhanh sau khi tạo nguồn hoặc bấm retry đơn lẻ.

4. **Cách ly Lease Defer theo từng Candidate Nguồn:**
   - `createIngestionQueueAdapter` bắt lỗi 409 conflict khi claim, lập tức giải phóng khóa nguồn và chỉ đánh dấu defer cục bộ candidate đó.
   - `selectDueIngestion` hỗ trợ `excludeSourceIds` (`$nin`) để bỏ qua nguồn đang bị xung đột mà không chặn các nguồn độc lập khác.
   - Khi ingestion claim thành công và tạo bài viết mới, coordinator lập tức un-exhaust hàng đợi indexing để vòng lặp spill tiếp tục xử lý ngay trong cùng lượt chạy.

## Hệ quả

- Các nguồn tin active trong ngày có cơ hội cào cuốn chiếu công bằng và liên tục trong cùng 1 lần gọi cron.
- Hàng đợi indexing được tái kích hoạt ngay khi có bài viết mới sinh ra, giảm thiểu backlog tồn đọng.
- Giữ nguyên 100% hợp đồng OpenAPI `DueWorkRun` (`202 Accepted`) và tính tương thích ngược của các endpoint admin.
- Không thể cam kết hàng đợi rỗng hoàn toàn nếu các connector/LLM bên ngoài phản hồi chậm quá 240 giây, nhưng hệ thống bảo đảm chắc chắn:
  - Mọi nguồn đến hạn nhận được lượt chạy công bằng trong khi start-guard còn cho phép.
  - Không có pha công việc mới nào bắt đầu sau khi hạn chót 240s đã trôi qua.
  - Phản hồi HTTP tuân thủ nghiêm ngặt schema mà không làm crash function hay vượt trần Vercel.
## Phương án không chọn

- Tăng cứng `budgetMs` của `createCoordinatorRunner` lên 240s dùng chung cho mọi nơi: Sẽ làm chậm nghiêm trọng thời gian phản hồi của các API tạo nguồn và retry thủ công vốn cần auto-kick nhanh.
- Cho phép indexing drain tự tính deadline riêng tách biệt với coordinator: Sẽ làm tổng thời gian chạy cộng dồn vượt quá trần 300 giây của Vercel function.
- Bỏ qua kiểm tra hạn chót trong vòng lặp pagination của materialization: Sẽ khiến hệ thống cố tình thực thi thêm công việc ngay cả khi thời gian invocation đã cạn kiệt.
