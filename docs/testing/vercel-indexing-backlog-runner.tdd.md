# Bằng chứng TDD: Vercel indexing backlog runner

## Vấn đề

Due-work coordinator dùng chung cấp cho mỗi queue đã đăng ký một lượt công bằng
và chỉ được cấu hình ba job attempt tổng cộng. Một ingestion batch có thể tạo ra
nhiều summary và embedding job hơn mức đó, nên một lần Vercel cron mỗi ngày không
thể drain hết indexing backlog.

## Tiêu chí chấp nhận

- Giữ lượt queue công bằng hiện có cho account deletion, indexing và ingestion.
- Sau lượt công bằng, drain thêm indexing job trong giới hạn do server sở hữu;
  HTTP caller không thể chọn limit, concurrency hoặc queue.
- Không bao giờ xử lý đồng thời hai indexing job cho cùng một article.
- Giới hạn độc lập concurrency của summary và embedding work.
- Dừng bắt đầu work khi chạm claim cap hoặc execution deadline.
- Lease conflict của một article không được chặn các article không liên quan.
- Provider admission denial trước mọi outbound request phải defer cùng job và
  đưa artifact của article về `pending` thay vì terminal `failed`.
- Bảo toàn due-work response và OpenAPI contract hiện có.
- Giữ production cron schedule hằng ngày và đặt Vercel function duration có giới hạn rõ ràng.

## Ma trận TDD

| Layer | Bằng chứng |
| --- | --- |
| Unit | bounded indexing drain, task concurrency, article serialization, deadline, claim cap |
| Unit | provider pre-outbound denial metadata và safe job defer |
| Unit | artifact pending reset khi không có external attempt |
| Integration | cron materialization xảy ra trước fair turn và bounded drain |
| Contract/security | admin authorization, CSRF, rate limiting và response shape hiện có vẫn không đổi |
| Deployment | cron hằng ngày vẫn được đăng ký; API function duration được đặt rõ ràng |

## Nhật ký kiểm chứng

Các command và kết quả thực tế được ghi lại tại đây khi thực hiện các checkpoint
RED, GREEN và review.

### RED

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/vercel/deployment-config.test.js
```

Kết quả: failure được kỳ vọng. Module drain mới chưa tồn tại và năm behavior test
fail vì provider metadata, safe defer, artifact pending reset, cron composition và
Vercel duration. Assertion hiện có trong focused set vẫn green (`53 passed`).

```text
npm test -- --run test/unit/jobs/service.test.js
```

Kết quả: failure được kỳ vọng (`15 passed`, `1 failed`) vì create/retry auto-kick
và explicit admin drain vẫn dùng chung một runner.

### GREEN

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/jobs/service.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/vercel/deployment-config.test.js
```

Kết quả: PASS (`7 files`, `80 tests`).

```text
npm test -- --run test/unit/jobs/coordinator.test.js test/unit/indexing/repository.test.js test/unit/indexing/bootstrap.test.js test/unit/indexing/service.test.js test/unit/jobs/service.test.js test/security/jobs-http.test.js test/ui/admin/admin-due-work.test.js
```

Kết quả: PASS (`7 files`, `51 tests`). Regression của repository selector sau đó
được thêm và pass riêng (`1 file`, `5 tests`).

```text
npm test -- --run test/integration/jobs-leases.mongo.test.js
```

Kết quả: Mongo integration suite được phát hiện nhưng skip vì `MONGODB_TEST_URI`
không có trong test process (`14 skipped`).

```text
npm run lint
npm run build
git diff --check
```

Kết quả: PASS.

```text
npm test -- --run --coverage test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/jobs/bootstrap.test.js test/unit/jobs/service.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/provider-router.test.js test/unit/indexing/repository.test.js test/vercel/deployment-config.test.js
```

Kết quả: toàn bộ focused test pass (`8 files`, `86 tests`). Command vẫn exit
non-zero vì repository-wide coverage threshold được tính trên riêng focused subset
(`34.32%` lines globally). Các module focused đã đổi báo cáo lần lượt, trong đó có
`91.01%` lines cho drain mới, `79.68%` cho indexing queue, `94.64%` cho provider
routing, `96.70%` cho artifact processing, `97.40%` cho jobs service và `97.05%`
cho jobs bootstrap. Global coverage gate vẫn dành cho giai đoạn kiểm chứng cuối; ở
đây không báo cáo gate là pass.

GREEN focused cuối cùng, gồm HTTP security và admin UI regression: PASS (`10 files`,
`101 tests`).

### Khắc phục sau review độc lập

Review độc lập về code và security tìm thấy ba defect concurrency/error-path và một
defect Atlas query plan. Mỗi defect đều được tái hiện bằng regression test fail trước
implementation:

- wave rejection xảy ra sớm có thể trở thành unhandled rejection trước settlement;
- claim conflict sau lease acquisition có thể dừng toàn bộ drain;
- availability query có thể che infrastructure failure đầu tiên;
- heartbeat mất không hủy provider request;
- task-aware selector vẫn buộc dùng due index không xét task;
- cancellation đang in-flight có thể publish output qua race giữa check và commit;
- lease mất ở final attempt có thể để artifact `processing` vĩnh viễn.

GREEN remediation truyền lease cancellation vào provider adapter, ngăn artifact
transition từ stale worker, release lease khi claim race, quan sát wave rejection
ngay lập tức, giữ infrastructure error gốc và thêm migration idempotent cho task-aware
index. Artifact commit hiện fence cancellation state atomically, còn expired-lease
recovery sửa artifact state tương ứng.

```text
npm test -- --run test/unit/jobs/indexing-drain.test.js test/unit/indexing/queue.test.js test/unit/indexing/artifact-processor.test.js test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/indexing/repository.test.js test/migrations/indexing-drain-performance.test.js test/unit/indexing/bootstrap.test.js test/unit/performance/schema-readiness.test.js
```

Kết quả: PASS (`8 files`, `81 tests`).

Focused regression expansion cuối: PASS (`16 files`, `168 tests`). Security
regression: PASS (`12 files`, `77 tests`). `contract:validate`, `contract:test`,
`npm run lint`, `npm run build` và `git diff --check` đều pass.

```text
npm run db:migrate:dry-run -- --to indexing-drain-performance
```

Kết quả: PASS với hai thao tác `createIndex` không destructive. Migration chưa
được apply vào shared Atlas database. Mongo lease integration suite được phát hiện
lại nhưng vẫn skip vì `MONGODB_TEST_URI` chưa có trong test process (`14 skipped`).
