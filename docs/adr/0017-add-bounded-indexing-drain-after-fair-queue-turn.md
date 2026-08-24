# ADR-0017: Thêm drain indexing có giới hạn sau lượt queue công bằng

- **Trạng thái**: accepted
- **Ngày**: 2026-08-23
- **Mở rộng**: ADR-0011

## Bối cảnh

ADR-0011 cấp cho mỗi durable queue đã đăng ký một lượt được giữ chỗ, sau đó
chuyển phần capacity còn lại cho queue đến hạn lâu nhất. Production runner
được cấu hình ba attempt tổng cộng; mức này đủ cho tính công bằng của queue
nhưng không đủ cho throughput indexing: một ingestion batch có thể tạo một job
summary và một job embedding cho mỗi bài viết đã publish.

Vercel cron là worker trigger tự động duy nhất trong deployment MVP và được
lập lịch hằng ngày. Giữ indexing trên runner ba attempt khiến backlog tăng
ngay cả khi provider còn capacity.

## Quyết định

Giữ lượt công bằng được dành riêng từ ADR-0011. Sau lượt đó:

- operation due-work rõ ràng của admin có thể chạy server-owned indexing drain
  với ngân sách bắt đầu 24 attempt trong 45 giây;
- cron hằng ngày có thể chạy server-owned indexing drain với ngân sách bắt đầu
  200 attempt trong 240 giây;
- công việc summary, embedding và visibility có concurrency cap độc lập;
- không bao giờ chạy đồng thời hai job cho cùng một article;
- claim attempt, kể cả lease conflict, đều tiêu thụ invocation cap;
- sau deadline guard không bắt đầu work mới, và mọi work đã bắt đầu đều settle
  trước khi invocation trả về;
- request create và retry giữ short fair auto-kick, không kế thừa admin drain dài hơn;
- HTTP caller không thể đặt queue selection, budget, claim cap hoặc concurrency.

Provider admission denial trước outbound attempt được defer với retry delay có
giới hạn. Configuration, privacy, evidence và failure sau outbound vẫn là
terminal theo recovery policy hiện tại.

## Hệ quả

- Indexing có thể dùng serverless invocation khả dụng mà không làm thiếu lượt
  dành cho account-deletion và ingestion.
- Admin có thể tạo tiến triển thủ công có giới hạn mà không phải chờ cron hằng ngày tiếp theo.
- Due-work response và OpenAPI contract giữ nguyên; drain counter được gộp vào
  indexing queue counter hiện có.
- Due index hiện tại vẫn hợp lệ cho patch ban đầu, dù task và article exclusion
  là post-filter. Nếu explain evidence sau này cho thấy scan không chấp nhận được,
  cần migration mới; không sửa migration đã commit.
- Vercel API function có execution ceiling năm phút, còn application budget thấp
  hơn để giữ margin khi shutdown.

## Phương án không chọn

- Tăng shared coordinator từ ba attempt mà không có concurrency: provider call
  vẫn tuần tự và có thể vượt quá invocation.
- Chạy `Promise.all` không giới hạn: có thể vượt provider admission, trùng article
  work và trả về trước khi mọi task đang sở hữu lease settle.
- Dùng drain dài cho mọi create/retry request: backlog không liên quan sẽ thêm
  synchronous latency không chấp nhận được vào admin mutation.
