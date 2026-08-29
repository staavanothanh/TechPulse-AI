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

1. **Quản lý Hạn chót Toàn cục (Global Request Deadline Clamping):**
   - Thiết lập một hạn chót duy nhất cho toàn bộ vòng đời của cron request: `globalDeadline = startedAt + CRON_DUE_WORK_PROFILE.budgetMs` (240 giây).
   - Truyền hạn chót tuyệt đối xuyên suốt từ `createCronDueWorkRunner` sang `coordinatorRunner` và `createProfiledIndexingDrainRunner`.
   - Mọi tác vụ thành phần (materialization, coordinator, indexing tasks: summary, embedding, visibility) đều bị kẹp chặt theo hạn chót toàn cục này, bảo đảm không bao giờ vượt quá trần 300 giây của Vercel serverless function.

2. **Chốt chặn Bắt đầu Pha (Phase Start Admission Guard):**
   - Bảo đảm không có bất kỳ pha materialization, coordinator hay indexing drain nào được phép bắt đầu mới sau khi hạn chót toàn cục đã trôi qua hoặc thời gian còn lại dưới 1.000 ms.
   - Nếu prework quá hạn, coordinator và indexing drain bị bỏ qua hoàn toàn và trả về kết quả `runId: 'cron-overdue-skip'`, `nextAvailableAt: null` an toàn.

3. **Phân định 3 Execution Profiles chuyên biệt:**
   - `CRON_DUE_WORK_PROFILE` (240s / 200 jobs): Dành riêng cho cron tự động hàng ngày, cho phép coordinator tiêu hóa toàn bộ các nguồn ingestion active trong ngày và drain indexing.
   - `ADMIN_DUE_WORK_PROFILE` (150s / 24 jobs): Dành riêng cho thao tác thủ công *"Chạy queue bounded"* trên Admin Dashboard.
   - `LEGACY_QUICK_KICK` (8s / 3 jobs): Giữ nguyên vẹn cho thao tác auto-kick nhanh sau khi tạo nguồn hoặc bấm retry đơn lẻ.

4. **Cách ly Lease Defer theo từng Candidate Nguồn:**
   - `createIngestionQueueAdapter` bắt lỗi 409 conflict khi claim, lập tức giải phóng khóa nguồn và chỉ đánh dấu defer cục bộ candidate đó.
   - `selectDueIngestion` hỗ trợ `excludeSourceIds` (`$nin`) để bỏ qua nguồn đang bị xung đột mà không chặn các nguồn độc lập khác.
   - Khi ingestion claim thành công và tạo bài viết mới, coordinator lập tức un-exhaust hàng đợi indexing để vòng lặp spill tiếp tục xử lý ngay trong cùng lượt chạy.

## Hệ quả

- Toàn bộ các nguồn tin active trong ngày được cào đầy đủ và liên tục trong cùng 1 lần gọi cron duy nhất.
- Hàng đợi indexing được tái kích hoạt ngay khi có bài viết mới sinh ra, giảm thiểu tối đa backlog tồn đọng.
- Giữ nguyên 100% hợp đồng OpenAPI `DueWorkRun` (`202 Accepted`) và tính tương thích ngược của các endpoint admin.
- Không thể cam kết hàng đợi hoàn toàn rỗng nếu các connector/LLM bên ngoài phản hồi chậm quá 240 giây, nhưng hệ thống bảo đảm chắc chắn:
  - Mọi nguồn đến hạn nhận được lượt chạy công bằng trong khi start-guard còn cho phép.
  - Không có pha nào bắt đầu mới sau khi hạn chót 240s đã trôi qua.
  - Báo cáo chính xác tiến độ hoàn thành và `nextAvailableAt` an toàn.

## Phương án không chọn

- Tăng cứng `budgetMs` của `createCoordinatorRunner` lên 240s dùng chung cho mọi nơi: Sẽ làm chậm nghiêm trọng thời gian phản hồi của các API tạo nguồn và retry thủ công vốn cần auto-kick nhanh.
- Cho phép indexing drain tự tính deadline riêng tách biệt với coordinator: Sẽ làm tổng thời gian chạy cộng dồn vượt quá trần 300 giây của Vercel function.
- Bỏ qua kiểm tra hạn chót trong vòng lặp pagination của materialization: Sẽ khiến hệ thống cố tình thực thi thêm công việc ngay cả khi thời gian invocation đã cạn kiệt.
