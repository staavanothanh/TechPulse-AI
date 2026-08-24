# Transaction Q&A và evidence — bằng chứng TDD

## Phạm vi

Bản sửa này xử lý hai nhóm lỗi trong luồng Q&A:

1. MongoDB trả code `117` khi hai operation dùng cùng transaction session chạy
   đồng thời.
2. Prompt generation/support có thể vượt giới hạn input của provider và final
   write có thể tự làm thay đổi fence bằng cách ghi `updatedAt`.

HTTP contract không đổi. Không thêm provider call, không thêm dependency và
không dùng raw question/evidence trong log.

## Nguyên nhân gốc

`MongoChatRepository.assertActorFence` dùng `Promise.all` để đọc `users` và
`sessions` bằng cùng session đang có transaction. MongoDB không cho phép các
operation transaction dùng chung session chạy đồng thời. Atlas trả
`MongoServerError` code `117` (`ConflictingOperationInProgress`). Cùng rủi ro
này xuất hiện khi các scope quota được reserve trên cùng transaction session.

Evidence trước đây chọn quá nhiều record. Generation và support payload có thể
vượt 30.000 ký tự trước khi gọi provider. Finalization cũng ghi `updatedAt`
trên mọi article/source trong fence, kể cả target không được answer cite. Việc
này làm thay đổi timestamp vận hành và mở rộng contention không cần thiết.

## Tiêu chí chấp nhận

- Actor fence và quota reads chạy tuần tự trên cùng transaction session.
- Evidence chọn tối đa 6 blocks và tối đa 2 articles cho mỗi source.
- Canonical evidence text tối đa 2.100 ký tự; evidence block gồm wrapper tối đa
  2.400 ký tự.
- Generation prompt nhỏ hơn 30.000 ký tự.
- Support chỉ nhận các blocks được answer cite, tổng paragraph tối đa 10.000
  ký tự và payload JSON nhỏ hơn 30.000 ký tự.
- Final fence hash đúng bounded evidence text mà provider nhận.
- Final fence bind exact citation metadata do server hydrate; metadata đổi sau
  admission thì answer không được persist.
- Finalization chỉ lock article được cite và source duy nhất của các article đó.
- Lock ghi `qnaFenceToken` kiểu `objectId` trong transaction, không ghi
  `updatedAt` và không serialize token ra HTTP.
- Article/source đổi status, version, policy, visibility hoặc evidence text
  sau admission thì transaction conflict và không persist answer.
- Mongo infrastructure error được map thành canonical `503 service_unavailable`;
  không trả raw Mongo error hoặc nhầm thành provider refusal.
- Local-control `401/409/503` trong provider stage release admission với outcome
  `cancelled`; nó không ghi provider failure, không mở circuit và không fallback.
- Support verifier đánh dấu question/paragraph/evidence JSON là untrusted data và
  yêu cầu bỏ qua mọi embedded instruction, prompt, role hoặc verdict override.
- Half-open provider-domain probe hết hạn sau một cooldown window; stale probe
  được clear để probe mới có thể chạy.
- Migration `qa-evidence-fence` và runtime schema attestation
  `qa-evidence-fence-v1` là serving gate riêng.
- Migration tổng hợp `provider-routing-v2` và `governance` reapply fenced
  validator sau validator nền.
- Downgrade guard chặn cả target `sources` cũ sau khi provider-routing-v2 marker
  đã tồn tại.
- Q&A cold start kiểm tra exact live validator trên `articles` và `sources` sau
  khi schema attestation hợp lệ.

## Ma trận TDD

| Bảo đảm | Test | Kết quả |
| --- | --- | --- |
| Transaction session không bị dùng đồng thời | `test/unit/chat/transaction-session-serialization.test.js` | PASS |
| Generation/support giữ dưới budget và support chỉ nhận cited blocks | `test/unit/qa/evidence-budget-and-fence.test.js` | PASS |
| Mongo error code 117 ở reserve/append map thành 503 | `test/unit/qa/infrastructure-error-mapping.test.js` | PASS |
| Chỉ cited targets nhận `qnaFenceToken`; serializer không lộ token; timestamp không bị chạm | `test/unit/qa/qna-fence-regressions.test.js` | PASS |
| Validator, collMod plan, CLI target và runtime readiness được nối đúng | `test/unit/migrations/qa-evidence-fence.test.js` | PASS |
| Local-control interruption release `cancelled` và không poison provider circuit | provider router/admission boundary tests | PASS |
| Support verifier explicit untrusted-data instruction và migration downgrade guard | provider adapter + routing persistence tests | PASS |
| Half-open stale probe hết hạn và circuit có thể recover | provider failure-domain persistence tests | PASS |
| Cold start fail closed nếu live article/source validator mất fence | Q&A bootstrap/readiness tests | PASS |

## Checkpoint RED

Orchestrator ghi nhận RED trước GREEN trong cùng scope:

- transaction session tests fail vì `Promise.all` tạo overlap và synthetic Mongo
  code `117`;
- generation payload đạt khoảng `40.310` ký tự và support payload khoảng
  `41.156` ký tự;
- final fence test quan sát các write `updatedAt` trên cả target không được
  cite;
- infrastructure mapping tests nhận raw Mongo error thay vì `503`;
- migration contract không import được vì `qa-evidence-fence` chưa tồn tại.

Đây là bằng chứng RED của worktree trước implementation. Không chạy lại RED sau
khi sửa.

## Kiểm chứng GREEN

Command đã chạy:

```text
npm test -- --run test/unit/chat/transaction-session-serialization.test.js test/unit/qa/evidence-budget-and-fence.test.js test/unit/qa/infrastructure-error-mapping.test.js test/unit/qa/qna-fence-regressions.test.js test/unit/migrations/qa-evidence-fence.test.js
```

Kết quả: PASS — 5 test files, 22 tests.

Broad Q&A/fence verification hiện tại:

```powershell
$qaTests = rg --files test | Where-Object { $_ -match '(qa|chat|provider-router|provider-admission|provider-routing|schema-readiness)' }
npx vitest run $qaTests
```

Kết quả: PASS — 28 test files passed, 2 test files skipped; 236 tests passed,
3 tests skipped. Các test Atlas bị skip vì process không có
`MONGODB_TEST_URI`.

Security remediation verification:

```text
npm test -- --run test/unit/ai/provider-adapters.test.js test/unit/indexing/provider-routing-persistence.test.js
```

Kết quả: PASS — 2 test files, 37 tests. Bộ test chứng minh support system
instruction coi user JSON là untrusted và downgrade guard chặn `sources` cũ.
Provider failure-domain persistence regressions trong broad run chứng minh stale
half-open probe hết hạn và probe mới có thể claim sau cooldown.

Eval và provider smoke:

```text
npm run eval:retrieval
npm run eval:groundedness
npm run eval:citations
npm run smoke:deepseek:v4-flash -- full
```

Kết quả: PASS — retrieval `6/6`, groundedness `31/31`, citations `31/31`.
DeepSeek full smoke PASS với 3 outbound operations cho summary, answer và
support. Smoke dùng input tổng hợp; command không in credential.

Migration và runtime role verification:

```text
npm run db:migrate:dry-run -- --to qa-evidence-fence
npm run db:migrate -- --to qa-evidence-fence
npm run db:verify -- qa-evidence-fence --require-role
```

Kết quả: PASS — dry-run và migration đều báo 2 operations; verification trả
`verified=true` và role gate pass.

Coverage lõi Q&A/provider:

```text
npx vitest run test/unit/qa test/unit/ai/provider-admission-router-boundary.test.js test/unit/ai/provider-router.test.js test/integration/qa-http.test.js --coverage --coverage.include=server/application/qa/** --coverage.include=server/domain/qa/** --coverage.include=server/ai/provider-admission.js --coverage.include=server/ai/provider-router.js
```

Kết quả: PASS — statements `85.39%`, branches `80.14%`, functions `91.91%`,
lines `92.43%`.

Coverage mở rộng gồm toàn bộ Mongo repository liên quan chưa đạt global
threshold: statements `75.03%`, branches `72.67%`, functions `86.06%`, lines
`87.11%`. Kết quả này không được ghi nhận là coverage gate pass.

Static verification:

```text
npm run lint
npm run build
```

Kết quả: PASS.

```text
git diff --check
```

Kết quả: PASS. Git chỉ in cảnh báo line-ending cho các file JavaScript đang được
agent khác sửa; không có whitespace error.

## Runtime và migration gate

`qa-evidence-fence` dùng hai `collMod` operation forward-only cho `articles` và
`sources`. Validator vẫn giữ schema đóng, nhánh tombstone và mọi rule hiện có;
chỉ thêm field tùy chọn `qnaFenceToken: { bsonType: "objectId" }`.

`provider-routing-v2` và `governance` reapply migration này sau khi áp dụng
validator article của chính chúng. Thứ tự này ngăn migration tổng hợp làm mất
`qnaFenceToken` khỏi closed schema.

Predecessor gate cũng fail closed theo hai chiều: `qa-evidence-fence` chỉ chạy
khi exact article validator của `provider-routing-v2` và exact source validator
đã hiện diện; ngược lại, khi reapply `provider-routing-v2`, exact
`qa-evidence-fence` article successor được chấp nhận rồi fence được áp lại cuối
chuỗi. Regression TDD cho hai trường hợp này pass `29/29` tests trong hai file
migration/persistence liên quan.

Mọi `createConfiguredQaService`, gồm cả local dev, mặc định chạy live evidence
fence verifier trước khi tạo service. Production lazy runtime bổ sung signed
attestation vào cùng verifier boundary thay vì dựa vào một check chỉ có ở
deployment path.

Khi `provider-routing-v2` được reapply trên exact QA successor, cả compatibility
validator tạm thời và final validator đều giữ `qnaFenceToken`. Vì vậy bước
invalidate legacy embedding không thể làm Mongo từ chối article đang được Q&A
fence. Focused bootstrap/migration/persistence verification pass `40/40` tests.

Runtime Q&A verify thêm schema attestation riêng, cùng chat/provider readiness.
Sau attestation, cold start đọc live collection metadata và yêu cầu exact
`QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR` cùng
`QA_EVIDENCE_FENCE_SOURCE_VALIDATOR`. Role probe yêu cầu transaction session và
quyền `find/update` trên `articles` và `sources`. Migration và role verification
trên configured MongoDB đã pass như log ở trên.

Atlas full runner đã được gọi nhưng không pass trong môi trường hiện tại:

- 24 test files và 90 tests pass;
- 30 tests fail;
- 29 tests skipped;
- failure đến từ Atlas permission và DNS/network resolution của môi trường test,
  không phải bằng chứng product pass;
- isolated Q&A Atlas suite cũng skip/fail vì DNS và không được ghi nhận là pass.

Các gate sau chưa pass trong checkpoint này:

- Atlas integration runner trong một môi trường có đúng network/permission;
- browser E2E Q&A trên local hoặc Vercel;
- full test suite và full coverage gate.

Trên mọi deployment mới, nếu migration, attestation, live validator hoặc role
readiness không pass thì runtime phải fail closed với `503` và không được giả vờ
Q&A đã sẵn sàng.

## Không thay đổi

- Không thay đổi OpenAPI response shape.
- Không thay đổi provider routing hoặc capability policy.
- Không sửa ADR accepted.
- Không ghi raw source text, raw question, secret hoặc `qnaFenceToken` vào
  public serializer/log.
