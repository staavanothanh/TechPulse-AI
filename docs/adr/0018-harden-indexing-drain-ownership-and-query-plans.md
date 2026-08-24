# ADR-0018: Gia cố quyền sở hữu drain indexing và query plan

- **Trạng thái**: accepted
- **Ngày**: 2026-08-23
- **Mở rộng**: ADR-0017

## Bối cảnh

Bounded drain được giới thiệu bởi ADR-0017 chọn due work theo task và loại các
article đã active trong cùng wave. Due-work index ban đầu không chứa `task`, vì
vậy backlog tăng có thể buộc Atlas post-filter nhiều row.

Lease heartbeat ban đầu chỉ gia hạn ownership. Mất heartbeat không dừng provider
request đang chạy, có thể làm trùng provider cost sau khi invocation khác recover
lease hết hạn. Worker rejection xảy ra sớm cũng có thể tạm thời không được quan
sát trong lúc drain tiếp tục chọn work.

## Quyết định

- Thêm migration riêng, idempotent `indexing-drain-performance` với due index
  aged và normal có xét task.
- Cho indexing runtime readiness fail closed cho tới khi cả hai index tồn tại.
- Bind release attestation generation và query plan verification của runtime scope
  `indexing-jobs` hiện có vào các index mới.
- Abort provider request khi indexing lease heartbeat mất ownership và ngăn stale
  worker commit terminal artifact state.
- Kiểm tra lại admin cancellation sau provider completion và yêu cầu artifact
  commit transaction xác nhận cancellation vẫn vắng mặt. Fenced reset riêng cho
  cancellation chỉ được phép khi cancellation đang hiện diện.
- Sửa artifact trong expired-lease recovery: work retryable/cancelled quay về
  `pending`, còn final failed attempt chuyển thành `failed`.
- Coi claim conflict sau lease acquisition là contention bình thường, release
  lease và tiếp tục drain work không liên quan.
- Gắn rejection handling ngay khi tạo wave task và giữ infrastructure error đầu
  tiên thay vì che nó bằng availability query.

## Hệ quả

- Deployment phải apply và verify `indexing-drain-performance`, sau đó issue
  runtime schema attestation mới trước khi runtime mới khả dụng.
- `db:verify indexing-drain-performance --issue-runtime-attestation` phát hành
  attestation dưới runtime scope `indexing-jobs` hiện có.
- Migration đã commit và index của chúng giữ nguyên, không thay đổi.
- Provider request có thể bị cancel khi mất lease; database fencing vẫn là lớp
  bảo vệ cuối chống stale commit.
- Provider output tạo ra trong race với admin cancellation bị loại; artifact trở
  về `pending` và job hoàn tất ở trạng thái cancelled.
- Selection có xét task tránh broad post-filter scan được xác định trong review
  độc lập.

## Phương án không chọn

- Bỏ qua heartbeat loss và chỉ dựa vào commit fencing: cách này bảo vệ dữ liệu
  nhưng vẫn có thể trùng provider call tính phí.
- Sửa migration `indexing-jobs` đã commit: database dùng chung có thể đã apply,
  nên bắt buộc cần migration idempotent mới.
- Tiếp tục dùng due index cũ: production backlog path vẫn dễ gặp Atlas scan tăng
  theo backlog.
