# Step 4 — TDD evidence

> Historical snapshot: operation counts below were correct when recorded. Current canonical OpenAPI has 55 operations.

## Phạm vi

Step 4 triển khai durable ingestion jobs, persistent lease fencing, bounded due-work/maintenance, SSRF-safe source fetch, source technical check và giao diện jobs tối thiểu. Connector parse và article persistence vẫn thuộc Step 5 và không được triển khai ở đây. Khi Step 5 executor chưa đăng ký, runner lấy exact lease/fence rồi requeue job với `availableAt` server-derived trước khi release, nên một due item không bị xử lý lặp trong cùng cron run.

Không dùng Atlas, không đọc `.env`, không thêm dependency và không sửa migration đã commit. Mongo evidence dùng replica-set disposable trên loopback; mọi database test có prefix bảo vệ và được drop bởi harness.

## RED

- Migration/domain slice ban đầu fail vì chưa có `durable-jobs`, lease-key, idempotency và queue/coordinator modules; regression Git-blob cho ba migration đã commit vẫn pass.
- Safe-fetch/technical-check slice fail trước khi adapter tồn tại; HTTP jobs/cron/maintenance trả `404` ở cả bốn case trước khi router được đăng ký.
- UI slice fail vì `JobsPanel` chưa tồn tại và technical-check action vẫn bị khóa với nội dung Step 3 cũ.
- Real Mongo verifier đầu tiên fail đúng mục tiêu với `ingestion_purge:SORT,COLLSCAN`; runtime query và verifier sau đó dùng exact named index hint.
- Coverage gate đầu tiên sau implementation đạt 288/288 test nhưng fail threshold ở statements/branches. Regression hành vi bổ sung cho network decoding/error paths, queue execution, HTTP mutation, Mongo fence/list/retention và registry fail-closed; không hạ threshold hoặc thêm exclusion.

## GREEN guarantees

- `ingestionJobs`, `jobLeases` và `ingestionScheduleProgress` có closed validator/exact index; lease không TTL, progress giữ cursor server-owned theo daily period, `generationHighWater` persistent và job giữ 14-day idempotency floor/retention 14/30 ngày.
- Raw migration và compatibility runner đều preflight exact known audit-validator revision trước mutation. CLI reverse order giữ durable audit superset; auth/source verifier chấp nhận đúng forward revision, unknown revision fail closed.
- Manual idempotency scope là actor + session + sessionVersion + key; transaction resolve exact replay trước admission, rồi reserve quota + persist job/audit cùng boundary. Same hash hội tụ một logical job, mismatched intent trả `409 idempotency_mismatch`.
- Lease acquire/heartbeat/release/claim/terminal/defer/recovery đều dùng canonical resource key và exact owner hash + generation + unexpired timestamp. Expired heartbeat không resurrect; recovery tạo tối đa một deterministic linked retry và không xóa high-water.
- Aged lane chạy trước normal lane; normal lane loại aged item rõ ràng. Coordinator reserve mỗi registered queue trước spill, dùng hết bounded recovery allowance, ngừng trước safety margin và không query queue chưa đăng ký.
- Cron và maintenance chỉ nhận dedicated bearer; browser/admin cookie không thay thế machine auth. Maintenance chỉ nhận fixed task name, cutoff/limit/predicate/cursor đều server-owned và batch tối đa 100.
- Safe-fetch chỉ nhận credential-free HTTPS, validate toàn bộ A/AAAA trong cùng absolute deadline (kể cả redirect), chặn mixed/private/link-local/mapped/reserved, pin socket IP với original Host/SNI, revalidate redirect và giới hạn wire 1 MiB, decoded 4 MiB, ratio 20 trước connector. Không persist hoặc serialize body.
- Source technical check hỗ trợ RSS/Atom, arXiv và Hacker News; response chỉ chứa bounded evidence/safe error. UI technical-check và jobs actions có native button state, connected prerequisite text, focus target và live announcements.
- OpenAPI runtime fixtures kiểm tra success/error thực của source-check, jobs, cron và maintenance; internal caller predicates serialize canonical `400` envelope.

## Verification cuối

| Command | Kết quả |
|---|---|
| `npm run contract:validate` | PASS — OpenAPI 3.1, 54 operations, 0 remote refs |
| `npm run contract:generate` | PASS — 54 generated operations |
| `npm run contract:test -- source-check ingestion-jobs cron` | PASS — 17 admin-source fixtures, 18 Step 4 fixtures |
| Direct clean-env `node scripts/db-migrate.js --to auth-core/sources/durable-jobs` | PASS trên replica-set disposable — 31/9/17 operations; durable rerun 17 operations |
| Direct clean-env `node scripts/db-verify.js auth-core/sources/durable-jobs` | PASS — 6/1/3 owned collections; exact validators/indexes/explain |
| `npm test -- --run jobs safe-fetch` | PASS — current focused remediation command 24 files / 180 tests; Mongo integration is run separately |
| `npm run test:integration -- jobs leases cron` | PASS sau restart disposable mongod — 8 files, 41/41 |
| `npm run test:security -- ssrf` | PASS — 9 files, 63/63 |
| Full Mongo coverage (`vitest run --coverage`, explicit loopback env) | PASS — 56 files, 314/314; statements 80.39%, branches 76.18%, functions 85.18%, lines 88.10% |
| `npm run lint` | PASS |
| `npm run build` | PASS — Vite production build |
| `git diff --check` | PASS |

Một integration attempt trước rerun đã fail toàn bộ Mongo hooks ở `connect()` vì disposable `mongod` PID đã chết và port đóng; không có assertion code nào chạy. Replica-set disposable mới được khởi tạo, health xác nhận writable primary và toàn bộ integration/coverage/migration gate sau đó pass. Không tăng timeout hoặc sửa code để che lỗi môi trường.

Production Atlas/role gate không chạy theo scope. Step 4 không claim production role evidence và không dùng runtime credential để migrate/test.

## Final blocker remediation — current round

### RED evidence

- `npm test -- --run test/security/ssrf/safe-fetch.test.js test/unit/jobs/step4-final-gate.red.test.js` ban đầu fail đúng ba kill-test: DNS không settle, redirect DNS chậm và exact `409 idempotency_mismatch` không xoá poisoned intent key.
- Regression Mongo mới được thêm trước khi implementation: 101 source continuation/replay/concurrency/period rollover, defer lặp giữ age deadline, manual linked retry race automatic recovery, và atomic admission/replay cho create + retry.

### Finding → evidence

| Blocker | File/test chính | Kết quả |
|---|---|---|
| DNS absolute deadline | `safe-fetch.js`; `test/security/ssrf/safe-fetch.test.js` | PASS — lookup never-settle và redirect lookup chậm trả `source_fetch_timeout`; request sau deadline không chạy |
| Daily continuation >100 | `job-repository.js`; `test/integration/jobs-leases.mongo.test.js` | PASS — `ingestionScheduleProgress` CAS keyset cursor materialize đủ 101 source, replay/concurrent/period rollover không bỏ source |
| Cron/manual separation | `bootstrap/jobs.js`; `test/unit/jobs/bootstrap.test.js`, `service.test.js` | PASS — cron materialize trước coordinator; manual chỉ gọi injected coordinator |
| Fairness qua defer | `durable-jobs.js`, `job-repository.js`; Mongo integration | PASS — validator lock `agingEligibleAt=createdAt+30m`; defer lặp không đẩy deadline và aged lane thắng normal priority |
| Rate admission fail-closed | `sources/service.js`, `jobs/service.js`; unit + Mongo integration | PASS — configured service reject dependency thiếu; technical check không gọi outbound adapter khi limiter unavailable; job admission lỗi không persist |
| Atomic idempotency/admission | `job-repository.js`, `rate-limit-admission.js`; `jobs-leases.mongo.test.js`, `rate-limit-admission.test.js` | PASS — replay/mismatch không reserve thêm; concurrent create/retry chỉ một job/audit/quota increment |
| Stale reload error | `request-sequence.js`, `JobsPanel.jsx`; `test/client/request-sequence.test.js` | PASS — B success rồi A 401 reject giữ latest state, không trigger session-expiry handler |
| UI intent key recovery | `job-actions.js`; `step4-final-gate.red.test.js` | PASS — network/statusless failure reuse key; exact mismatch mới cấp key mới |
| Manual/recovery retry race | `job-repository.js`; Mongo integration | PASS — cùng parent/nextAttempt giữ tối đa một canonical child, không fork history |

### Verification current round

| Command | Kết quả |
|---|---|
| Focused unit/security regression | PASS — 23 files / 178 tests |
| `npm run test:security -- ssrf` | PASS — 9 files / 63 tests |
| `npm run test:integration -- jobs leases cron` với replica-set disposable | PASS — 8 files / 41 tests |
| `npm test -- --run` với replica-set disposable | PASS — 59 files / 340 tests |
| Direct clean-env `node scripts/db-migrate.js --to auth-core/sources/durable-jobs` | PASS — 31 / 9 / 17 operations |
| Direct clean-env `node scripts/db-verify.js auth-core/sources/durable-jobs` | PASS — exact schema/index/explain; role status local-only/unrequested |
| `npm run contract:validate` | PASS — 54 operations / 0 remote refs |
| `npm run contract:test -- source-check ingestion-jobs cron` | PASS — 17 source fixtures / 18 Step 4 fixtures |
| `npm run lint`; `npm run build`; `git diff --check` | PASS — final rerun after implementation/documentation update |

Không dùng Atlas hoặc `.env`. Mongo evidence chỉ dùng replica-set disposable loopback; production role evidence vẫn unverified theo scope.

## Final-gate remediation

| Finding | Regression/implementation evidence | Result |
|---|---|---|
| 1. Internal route alias | `test/security/jobs-http.test.js`; ingress rejects undocumented `/api/internal/**` before router dispatch | PASS — HEAD, trailing slash và unknown path không gọi runner |
| 2. Real stream + deadline | `test/security/ssrf/safe-fetch.test.js`; `safe-fetch.js` normalizes Node response stream và uses one deadline | PASS — Node-shaped stream, early destroy, slow drip |
| 3. Mongo quota admission | `test/unit/jobs/step4-final-gate.red.test.js`; shared `rate-limit-admission.js` injected into job/source services | PASS — manual 20/21, source technical-check 10/11 |
| 4–5. Authoritative fence + source policy | `test/unit/jobs/ingestion-queue.test.js`, `test/integration/jobs-leases.mongo.test.js` | PASS — executor cannot choose completion clock; policy mismatch terminalizes safely without checkpoint/counters |
| 6–7. Cron intent + linked retry | `test/integration/jobs-leases.mongo.test.js`; bounded daily materialization and parent/attempt unique identity | PASS — duplicate cron converges; concurrent retries yield one child |
| 8. Retention/index hardening | `scripts/migrations/durable-jobs.js`, `assertDurableJobsReady`, `test/integration/jobs-leases.mongo.test.js` | PASS — retention validator and unexpected lease TTL rejection |
| 9–11. Jobs/source UI | `test/client/jobs-panel.test.js`, `test/client/request-sequence.test.js`, `test/client/source-registry.test.js` | PASS — intent key reuse, source selector, request-order guard, CSRF/429 messages |

Final remediation verification used a fresh local replica-set disposable database, not Atlas and not `.env`:

- `npm test -- --run jobs safe-fetch` — PASS, 97 pass / 12 skipped (Mongo suites intentionally uninjected).
- `npm run test:integration -- jobs leases cron` — PASS, 8 files / 37 tests.
- Direct clean-env migration/verification — PASS: auth-core 31, sources 9, durable-jobs 14 operations; durable/source/auth verification passed.
- `npm run test:security -- ssrf`, `npm run contract:validate`, `npm run contract:test -- source-check ingestion-jobs cron`, `npm run lint`, `npm run build`, `git diff --check` — PASS.

## Final two-blocker closure — bounded cron continuation and semantic index drift

### RED evidence

- `npm test -- --run test/unit/jobs/bootstrap.test.js` — 5 tests, 3 passed/2 failed: the production cron adapter called materialization once despite `hasMore=true`, and accepted an unexpected `partialFilterExpression` on `ingestion_actor_idempotency_unique`.
- Disposable replica-set `test/integration/jobs-migration.mongo.test.js` — 4 tests, 3 passed/1 failed: `db:verify durable-jobs` returned success for the injected unexpected partial filter.
- Disposable replica-set production HTTP regression (`test/integration/jobs-leases.mongo.test.js -t "production cron HTTP"`) — 1 failed: `/api/internal/cron/due-work` created 100 instead of 101 cron jobs.

### GREEN implementation and regression mapping

| Finding | Implementation | Regression | Result |
|---|---|---|---|
| Cron starves source 101+ | `server/bootstrap/jobs.js` bounded continuation loop (100-source pages, explicit page cap and deadline) | `test/unit/jobs/bootstrap.test.js`; `test/integration/jobs-leases.mongo.test.js` production cron HTTP path | PASS — one protected HTTP invocation materializes all 101 sources; never-ending continuation stops at configured cap |
| Semantic index option drift | `server/repositories/mongo/index-contract.js`; exact two-way semantic-option comparison wired into jobs/auth/source bootstrap and `scripts/db-verify.js` | bootstrap partial-filter unit kill-test; disposable Mongo index-drift verifier test | PASS — unexpected `partialFilterExpression` and other tracked semantic option mismatches fail closed |

### Verification for this round

| Command | Result |
|---|---|
| `npm test -- --run test/unit/jobs test/security/jobs-http.test.js test/security/ssrf test/integration/jobs-leases.mongo.test.js test/integration/jobs-migration.mongo.test.js` | PASS — 15 files, 115/115 tests |
| `npm test -- --run jobs safe-fetch` | PASS — 15 files, 107 passed; 2 files/18 tests skipped because their Mongo suites require injected integration URI |
| `npm run test:integration -- jobs leases cron` | PASS — 8 files, 43/43 tests on disposable replica set |
| `npm test -- --run` | PASS — 59 files, 346/346 tests on disposable replica set |
| Direct `node scripts/db-migrate.js --to auth-core/sources/durable-jobs` | PASS — 31 / 9 / 17 operations on disposable database |
| Direct `node scripts/db-verify.js auth-core`, `sources`, `durable-jobs` | PASS — exact validators/indexes/explain; auth role status remains local-only/unverified |
| `npm run contract:validate` | PASS — 54 operations, 0 remote refs |
| `npm run contract:test -- source-check ingestion-jobs cron` | PASS — 54 artifacts; 17 admin-source and 18 Step 4 runtime fixtures |
| `npm run lint` | PASS |
| `npm run build` | PASS — Vite production build |
| `git diff --check` | PASS |

Lần gọi integration kết hợp đầu tiên có một lỗi response idempotency tạm thời ở Step 3 `source-flow`; lần chạy isolated và lần chạy đầy đủ sau đó đều pass. Database disposable dùng cho migration/verification trực tiếp đã được drop sau khi kiểm tra. Không sử dụng Atlas, `.env`, Step 5, commit, push, PR hoặc deployment.
