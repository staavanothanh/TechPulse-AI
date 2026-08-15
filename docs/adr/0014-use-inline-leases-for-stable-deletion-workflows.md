# ADR-0014: Sử dụng inline leases cho stable account-deletion workflows

**Ngày**: 2026-08-15
**Trạng thái**: accepted
**Người quyết định**: Project owner
**Làm rõ**: [ADR-0011](0011-coordinate-durable-work-scopes-recovery-and-fairness.md)

## Bối cảnh

ADR-0011 sử dụng shared `jobLeases` cho ingestion, indexing và reconciliation. Các job này có parent/child retry và cần generation high-water tách khỏi job document. Account deletion lại có một stable workflow document. Workflow này giữ từng cleanup checkpoint và được requeue trên cùng request sau crash.

Implementation Step 11 đã dùng inline lease trên `accountDeletionRequests`. Tài liệu cũ vẫn gán workflow này vào canonical `jobLeases`, nên không mô tả đúng transaction fence và recovery behavior.

## Quyết định

`accountDeletionRequests` giữ `leaseOwner`, `leaseExpiresAt` và `leaseGeneration` trên stable workflow document. Claim, cleanup checkpoint, fail, complete và recovery phải match exact owner token, generation và unexpired lease trong cùng transaction với domain mutation.

Expired recovery dùng compare-and-set để chuyển cùng request từ `running` về `queued`, tăng attempt và giữ các cleanup flag đã hoàn tất. Recovery không tạo parent/child request và không reset completion evidence.

Shared `jobLeases` chỉ điều phối ingestion, article indexing và source reconciliation. ADR-0011 vẫn là authority cho generation high-water, fairness và shared-scope coordination của ba queue này.

Recovery scan của account deletion cần indexed predicate theo status, lease deadline và stable `_id`. Thiếu exact index hoặc query-plan evidence là implementation gate, không được thay bằng unbounded scan.

## Các phương án đã cân nhắc

### Phương án 1: Dùng shared `jobLeases` cho account deletion

- **Ưu điểm**: Một lease model cho mọi queue.
- **Nhược điểm**: Tách owner khỏi stable cleanup checkpoints và thêm parent/child semantics không cần thiết.
- **Lý do không chọn**: Account deletion cần resume cùng request và giữ per-item completion evidence.

### Phương án 2: Không persist lease

- **Ưu điểm**: Repository đơn giản hơn.
- **Nhược điểm**: Serverless invocation overlap có thể cleanup và terminalize cùng workflow hai lần.
- **Lý do không chọn**: Không có exact stale-worker fence hoặc crash recovery.

## Hệ quả

### Tích cực

- Cleanup checkpoint và lease fence nằm trên cùng stable workflow.
- Recovery không tạo duplicate deletion request.
- Shared `jobLeases` giữ đúng phạm vi coordination đã thiết kế.

### Tiêu cực

- Hệ thống có hai lease storage shapes.
- Migration, readiness và query-plan verification phải cover inline recovery index riêng.

### Rủi ro

- Repository có thể chỉ đọc lease mà không conditional touch; transaction tests phải assert exact owner/generation/deadline filter.
- Recovery scan có thể thành collection scan; migration và `db:verify` phải require intended index.
