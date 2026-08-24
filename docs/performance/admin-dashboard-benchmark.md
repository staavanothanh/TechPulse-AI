# Benchmark admin dashboard

Dùng `scripts/benchmarks/admin-dashboard-benchmark.js` để đo các lượt đọc chỉ
đọc, có authentication, của admin dashboard.

Command không load file `.env` và yêu cầu runner truyền environment rõ ràng. Nó
không in target URL, credential, cookie, request header, response header hoặc
response body. Command chỉ gửi một login request và các request `GET` sau login.
Không bật mutation E2E flag cho benchmark này.

## Chạy local

Khởi động local host và cung cấp một admin account đang active dành riêng cho
benchmark qua shell hoặc CI secret store. Không đặt value trong command history.

```powershell
$env:ADMIN_BENCHMARK_ENABLED = 'true'
$env:ADMIN_BENCHMARK_TARGET = 'local'
$env:ADMIN_BENCHMARK_BASE_URL = 'http://localhost:3000'
$env:ADMIN_BENCHMARK_ORIGIN = 'http://localhost:3000'
$env:ADMIN_BENCHMARK_EMAIL = '<dedicated-admin-email>'
$env:ADMIN_BENCHMARK_PASSWORD = '<dedicated-admin-password>'
node scripts/benchmarks/admin-dashboard-benchmark.js
```

Target phải là `http://localhost[:port]` khi `local`. Command từ chối URL có
credential nhúng và origin không khớp.

## Chạy preview

Chỉ dùng HTTPS Preview URL và một admin test riêng. Nếu deployment protection được
bật, chỉ truyền protection header do provider cấp qua
`ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON`. Runner chấp nhận `Authorization`,
`X-Vercel-Protection-Bypass` và `X-Vercel-Set-Bypass-Cookie`; runner từ chối
`Cookie`, `Origin`, `Host` và header không nằm trong allowlist.

```text
ADMIN_BENCHMARK_ENABLED=true
ADMIN_BENCHMARK_TARGET=preview
ADMIN_BENCHMARK_BASE_URL=https://preview.example.test
ADMIN_BENCHMARK_ORIGIN=https://preview.example.test
ADMIN_BENCHMARK_EMAIL=<dedicated-admin-email>
ADMIN_BENCHMARK_PASSWORD=<dedicated-admin-password>
ADMIN_BENCHMARK_PROTECTION_HEADERS_JSON=<provider-issued-json>
```

## Phép đo

Mỗi endpoint nhận một cold probe và các warm request tuần tự. Report chứa p50/p95,
status count, tổng byte response, error và timeout cho các authenticated endpoint:

- Overview: `GET /api/v1/admin/overview`
- Jobs/Ingestion: `GET /api/v1/admin/ingestion-jobs` và `GET /api/v1/admin/sources`
- Jobs/Indexing: `GET /api/v1/admin/indexing-jobs`
- Articles: `GET /api/v1/admin/articles`
- Audit: `GET /api/v1/admin/audit-logs`

Waterfall đại diện cho các dashboard read dự kiến sau khi user chuyển trang:
overview (1 request), Jobs/Ingestion (2 read đồng thời), Jobs/Indexing (1 read sau
khi đổi tab), Articles (1 read) và Audit (1 read). Nó đo hành vi API, không chứng
minh browser rendering.

`cold` gửi `Cache-Control: no-cache` và `Connection: close`. Đây là cold probe phía
client, không thể ép hoặc chứng minh cold start của Vercel/serverless.

Điều chỉnh giới hạn qua `ADMIN_BENCHMARK_ITERATIONS` (1–1000),
`ADMIN_BENCHMARK_COLD_ITERATIONS` (1–100) và `ADMIN_BENCHMARK_TIMEOUT_MS`
(1–120000).

## Chẩn đoán Mongo explain

Chỉ thêm `--with-mongo-explain` khi runner đã có quyền Mongo thông qua indirection
chuẩn:

```text
MONGODB_URI_ENV=ADMIN_BENCHMARK_MONGO_URI
ADMIN_BENCHMARK_MONGO_URI=<runtime-read-uri>
MONGODB_DATABASE=<database-name>
```

Probe mở Mongo client, chỉ chạy
`find({}).sort(...).limit(21).explain('executionStats')` cho articles, ingestion
jobs, indexing jobs, sources và audit logs, sau đó đóng client. Probe báo stage name
và execution statistic tổng hợp mà không in URI, database name, query value hoặc
document content. `COLLSCAN` hoặc `SORT` đánh dấu plan là `requiresAttention`,
không âm thầm pass. Nếu runtime credential không cho phép `explain`, output là
`unavailable` và phần HTTP report còn lại vẫn hợp lệ.

## Gate hồi quy E2E

`test/e2e/admin-dashboard-regression.test.js` dùng authenticated local-host client
hiện có và mặc định skip. Test xác minh API sequence cho admin overview/jobs/articles/
audit và contract filter. Test không điều khiển browser UI và không chứng minh UI
polling. Chỉ chạy khi local target đã được chuẩn bị:

```text
ADMIN_E2E_ENABLED=true
ADMIN_E2E_RUNNER_ENFORCE=true
E2E_BASE_URL=http://localhost:3000
E2E_ORIGIN=http://localhost:3000
E2E_ADMIN_EMAIL=<dedicated-admin-email>
E2E_ADMIN_PASSWORD=<dedicated-admin-password>
npm test -- --run test/e2e/admin-dashboard-regression.test.js
```

Regression không có mutation step. Indexing screen đang active có poll policy thích
ứng riêng. Kiểm chứng ở cấp browser cho control và polling cần browser test runner
đã cài cùng một target đã chuẩn bị.
