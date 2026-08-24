# Tiện ích benchmark HTTP

Dùng `scripts/benchmarks/http-benchmark.js` để đo độ trễ API và kích thước response.

Command không load file `.env`, không đọc `process.env` và không in target URL,
request header, response header hoặc response body. Report chỉ chứa endpoint path,
timing tổng hợp, status count, byte count, timeout count và error count.

## Chạy local

Khởi động server local, sau đó chạy benchmark health mặc định:

```powershell
npm run dev
node scripts/benchmarks/http-benchmark.js
```

Chạy các public endpoint theo kế hoạch với 30 mẫu warm và concurrency:

```powershell
node scripts/benchmarks/http-benchmark.js `
  --endpoint /api/v1/health `
  --endpoint "/api/v1/articles?limit=20" `
  --endpoint "/api/v1/search-results?q=AI&mode=text" `
  --iterations 30 `
  --concurrency 4
```

## Chạy preview hoặc remote

Command yêu cầu `--url` rõ ràng khi target không phải local. Không đặt credential
trong URL. Chỉ dùng endpoint public hoặc endpoint không yêu cầu authentication cho
tiện ích này.

```powershell
node scripts/benchmarks/http-benchmark.js `
  --url https://preview.example.test `
  --endpoint /api/v1/health `
  --iterations 30 `
  --concurrency 4
```

Tiện ích chỉ gửi request `GET`. Nó không login, không mutate dữ liệu và không gắn
cookie hoặc authorization header.

## Chế độ đo

`--mode all` chạy ba phép đo cho mỗi endpoint:

- `cold`: probe tuần tự. Mỗi probe gửi `cache-control: no-cache` và
  `Connection: close`. Client không thể ép Vercel hoặc serverless cold start.
  Hãy xem đây là cold-start probe phía client, không phải bằng chứng instance mới.
- `warm`: request tuần tự trên cùng process.
- `concurrency`: request với số worker bị giới hạn bởi `--concurrency`.

Dùng `--cold-iterations` và `--cold-gap-ms` để lặp hoặc giãn các cold probe. Dùng
`--mode warm` hoặc `--mode concurrency` nếu chỉ cần một phép đo.

Mỗi summary báo cáo `p50Ms`, `p95Ms`, `p99Ms`, `statusCounts`, `bytes`, `timeouts`,
`errors` và `responseTooLarge`. Command in JSON ra standard output và không bao giờ
in nội dung response.

## Giới hạn an toàn

CLI và API `runBenchmark()` được import áp dụng cùng giới hạn: tối đa 20 endpoint,
1.000 warm/concurrency request cho mỗi endpoint, 100 cold probe cho mỗi endpoint,
100 worker, request timeout 120 giây và cold gap 5 phút. Việc tính response dừng ở
8 MiB và hủy readable stream khi vượt giới hạn. Query value và path segment dạng
secret-like hoặc opaque được redact trong report; không đặt credential trong request
path hoặc query.

## Attestation schema cho release

Vercel runtime bootstrap không inspect collection validator hoặc index của MongoDB.
Release gate phải chạy đầy đủ metadata verification cho từng runtime scope và phát
hành attestation có chữ ký:

```text
npm run db:verify -- auth-core --issue-runtime-attestation
npm run db:verify -- sources --issue-runtime-attestation
npm run db:verify -- durable-jobs --issue-runtime-attestation
npm run db:verify -- articles --issue-runtime-attestation
npm run db:verify -- indexing-jobs --issue-runtime-attestation
npm run db:verify -- provider-routing-v2 --issue-runtime-attestation
npm run db:verify -- chat-sessions --issue-runtime-attestation
npm run db:verify -- governance --issue-runtime-attestation
```

Tạo cặp khóa Ed25519 bên ngoài repository và lưu trong deployment secret manager.
Release verifier nhận private key base64 PKCS8 qua
`SCHEMA_ATTESTATION_PRIVATE_KEY_ENV`; đồng thời nhận deployment SHA bất biến qua
`SCHEMA_ATTESTATION_COMMIT`. Vercel runtime chỉ nhận public key base64 SPKI tương
ứng trong `SCHEMA_ATTESTATION_PUBLIC_KEY`; `VERCEL_GIT_COMMIT_SHA` cung cấp SHA của
deployment runtime.

Mỗi command thành công trả về `runtimeSchemaAttestation` gồm `payload` có chữ ký và
`signature`. Thêm từng envelope dưới payload scope tương ứng trong
`RUNTIME_SCHEMA_ATTESTATIONS_JSON`. Payload bind generation đã verify với deployment
SHA, MongoDB database và SHA-256 hash của MongoDB host authority. Không tái sử dụng
attestation cho commit, Atlas cluster hoặc database khác. Không đưa private key,
database URI, credential, HMAC key hoặc provider key vào
`RUNTIME_SCHEMA_ATTESTATIONS_JSON` hay runtime environment. Signature thiếu, sai
hoặc không hợp lệ sẽ ngăn capability runtime khởi động.

### Tự động hóa pre-push

Repository có tracked hook `.githooks/pre-push`. Bật hook một lần sau khi clone:

```text
npm run setup:hooks
```

Hook đọc branch SHA cuối từ input pre-push của Git, chạy tuần tự tám verification
scope, tạo một attestation registry, cập nhật `RUNTIME_SCHEMA_ATTESTATIONS_JSON`
trong linked Vercel project và refresh `.env` local bằng cùng registry trước khi Git
tiếp tục push. Local refresh dùng lại registry đã tạo cho Vercel nên không chạy lại
tám scope. `main` trỏ tới Vercel `production`; branch khác trỏ tới `preview`. Push
chỉ tag hoặc xóa branch sẽ được bỏ qua. Nếu một push cập nhật nhiều branch, hook từ
chối để một Vercel target không nhận attestation mơ hồ.

Giữ gate disabled cho tới khi release environment local hoặc CI có Vercel API token
và linked project configuration. Để bật, đặt `PREPUSH_ATTESTATION_ENABLED=true` và
`PREPUSH_VERCEL_UPDATE=true`; cấu hình `PREPUSH_VERCEL_API_TOKEN_ENV`, cùng với
`PREPUSH_VERCEL_PROJECT_ID`/`PREPUSH_VERCEL_TEAM_ID` hoặc
`.vercel/project.json` local. Token và `SCHEMA_ATTESTATION_PRIVATE_KEY` nằm ngoài
Git và ngoài Vercel runtime. Hook không bao giờ in verifier output, URI, token, key
hoặc nội dung attestation payload.

Hook cập nhật environment variable trước Git push. Thay đổi environment của Vercel
chỉ áp dụng cho deployment mới, nên Git deployment tiếp theo phải dùng cùng SHA cuối.
Nếu Vercel API update thất bại, hook thoát non-zero và chặn push.

### Refresh attestation local

Pre-push hook tự động refresh release attestation local sau khi Vercel update thành
công. Nếu hook disabled hoặc checkout được di chuyển mà không push, hãy refresh thủ
công trước khi chạy `npm run dev`:

```text
npm run attestation:local
```

Command đọc `HEAD` hiện tại, chạy cùng tám verification scope và chỉ cập nhật
`SCHEMA_ATTESTATION_COMMIT` cùng `RUNTIME_SCHEMA_ATTESTATIONS_JSON` trong `.env` sau
khi mọi scope thành công. Command không gọi Vercel và không in URI, credential, key
material hoặc attestation registry. Khởi động lại local server sau khi cập nhật để
environment được nạp lại.
