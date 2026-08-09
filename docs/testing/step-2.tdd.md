# Step 2 TDD evidence — MongoDB core, auth và session

## Phạm vi

Step này chỉ implement MongoDB core, server-side opaque session, CSRF bootstrap, register/login/logout/current-user/preferences, RBAC admin foundation, rate-limit primitives và audit transaction. Account deletion workflow, Source Registry, content, connector, provider, MFA và password reset vẫn ngoài phạm vi.

## RED

Ngay đầu RED, các test fail có chủ ý vì chưa có module/config/route:

- `test/config/auth-runtime.test.js`: Mongo config và keyring fields chưa tồn tại.
- `test/security/auth-primitives.test.js`: client-IP/password/session/rate-limit primitives chưa tồn tại.
- `test/migrations/auth-core.test.js`: auth-core migration chưa tồn tại.
- `test/security/auth-http.test.js`: auth routes chưa tồn tại, trả 404.

Command RED:

```text
npm test -- --run test/config/auth-runtime.test.js test/security/auth-primitives.test.js test/migrations/auth-core.test.js test/security/auth-http.test.js
```

## Remediation theo `.claude/discuss.md`

### RED

Các regression test được viết trước implementation và đã fail đúng lý do:

- client session-state chưa tồn tại; `/me` chưa phân biệt `401` với `503`, draft preferences không có validator local;
- middleware biến `503` thành anonymous/`403`; service quay CSRF hash ở mỗi `/me`, không audit conflict admin và để malformed admin ID thành lỗi repository;
- first-window duplicate key trả false `429`; migration thiếu `_id` trong audit deadline index; runtime chưa chặn HMAC retirement sớm;
- runtime auth/account fixture và Mongo role probe chưa tồn tại; guide còn ghi command orchestration không có thật;
- real-Mongo flow xác nhận CSRF khác nhau giữa hai `/me`, failed suspend audit không được persist, cleanup explain có `SORT` và seed concurrent chưa có primitive.

### GREEN và verification

- `AuthAccount` reset/sync draft theo user/session replacement, clear logout, validate unique/max-20/max-64 trước submit và không dùng persistent browser storage. UI chuyển `401` sang login/guest, còn network/`5xx` là retry state.
- CSRF được derive ổn định từ opaque session và chỉ hash trong Mongo; two-tab/StrictMode `/me` không thay hash của tab còn lại. Real-Mongo flow chứng minh hai token dùng được cho mutation.
- Rate-limit retry transaction duplicate-key tối đa ba lần, chỉ trả `429` khi bucket thật sự đạt limit.
- Admin ID malformed/unknown trả canonical `404`; reusable session/role/CSRF middleware giữ nguyên infrastructure `503` và phân biệt `401`/`403`.
- Audit cleanup index là `{ deadline: 1, _id: 1 }`, `db:verify` có explain không `COLLSCAN`/blocking `SORT`; audit conflict persist `result=failed`; role probe dùng transaction độc lập cho insert/find, update-deny và delete-deny.
- Quota HMAC retirement yêu cầu successor activation ít nhất 30 ngày; startup đồng thời fail-closed khi còn dependent rate-limit/IP-HMAC record phiên/audit của version bị retire.
- Contract selection `auth account` chạy 16 HTTP runtime success/error fixtures theo OpenAPI. Seed admin dùng atomic upsert và integration test chứng minh hai invocation concurrent chỉ tạo một account.
- Focused remediation suite: `9 files / 26 tests` pass.
- Full suite với `MONGODB_TEST_URI=mongodb://127.0.0.1:27019/?replicaSet=rs0` và database disposable: `19 files / 74 tests` pass.
- `npm run contract:validate` pass (`54 operations`, `0 remote refs`); `npm run contract:test -- auth account` pass (`16` runtime fixtures); `npm run lint` và `npm run build` pass.
- `npm run db:migrate -- --to auth-core` trên database disposable tạo `27` operations; `npm run db:verify -- auth-core` xác nhận `5` collection, role status `unavailable-local`.
- `npm run db:verify -- auth-core --require-role` cố ý fail trên local mongod không bật least-privilege authentication (`runtime Mongo role capability probe failed`). Đây là deployment-only gate, không được báo như production role đã pass.

### Final remediation — HMAC lifecycle, expired-session notice và docs

RED thực tế:

```text
npm test -- --run test/config/auth-runtime.test.js test/client/auth-session-state.test.js test/docs/step2-copy.test.js
```

Kết quả RED: `3 files`, `4` failure đúng mục tiêu — successor date cũ chỉ áp dụng khi không còn retiring key, `sessionExpiredNotice` chưa tồn tại/nội dung không sống qua guest remount, blueprint còn stale orchestration claim và guide có malformed text fence.

GREEN thực tế:

```text
npm test -- --run test/config/auth-runtime.test.js test/config/runtime.test.js test/client/auth-session-state.test.js test/docs/step2-copy.test.js
```

Kết quả lịch sử: `4 files / 14 tests` pass. Cơ chế predecessor JSON ở vòng này sau đó bị kill-test chứng minh có thể quên cả key lẫn record, nên đã được thay thế hoàn toàn bởi durable lifecycle bên dưới. Mutation trả `401` gửi fixed safe session-expired notice về App state, nên AuthAccount remount guest vẫn hiển thị lý do và cho login lại. Blueprint không còn stale orchestration claim; mọi reference fence trong orchestration guide dùng Markdown `text` hợp lệ.

### Final kill-test — durable HMAC lifecycle

RED được viết và chạy trước implementation:

```text
npm test -- --run test/security/hmac-lifecycle.test.js test/integration/hmac-lifecycle.mongo.test.js test/migrations/auth-core.test.js test/scripts/mongo-role-probe.test.js
```

Kết quả RED: `4 files` fail đúng mục tiêu — durable module chưa tồn tại, migration chưa có `hmacKeyLifecycleSnapshots`, role probe lifecycle chưa tồn tại. Regression diễn đạt chính xác config cũ `current=10, retiring=8,9`, sau đó operator bỏ đồng thời key/version 8 và declaration của 8 nhưng Mongo history vẫn phải nhớ version 8.

GREEN guarantees:

- `hmacKeyLifecycleSnapshots` giữ full sorted version inventory bằng append-only `revision + previousSnapshotHash + snapshotHash`; snapshot mới không được bỏ version cũ hoặc rollback/change fingerprint, successor hay state.
- Successor activation dùng thời điểm durable transition được Mongo ghi nhận. Từng missing retiring version được đánh giá riêng; 30 ngày không phụ thuộc retiring key khác còn tồn tại.
- Retirement chạy trong Mongo transaction, đếm exact-version records ở `rateLimitBuckets`, `sessions`, `adminAuditLogs`; snapshot retired chỉ hợp lệ với cả ba counter bằng 0.
- Runtime role boundary cho lifecycle chỉ `find/insert`; `update/delete` có probe deny độc lập. `db:verify` kiểm tra exact validator/index và explain latest-snapshot query.
- Snapshot chỉ giữ one-way fingerprint và lifecycle timestamps/counts; không giữ secret, HMAC key material hoặc raw subject.

Evidence thực tế trên replica set disposable `mongodb://127.0.0.1:27020/?replicaSet=rs0`:

- focused lifecycle/config/migration/role suite: `5 files / 14 tests` pass, trong đó lifecycle regression unit có `4 tests`;
- lifecycle real-Mongo nằm trong integration suite và pass cả startup reconciliation lẫn kill-test (`2 tests`), gồm age gate, ba dependency collections và append retirement revision;
- integration suite với Mongo thật: `3 files / 12 tests` pass; full suite với Mongo thật: `21 files / 81 tests` pass;
- `db:migrate -- --to auth-core`: `31 operations`; `db:verify -- auth-core`: `6 collections`, `roleStatus=unavailable-local`.

Production `db:verify -- auth-core --require-role` chưa được xác minh vì local replica set không có Atlas least-privilege credential; không được suy diễn thành production PASS.

### Native `.env` loading và Atlas-safe test runner

RED:

```text
npm test -- --run test/scripts/atlas-test-safety.test.js
```

RED fail vì safety module chưa tồn tại. GREEN cùng command: `1 file / 7 tests` pass, chứng minh indirect URI lookup, child-env allowlist, output redaction, reserved/protected database rejection, giới hạn tên Atlas 38 byte, exact cleanup target, DNS `1.1.1.1` được cấu hình trong process và default `npm test` không tự nạp Atlas credential.

Runtime scripts `dev`, `db:migrate`, `db:migrate:dry-run`, `db:verify`, `seed:admin` dùng native Node 24 `--env-file-if-exists=.env`; explicit `test:atlas` nhận đúng một mode `integration|full`. Từng process thực sự gọi Mongo cấu hình DNS `1.1.1.1`; không dựa vào preload state giữa parent/child. Integration database bắt buộc theo `techpulse_step2_test_<run-id>_<suite>`, không vượt 38 byte, và cleanup từ chối mọi target khác hoặc database chính.

Verification ngày 2026-08-10:

- `.env`, `.env.*` được Git ignore; `.env.example` vẫn track được. Presence-only probe xác nhận Mongo indirection/database/quota key variables đều configured mà không in giá trị.
- Default offline full suite: `19 files / 75 tests` pass, `3 files / 12 tests` skip Mongo; không tự kết nối Atlas.
- DNS probe ban đầu tái hiện `ECONNREFUSED`; cùng Atlas credential sau khi gọi DNS `1.1.1.1` ping thành công. Không URI, hostname, password hoặc key material được in.
- Atlas migration chạy hai lần idempotent, mỗi lần `31 operations`. Credential migration ở vòng đầu có quyền rộng nên không được dùng làm runtime role; production runtime gate được đóng riêng ở phần bên dưới.
- Atlas integration trên `techpulse_step2_test_48ec6b`: `3 files / 12 tests` pass. Atlas full suite trên `techpulse_step2_test_ce0788`: `22 files / 89 tests` pass, không skip. Chỉ các database test có suffix được cleanup; database chính không bị drop hoặc cleanup.
- Vòng Atlas integration này chưa chạy `db:verify --require-role` vì khi đó URI chưa được xác nhận là least-privilege runtime credential.
- `contract:validate` pass (`54 operations`, `0 remote refs`), `contract:test -- auth account` pass (`16` runtime fixtures), lint và build pass.

### Production Atlas role gate

RED regression:

```text
npm test -- --run test/scripts/mongo-role-probe.test.js
```

Kết quả RED: `1 file / 10 tests`, `7` failure đúng mục tiêu. Probe chưa nhận Atlas authorization denial `8000 / AtlasError`, đồng thời có thể hiểu nhầm lỗi `startSession`, `startTransaction`, `abortTransaction` hoặc `endSession` là mutation đã bị từ chối.

GREEN guarantees:

- Mongo authorization code `13` vẫn là denial hợp lệ.
- Atlas code `8000` chỉ được nhận khi `name` hoặc `codeName` là `AtlasError` và message thể hiện authorization denial rõ ràng; Atlas error không liên quan, network, transaction, validation và arbitrary error đều fail closed.
- Chỉ error phát sinh từ chính `updateOne`/`deleteOne` operation có thể chứng minh denial. Lỗi start/abort/end session không tạo false PASS.
- Audit và HMAC lifecycle dùng transaction riêng cho append/read, update-deny và delete-deny; mutation thực sự thành công luôn trả `updateDenied/deleteDenied=false`.

Evidence production ngày 2026-08-10:

- focused role/migration/Atlas-safety suite: `3 files / 20 tests` pass;
- `db:verify -- auth-core`: pass, `6 collections`, schema/validator/index/explain và role metadata verified;
- `db:verify -- auth-core --require-role`: pass, `6 collections`, live capability probe verified;
- `adminAuditLogs`: `find/insert` allowed, `update/delete` denied;
- `hmacKeyLifecycleSnapshots`: `find/insert` allowed, `update/delete` denied;
- không credential, connection string, hostname, raw error message hoặc namespace nào được ghi vào evidence.

Verdict: **Step 2 READY**.

## Ghi chú môi trường

Mongo integration chỉ chạy khi `MONGODB_TEST_URI` được cấp rõ ràng. Khi không có credential, test suite skip integration thay vì giả lập transaction. Không ghi secret vào log; seed chỉ báo cáo `seeded`/`existing`.
