# Step 3 TDD matrix — Source Registry và executable rights policy

> Trạng thái: remediation và local verification hoàn tất; Atlas deployment gate đang bị chặn vì migration/role chưa được áp dụng
> Authority HTTP: `docs/contracts/openapi.json`
> Source plan: `docs/plans/techpulse-ai-mvp.md`, Step 3

## 1. Preflight và phạm vi

- Step 2 baseline: commit `12847240ef9081e527ec81f6b291c5860a0b67e4`, working tree sạch trước Step 3. Owner commit `b8d44ef742268fb5a1b35ebb198c6df65c80ee2b` sau đó chỉ đổi root README, vẫn được bảo toàn ngoài diff Step 3.
- Implementation chỉ dùng JavaScript/JSX và dependency hiện có.
- Không fetch/network technical check thật, không ingestion/job/lease, không automatic license interpretation và không Step 4.
- Technical-check HTTP boundary có thể nhận injected fake trong contract/integration test; production không có adapter Step 4 phải trả canonical `503`, không fake success.
- Đã kiểm tra exact catalog name trước khi load và chỉ dùng ba skill có sẵn theo yêu cầu remediation: `security-review`, `verification-loop`, `frontend-a11y`.

## 2. Quyết định implementation đã suy ra từ authority

### 2.1. Policy version và marker

Một mutation tăng đúng một `policyVersion` và atomically đặt marker `pending` ở version mới khi thay đổi một trong các field ảnh hưởng ingestion/visibility/policy:

- `domain`, `authorityTier`, `connectorConfig`;
- `mediaPolicy`, `attributionRequired`, `attributionText`;
- policy review (`licenseStatus`, `llmInputScope`, `storageScope`, policy/media evidence và Terms/License URL);
- explicit re-review.

Đổi `name` hoặc chỉ đổi `operationalStatus` không tăng version. Sau khi source đã được review, mọi thay đổi ảnh hưởng rights evidence (`publisherName`, domain/authority/connector, media và attribution policy) bắt buộc phải vào re-review trước. Thay domain, `authorityTier` hoặc `connectorConfig` đồng thời vô hiệu technical check về `not-run`; activation không thể dùng evidence của cấu hình cũ. State fence vẫn chặn ingestion khi source không active. Mỗi request chỉ tăng tối đa một lần dù thay nhiều field versioned.

Source mới bắt đầu ở `policyVersion=1`, `licenseStatus=review-needed`, policy/storage/media fail-closed và reconciliation `idle` ở version 1. Marker mới có `status=pending`, `requiredPolicyVersion=policyVersion`, `requestedAt=serverNow`, `completedPolicyVersion=null`, `error=null`.

### 2.2. Technical check

Step 3 sở hữu schema/state boundary và serializer, không sở hữu safe-fetch adapter. Fake checker trong test có thể trả server-owned evidence để chứng minh activation prerequisites. Không request nào được tự khai báo `checkedAt`, resolved host, content type, sample count hoặc reviewer identity.

### 2.3. Audit

Create/update/review/re-review ghi allowlisted `changedFields`, optional allowlisted transition và action-specific reason code. Domain mutation và audit insert dùng cùng Mongo session/transaction. Nếu failed privileged mutation cần audit nhưng audit không persist được, service fail closed bằng canonical `503`; không nuốt lỗi rồi trả business error thiếu evidence. Không audit snapshot, free-form admin note, connector credential hoặc evidence text.

## 3. User journeys

1. Là admin, tôi tạo source draft với connector discriminant hợp lệ để cấu hình nguồn mà chưa cấp quyền xử lý.
2. Là admin, tôi review evidence và chọn quyền text/media để policy gate có thể enforce bằng code.
3. Là admin, tôi activate/pause source theo state machine và thấy lý do activation bị chặn.
4. Là admin, tôi yêu cầu re-review để source pause và fail closed ngay ở version mới.
5. Là user thường, tôi không thể đọc hoặc mutate bất kỳ Source Registry admin operation nào.
6. Là connector/provider consumer, tôi nhận structured allow/reject result và không thể tự nâng scope hoặc media host.

## 4. Tasks 1–9 → implementation → test → verification

| Task | Guarantee | Implementation owner/file dự kiến | RED/GREEN test | Verification |
|---|---|---|---|---|
| 1 | Source schema/index/state transition, connector discriminant và full policy matrix cùng enforce | `server/domain/source/{validation,state-machine}.js`; `scripts/migrations/sources.js` | `test/unit/sources/{validation,state-machine}.test.js`; `test/migrations/sources.test.js` | focused `source policy`; `db:verify -- sources` |
| 2 | Admin list/create/read/update/review/re-review đúng OpenAPI; reviewer/time server-owned | `server/application/sources/service.js`; `server/http/admin/sources/{router,serializer}.js` | `test/security/source-http.test.js`; `test/contract/admin-sources-runtime.test.js` | `contract:test -- admin-sources` |
| 3 | Pure content/media gates trả allowlist hoặc structured rejection; connector không nâng scope | `server/domain/policy/{content-policy,media-policy}.js` | `test/unit/sources/policy-gates.test.js` | focused `source policy` |
| 4 | Activation prerequisites, fail-closed current lookup, exact one version increment và pending marker | `server/domain/source/**`; `server/application/sources/{service,current-policy}.js`; source repository CAS | `test/unit/sources/{state-machine,current-policy}.test.js`; `test/integration/sources.mongo.test.js` | focused + real Mongo integration |
| 5 | Direct source mutation + safe audit cùng transaction; audit minimized | `server/audit/source-writer.js`; `server/repositories/mongo/source-repository.js`; sources migration audit extension | `test/unit/sources/audit.test.js`; `test/integration/{sources,source-flow}.mongo.test.js` | integration `sources audit` |
| 6 | Admin UI có draft/config/review/activate/pause và đầy đủ loading/empty/error/validation/a11y state | `client/features/admin/sources/**`; `client/App.jsx`; `client/styles.css` | `test/client/source-registry.test.js` | UI focused test + build |
| 7 | Seed chỉ tạo draft/review-needed; không permitted thiếu evidence | `scripts/seed-sources.js` | `test/scripts/seed-sources.test.js` | focused source test |
| 8 | Transition/matrix/connector/attribution/reconciliation/media-host edge cases bị reject | domain + Mongo validator | unit, migration và integration negative fixtures ở trên | focused + `db:verify -- sources` |
| 9 | Serialized success/error của 7 Source Registry operations validate cùng OpenAPI | `scripts/contracts/admin-sources-fixtures.js`; `scripts/contracts/test-contract.js` | `test/contract/admin-sources-runtime.test.js` | `contract:validate`; `contract:test -- admin-sources` |

## 5. Exit criteria → evidence bắt buộc

| Exit criterion | Evidence cần có |
|---|---|
| Thiếu evidence không thể activate permitted | Domain activation test + HTTP `422/409` fixture + Mongo integration |
| `review-needed|blocked|none` bị chặn đúng purpose | Content policy table tests cho metadata/excerpt/summary/embedding/retrieval |
| Media mặc định tắt; mode/host ngoài allowlist không tạo media | Media policy tests cho image/video, canonical hostname, IP/private/single-label/wildcard |
| Admin API/UI không expose secret; user luôn 403 | HTTP role tests, contract projection tests, UI markup test |
| Direct mutation chỉ commit cùng safe audit; contract không arbitrary object | Transaction rollback integration + audit validator negative fixtures |
| Connector mutation tăng đúng một version và marker/audit không drift | Multi-field single-increment integration test; re-review N→N+1 marker test |

## 6. Checkpoint gates

### Checkpoint 1 — Contract và RED

- Inventory 7 operation IDs: list, create, read, update, technical-check, policy review và re-review.
- Chỉ sửa OpenAPI nếu RED chứng minh observable shape thiếu/sai; sau đó generate, không sửa `shared/generated/**` bằng tay.
- RED phải cover schema, connector unit, matrix, transition, attribution, version và marker trước production code.

### Checkpoint 2 — Mongo/domain/policy

- Load `backend-patterns`, `database-migrations` trước implementation.
- Migration idempotent; exact validator/index; không sửa migration Step 2 đã commit.
- Runtime `.env` không dùng để migration disposable nếu không có operator credential riêng.

### Checkpoint 3 — Repository/application/API/audit

- Admin session + role + CSRF; unauthenticated `401`, user `403`.
- Mutation/audit transaction và no hard delete.

### Checkpoint 4 — UI/fixtures

- Load `frontend-design-direction`, `frontend-a11y`.
- Không copy Open Design artifact; dùng contract/state/accessibility direction.

### Checkpoint 5 — Review/final gate

- Load đúng exact skill có trong catalog: `security-review`, `verification-loop` và `frontend-a11y`.
- Chạy security/fail-closed review, interaction/a11y regressions, full coverage và live role verifier; không dùng tên skill không tồn tại.
- Không commit Step 3; dừng để Claude review độc lập.

## 7. RED → GREEN evidence

### Checkpoint 1

- RED: 4 suite fail do các module Source chưa tồn tại; contract inventory có 4 test pass.
- GREEN: schema/discriminant/matrix/state/version/marker và static contract đạt 31/31 test.
- OpenAPI có đủ 7 operation. Completion audit phát hiện strict ingress trả `400` cho query enum sai nhưng `listSources` chưa khai báo response này; contract-first RED được đóng bằng response `BadRequest`, runtime fixture và generated artifacts từ `npm run contract:generate`.

### Checkpoint 2

- GREEN focused domain/migration/policy: 31/31 ban đầu; completion audit mở rộng thành full transition matrix, 4 × 4 × 16 text-policy matrix và media cross-product.
- Migration `sources` chạy lại idempotently trên replica-set disposable; exact validator/index/audit extension và explain verification pass.

### Checkpoint 3

- RED: application/audit module chưa tồn tại; Source HTTP trả 404; repository/migration audit extension chưa tồn tại.
- GREEN unit/HTTP: Source service, audit writer và role/CSRF/503 boundary đạt 10/10 ban đầu; final focused source/policy đạt 65 pass, 9 integration skip khi chạy offline.
- GREEN real Mongo: 5 integration file, 22/22 test; riêng Source transaction/repository flow đạt 10/10. Có rollback khi audit fail, exact CAS race, non-advancing CAS rejection, pagination/cursor, canonical bad-query response, actor-session fence, re-review idempotent, safe failed audit và current-policy reload.
- RED/GREEN completion audit: HTTP list từng làm lộ persistence-only `rightsHolderNote`; explicit Source response serializer hiện chỉ phát các field thuộc OpenAPI và regression đạt 5/5.

### Checkpoint 4

- RED: admin Source Registry component, seed và runtime fixture module chưa tồn tại; config form regression fail trước khi được thêm.
- GREEN UI: 4/4 markup/helper test; loading/empty/error/live status, label/id, focus sau user action, keyboard-native control, draft/config/review/activate/pause và no credential input.
- GREEN contract: 17 runtime success/error fixture cho đủ 7 Source operation, gồm malformed list query, invalid transition và stale idempotency mismatch.
- GREEN seed: unit fixture và real-Mongo rerun chứng minh RSS/arXiv/Hacker News đều draft/review-needed; rerun chỉ reuse, không cấp quyền.

### Checkpoint 5

- `security-review` đã chạy theo checklist input/authz/CSRF/audit/secrets. Failed-audit persistence, actor/session idempotency mismatch, media source-page validation và role probe đều fail closed.
- `frontend-a11y` dẫn tới prerequisite-aware disabled actions, visible reason liên kết bằng `aria-describedby`, focus sau interaction và regression gọi controller action thật.
- `verification-loop` giữ nguyên coverage threshold hiện hữu và yêu cầu real-Mongo/order/contract/lint/build/diff gates trước handoff.

### Final-gate remediation

- RED focused: 6 file fail, 12 test fail/43 pass; tái hiện stale technical/rights evidence, swallowed audit failure, cross-target Idempotency-Key reuse, media thiếu `sourcePageUrl` và UI action thiếu prerequisite.
- RED real Mongo: cùng actor/session/key cập nhật được hai source khác nhau; rerun `auth-core` sau `sources` làm mất `SOURCE_AUDIT_VALIDATOR`.
- GREEN: config/rights change bắt buộc re-review, technical evidence bị invalidate, audit outage trả `503`, event identity scope theo actor/session/key và intent mismatch trả `409 idempotency_mismatch`.
- RED/GREEN migration cuối: test bắt `auth-core.js` lệch Git blob đã deploy và compatibility module chưa tồn tại. `auth-core.js` nay byte-identical với commit `12847240`; exact revision resolver/preflight nằm trong Step 3 compatibility layer và chỉ chấp nhận exact auth/Source validators. Unknown revision throw trước mọi mutation; CLI auth-core → sources → auth-core vẫn preserve exact Source revision.
- GREEN concurrent idempotency: hai HTTP request chạy đồng thời bằng `Promise.all` cho cùng source/actor/session/key đều trả logical `202`; source chỉ tăng một version, chỉ một success audit và marker `requestedAt` khớp audit `createdAt`. Không cần sửa production race logic.
- GREEN UI/media: media thiếu hoặc sai `sourcePageUrl` bị reject; action activation/technical/re-review/config hiển thị prerequisite, disabled state và reason có quan hệ a11y; create/config/status/review/re-review/technical/error/session-expiry đều có interaction regression.
- Targeted Chrome smoke qua CDP thật (không dependency mới) xác nhận keyboard Enter chọn source và chuyển focus tới heading, disabled activation/technical không gọi API, description IDs tồn tại, không positive `tabIndex`, create/config/review/re-review live announcement, `409` error, session-expiry recovery và accessibility tree. Harness local `.agents/source-registry-browser-smoke.mjs` được Git-ignore.

## 8. Verification cuối

| Command | Kết quả |
|---|---|
| `npm run contract:validate` | PASS — 54 operations, 0 remote refs |
| `npm run contract:generate` | PASS — 54 operations; chỉ generator cập nhật `shared/generated/**` |
| `npm run contract:test -- admin-sources` | PASS — 17 runtime fixtures |
| `npm run db:migrate:dry-run -- --to sources` | PASS — 9 operations, không kết nối/mutate database |
| `npm run db:migrate -- --to sources` | PASS trên local replica-set disposable — 9 operations; rerun PASS, database test đã được drop chính xác |
| `npm run db:verify -- sources` | PASS — exact schema/index/audit validator/explain; role không yêu cầu trong local run |
| `npm test -- --run source policy` | PASS — 95 pass, 13 integration skip do focused command không inject Mongo |
| Role/UI/migration focused suite | PASS — 4 file, 28/28 test |
| Final remediation focused suite | PASS — 3 file, 19/19 test |
| Migration immutability focused gate | PASS — 3 file, 9/9; deployed auth-core Git blob khớp, exact auth/Source accepted, unknown superset rejected trước mutation |
| CLI reverse-order/unknown migration kill-test | PASS — 3/3 trên Mongo disposable; CLI ba bước preserve Source revision, unknown revision không mutate collection nào, missing-schema verifier fail closed |
| Concurrent same-source/actor/session/key | PASS trên real Mongo — hai `202`, một policy-version increment, một success audit, marker/audit timestamp khớp |
| Targeted browser/a11y smoke | PASS — Chrome headless/CDP, 10 observable checks, `unexpectedTechnicalCalls=0` |
| `npm run test:integration -- sources audit` | PASS — 6 file, 25/25 trên replica-set disposable |
| `npm run lint` | PASS |
| `npm run build` | PASS |
| `npm run test:coverage:mongodb` | PASS — canonical safe wrapper, 38 file/206 test, zero skip; statements 80.10%, branches 75.96%, functions 85.37%, lines 87.45% |
| Clean-env Atlas `db:verify -- sources` | FAIL đúng gate — thiếu `sources`, Source audit validator chưa được migrate và role thiếu source find/insert/update |
| Clean-env Atlas `db:verify -- sources --require-role` | FAIL closed với `roleStatus=blocked-by-schema`; live delete-denial probe chưa được chạy khi schema chưa sẵn sàng |

`vitest.config.js` không thay đổi; không hạ threshold hoặc thêm exclusion. `test:coverage:mongodb` dùng child-env allowlist/redaction, protected-database guard, run-id 5 ký tự để mọi suite name giữ giới hạn 38 byte và exact cleanup dù pass/fail. Default `npm test` vẫn offline; coverage gate canonical mới chạy toàn bộ integration trên Mongo disposable.

## 9. Atlas runtime role delta và external gates

Repository thực tế cần privilege collection-level sau trong custom runtime role:

- `sources`: `find`, `insert`, `update`, `listIndexes`;
- tuyệt đối không thêm `remove`/`delete` cho `sources`;
- `adminAuditLogs`: tiếp tục quyền Step 2 `find` + `insert`, không `update`/`delete`;
- `users`, `sessions` và database-level `listCollections`: dùng quyền read/startup đã có từ Step 2, không phải delta mới.

Migration/seed cần operator credential riêng cho `createCollection`, `collMod` và `createIndex`; `seed:sources` fail closed nếu thiếu `MONGODB_OPERATOR_URI_ENV`. Không dùng runtime `.env` cho migration/seed trong evidence này.

Clean-env Atlas verification đã chạy nhưng fail trước capability mutation probe:

1. Atlas chưa có collection `sources` và `adminAuditLogs` vẫn dùng validator trước Step 3. Operator credential phải chạy migration `sources`; runtime credential không được cấp DDL để tự sửa.
2. Privilege introspection cho thấy custom runtime role còn thiếu `find`, `insert`, `update` trên `sources`. `listIndexes`/database `listCollections` không bị báo thiếu, nhưng live proof chỉ hợp lệ sau khi schema sẵn sàng.
3. Sau migration và role update bên ngoài repo, phải chạy lại cả base verify và `--require-role`; gate chỉ READY khi source find/insert/update/listIndexes/listCollections pass, source delete bị deny và audit update/delete vẫn bị deny.

Không dùng code để bypass external gate, không chạy migration bằng runtime credential và chưa commit Step 3.
