# ADR-0010: Preserve durable fencing and recover expired serverless jobs

**Date**: 2026-08-08
**Status**: accepted
**Deciders**: Project owner

## Context

`jobLeases` trước đây vừa giữ `leaseGeneration` high-water mark vừa dùng TTL để xóa document hết hạn. Nếu TTL xóa record rồi cùng lease key được tạo lại, generation có thể bị tái sử dụng và stale worker có cơ hội vượt qua fencing. Serverless invocation còn có thể chết sau claim, để job ở `running` dù lease đã hết hạn.

## Decision

Mỗi lease key giữ một record không dùng TTL với `generationHighWater` tăng đơn điệu và active ownership có thể rỗng. Claim chỉ xảy ra sau bounded recovery, atomically tăng generation; release chỉ xóa ownership. Mọi job/checkpoint/article/artifact commit phải conditionally touch đúng active owner + generation trong cùng Mongo transaction; AI artifact commit còn phải khớp current Source Policy version đã capture trên job.

## Alternatives Considered

### Alternative 1: Tách fencing counter khỏi TTL lease

- **Pros**: Vẫn cleanup được lease liveness document tự động.
- **Cons**: Thêm collection, index và coordination giữa counter với lease.
- **Why not**: Quy mô MVP nhỏ; một persistent record trên mỗi bounded resource key đơn giản hơn và vẫn giữ high-water bền vững.

### Alternative 2: Chỉ giữ generation trên job document

- **Pros**: Không cần lease collection riêng.
- **Cons**: Không fence được shared resource key hoặc chứng minh cross-document artifact commit còn thuộc current owner.
- **Why not**: Không đủ bảo vệ source/article bị nhiều invocation xử lý đồng thời.

### Alternative 3: Dùng durable queue/worker bên ngoài

- **Pros**: Có sẵn scheduling, retry và visibility timeout.
- **Cons**: Thêm hạ tầng, chi phí và integration ngoài mục tiêu học kỳ.
- **Why not**: Chưa cần cho quy mô MVP; đây vẫn là upgrade path khi workload lớn hơn.

## Consequences

### Positive

- Lease generation không bị reset bởi TTL hoặc release.
- Crash-after-claim được recovery hữu hạn và stale worker không commit sau reacquire.
- Job, checkpoint và artifact dùng cùng một fence invariant có thể kiểm thử.

### Negative

- Lease record tồn tại theo vòng đời resource key thay vì tự biến mất.
- Recovery và commit cần Mongo transaction ngắn, conditional touch và retry khi write conflict.

### Risks

- Lease collection tăng không giới hạn nếu key được tạo ngẫu nhiên; key phải derive từ bounded logical resource và chỉ được garbage-collect bằng migration có kiểm chứng không còn worker/job tham chiếu.
- Policy có thể đổi trong lúc provider đang chạy; output cũ phải bị discard khi commit fence hoặc policy-version check thất bại.
