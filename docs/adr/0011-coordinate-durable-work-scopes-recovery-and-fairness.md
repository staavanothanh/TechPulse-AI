# ADR-0011: Coordinate durable work scopes, recovery and queue fairness

**Date**: 2026-08-08
**Status**: accepted
**Deciders**: Project owner via approved Plan-of-Record v1.5 repair

## Context

ADR-0010 chốt persistent generation fence nhưng chưa chuẩn hóa cách derive lease key, nên cron và admin invocation có thể vô tình không tranh chấp trên cùng logical resource. Generic recovery kiểu terminal parent + linked child cũng không phù hợp với `accountDeletionRequests`, nơi completion flags phải nằm trên một stable workflow document. Cuối cùng, một global priority sort có thể làm indexing hoặc account deletion bị starve khi ingestion backlog kéo dài.

## Decision

Lease key phải do server derive từ bounded logical resource theo canonical grammar và không chứa actor, invocation hoặc random job ID. Ingestion/indexing dùng immutable terminal parent + deterministic linked retry; account deletion recovery dùng exact-fence CAS để requeue chính stable request, tăng attempt và giữ completion flags. Due-work coordinator chọn việc theo priority trong từng registered queue, cấp ít nhất một reserved due slot cho mỗi queue trong mỗi invocation rồi mới spill capacity; unregistered queue có zero counters và không bị query.

Canonical lease-key contract:

| Namespace | Grammar | Operations phải dùng chung key |
|---|---|---|
| Source ingestion | `ingestion:source:<sourceId>` | cron materialization, admin trigger, retry cùng source |
| Article indexing | `indexing:article:<articleId>` | summary, embedding, visibility reconciliation cùng article |
| Source reconciliation | `reconciliation:source:<sourceId>` | marker claim, cursor/fan-out, retry cùng source |
| Account deletion | `account-deletion:user:<userId>` | automatic deletion, recovery và admin retry cùng user |

`<sourceId>`, `<articleId>` và `<userId>` là canonical lowercase opaque ID dài 1–128 ký tự, chỉ gồm `a-z`, `0-9`, `_` hoặc `-`; không dùng email hoặc dữ liệu nhận diện. Acquisition từ key ngoài table, key chứa actor/invocation/job ID, hoặc key không canonical phải bị reject trước database access.

Fairness contract:

1. Mỗi queue tự chọn due item theo effective priority giảm dần, `availableAt`, stable creation timestamp và `_id`; item quá hạn vượt aging threshold được nâng lên queue-local maximum.
2. `maxJobs` phải không nhỏ hơn số registered queue. Trước recovery/execution, coordinator phải reserve deadline/claim margin đủ để thử một due item cho từng registered queue; nếu budget không đủ thì không spill và báo cấu hình/budget không hợp lệ. Canonical queue order là `account-deletion → indexing → ingestion`; coordinator thử tối đa một reserved due item theo order này trước khi cấp slot còn lại theo oldest due item, tie-break bằng cùng order.
3. Slot không dùng được spill; một queue đang due liên tục vẫn tiến triển ít nhất một item mỗi invocation hữu hạn.
4. `nextAvailableAt` là minimum `availableAt` còn lại của queued item trong registered queues; là `null` chỉ khi không còn queued item.

## Alternatives Considered

### Alternative 1: Derive lease key từ job hoặc invocation ID

- **Pros**: Dễ tạo và không cần namespace table.
- **Cons**: Hai actor xử lý cùng source/article không tranh chấp, làm fence mất ý nghĩa.
- **Why not**: Không bảo vệ logical resource trước concurrent cron/admin/retry work.

### Alternative 2: Mọi workflow đều terminal parent và tạo linked child

- **Pros**: Một recovery algorithm duy nhất.
- **Cons**: Account deletion mất stable unique-user workflow và dễ làm rơi hoặc lặp completion flags.
- **Why not**: Cleanup phải resume chính request đã lưu evidence, không tạo workflow identity mới.

### Alternative 3: Global priority sort cho mọi queue

- **Pros**: Query/selection đơn giản.
- **Cons**: Queue priority cao hoặc backlog lớn có thể starve safety work và indexing vô hạn.
- **Why not**: Không chứng minh bounded progress cho từng due queue.

### Alternative 4: External queue service

- **Pros**: Có scheduler, visibility timeout và fairness primitives sẵn.
- **Cons**: Thêm hạ tầng, chi phí và deployment ngoài MVP.
- **Why not**: Registered adapters và Mongo-backed coordination đủ cho quy mô đồ án.

## Consequences

### Positive

- Cron, admin và retry cùng resource luôn contend trên một fence.
- Recovery giữ đúng identity/completion model của từng workflow.
- Sustained backlog không thể làm một registered due queue bị starve.
- Step 4 có adapter contract rõ để Step 9 và Step 11 đăng ký queue mà không giành ownership schema.

### Negative

- Runner có hai recovery strategies và cần queue registry rõ ràng.
- Reserved phase giới hạn throughput cực đại của queue đông khi queue khác cũng due.
- Article-level indexing key serialize summary/embedding/reconciliation của cùng article.

### Risks

- Sai normalization có thể tạo hai key cho một resource; implementation phải có table-driven derivation tests và cấm caller truyền raw key.
- Cấu hình `maxJobs` nhỏ hơn số registered queue phá fairness; startup/runtime validation phải fail closed.
- Account deletion retry có thể lặp side effect; mỗi cleanup flag chỉ được set sau idempotent action và same-request CAS phải giữ flag đã hoàn tất.
