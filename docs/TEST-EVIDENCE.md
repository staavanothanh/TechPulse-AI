# Bằng chứng kiểm thử

File này ghi lại các command và kết quả đã quan sát trên checkout hiện tại. Entry
đang pending không phải là bằng chứng release.

## Preflight recovery hậu MVP — 2026-08-17

Phạm vi: chỉ preflight local, không network cho restore plan. Lane này không phải
MVP release gate. Không có mutation Atlas hoặc Vercel nào được cấp quyền hay thực
hiện trong lane này.

| Yêu cầu | Bằng chứng | Kết quả |
| --- | --- | --- |
| Restore target không được là `techpulse_app` live | `test/restore/restore-plan.test.js` | PASS |
| App restore không được overwrite `techpulse_governance` | `test/restore/restore-plan.test.js` | PASS |
| Rehearsal target vẫn isolated và không serving | `test/restore/restore-plan.test.js` | PASS |
| Backup retention lớn hơn zero và tối đa bảy ngày | `test/restore/restore-plan.test.js` | PASS |
| Dump và sidecar inventory yêu cầu private encrypted storage bên ngoài và digest SHA-256 | `test/restore/restore-plan.test.js` | PASS |
| Plan từ chối field chứa secret | `test/restore/restore-plan.test.js` | PASS |
| Plan từ chối secret key alias phổ biến và value chứa credential/secret-like | `test/restore/restore-plan.test.js` | PASS |
| Storage reference là opaque reference chính xác, bind với backup ID hiện tại | `test/restore/restore-plan.test.js` | PASS |
| Plan hợp lệ local không claim verified restore hoặc mở serving gate | `test/restore/restore-plan.test.js` | PASS |

Command đã quan sát:

```text
npm test -- --run test/restore/restore-plan.test.js
Test Files  1 passed (1)
Tests       25 passed (25)

npx eslint scripts/verify-restore-plan.js test/restore/restore-plan.test.js
Exit code: 0

git diff --check
Exit code: 0 (line-ending warnings only for concurrent Step 12 files)
```

Lần TDD đầu fail vì `scripts/verify-restore-plan.js` chưa tồn tại. Implementation
đầu tiên làm 8 restore-plan test pass. P1 hardening sau đó thêm 17 case fail cho
secret alias, value chứa credential và storage reference; implementation đã harden
làm cả 25 test pass.

## Gate ứng dụng MVP Step 12 — 2026-08-17

| Command | Kết quả đã quan sát |
| --- | --- |
| `npm test -- --run` | 167 files pass, 1004 tests pass; 16 files/66 tests skip theo external gate rõ ràng |
| `npm run test:integration` | 24 files/82 tests pass; 14 files/57 tests skip theo external gate rõ ràng |
| `npm run test:security` | 12 files/76 tests pass |
| `npm run test:ui` | 12 files/100 tests pass |
| `npm run contract:validate` | 55 operations hợp lệ |
| `npm run contract:test` | Tất cả contract/runtime fixture group pass |
| `npm run lint` | PASS sau khi ignore local tool directory đã gitignore |
| `npm run build` | PASS |
| `npm run test:e2e` | PASS, 5 tests; 9 test external/local-host skip theo gate rõ ràng |
| `npm run test:e2e:local` | FAIL trong các lần chạy gần nhất: server health pass trên `localhost:3000`, nhưng login nhận `429 rate_limit_exceeded` sau khi retry lặp lại làm đầy login bucket 15 phút; governance run có 4 pass/2 fail, non-mutation rerun có 1 pass/3 fail/2 skip; không commit deletion/takedown mutation |
| `npm run test:e2e:vercel` | PASS, 3/3 Preview health/cron authentication test |
| `node --env-file-if-exists=.env scripts/step9-real-provider-smoke.js --summary-only` | PASS, 1 outbound request thật qua summary route `zen` được cấu hình trước Gemini (bằng chứng lịch sử) |
| `node --env-file-if-exists=.env scripts/step9-real-provider-smoke.js --embedding-only` | PASS, 1 OpenRouter request thật, 18 vector x 1024 dimensions, top-5 rate 1 |
| `npm run eval:retrieval` | PASS, 6/6 top-5 hit; thấp hơn target 30+ dataset của Step 12 |
| `npm run eval:groundedness` | PASS, 31/31 case; deterministic in-memory provider fixture |
| `npm run eval:citations` | PASS, 31/31 case; deterministic in-memory provider fixture |
| `npm run db:verify -- provider-routing-v2 --require-role` | `verified: true`, 5 collection, role verified |
| `npm run seed:demo` | PASS dry-run; 3 live connector, 44 accepted article, 15 audit, 3 manifest |
| `npm run seed:demo -- --apply` | PASS sau exact demo reset được owner cấp quyền; 3 live source, 44 accepted article bind manifest, 15 lifecycle audit và 3 manifest commit atomically |
| `npm run verify:demo` | PASS; 3/3 source, 44 manifest-bound published article (ít nhất 5 mỗi source), 15/15 lifecycle audit và 3/3 manifest verified |

Preview API/Cron smoke cũng được quan sát qua `npm run test:e2e:vercel`: health
`200`, machine bearer thiếu/không hợp lệ `401`, bearer hợp lệ `202`. Direct browser-
style Preview E2E nằm ngoài API/Cron gate này và cần protected Preview browser path
đã cấu hình.

## Migration LLM Gemini — 2026-08-21

| Gate | Bằng chứng | Kết quả |
| --- | --- | --- |
| Gemini endpoint profile và Bearer/structured-output boundary | `test/unit/ai/gemini-provider-adapter.test.js` | PASS, 8 tests |
| Provider graph trỏ summary và cả hai Q&A workload về Gemini, vẫn giữ OpenRouter/BGE-M3 embedding | `test/unit/ai/gemini-provider-graph.test.js` | PASS, 2 tests |
| Synthetic summary, answer và support smoke với model fallback và closed-schema failure | `test/unit/ai/gemini-llm-smoke.test.js` | PASS, 6 tests |
| Live Gemini request dùng credential environment do owner cung cấp | `npm run smoke:gemini -- full` | PASS, 3 outbound request; summary, answer và support đều dùng `gemini-2.5-flash`, không fallback; không có embedding call |

Synthetic gate không chứng minh Google project có evidence `zdr-verified` hiện hành.
Tài khoản Google Pro tự nó không bảo đảm rate-limit window hiện tại của API model;
live gate phải quan sát response của project đã cấu hình. Quota là thuộc tính
capacity/billing, không phải bằng chứng privacy-retention; Q&A vẫn fail-closed cho
đến khi evidence được review và còn hạn.

## Migration LLM DeepSeek V4 Flash — 2026-08-23

| Gate | Bằng chứng | Kết quả |
| --- | --- | --- |
| Focused provider/Q&A/indexing/runtime suite | `npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/ai/provider-registry-config.test.js test/unit/ai/provider-router.test.js test/unit/ai/provider-admission-router-boundary.test.js test/unit/qa/bootstrap.test.js test/unit/qa/grounded-answer.test.js test/unit/qa/service.test.js test/unit/qa/retrieval-contract.test.js test/unit/indexing/artifact-processor.test.js test/config/runtime.test.js` | PASS, 10 files/129 tests |
| Q&A HTTP, answer lifecycle và indexing text fallback integration | `npm test -- --run test/integration/qa-http.test.js test/integration/answers.test.js test/integration/indexing/text-fallback.test.js` | PASS, 3 files/11 tests |
| Scoped coverage cho provider/Q&A boundary đã đổi | Vitest coverage command ghi trong `docs/testing/deepseek-v4-flash-provider.tdd.md` | PASS, 141 tests; statements 86.27%, branches 84.41%, functions 93.20%, lines 96.18% |
| Security suite | `npm run test:security` | PASS, 12 files/77 tests |
| Contract fixture | `npm run contract:test` | PASS, 56 operations và toàn bộ runtime fixture group |
| Lint/build | `npm run lint`; `npm run build` | PASS |
| Live DeepSeek summary, answer và support với synthetic input | `Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue; node --env-file-if-exists=.env scripts/deepseek-v4-flash-smoke.js full` | PASS, 3 outbound request; tất cả dùng provider `deepseek`, model `deepseek-v4-flash`, một external attempt và không fallback; answer/support policy eligible |

ADR-0016 thay thế quyết định Gemini deployment cho LLM traffic hiện tại. Q&A dùng
capability `nonconfidential` được owner phê duyệt; sensitive-input, Source Registry,
citation/support, idempotency và lifecycle gate vẫn hoạt động. Query embedding vẫn
chỉ `zdr-verified`, vì vậy OpenRouter/BGE-M3 hiện tại không nhận raw question và Q&A
retrieval dùng keyword fallback. Article embedding vẫn dùng OpenRouter/BGE-M3 với
compatibility identity `bge-m3-v1-1024`.

## Bằng chứng recovery hậu MVP

| Recovery gate | Trạng thái | Authority hoặc implementation còn thiếu |
| --- | --- | --- |
| Read-only `techpulse_app` dump inventory | PENDING | Atlas owner, backup identity read-only riêng và MongoDB Database Tools |
| Encrypted private storage và destruction record | PENDING | Storage owner và artifact lifecycle có giới hạn thời gian |
| Signed read-only `techpulse_governance` sidecar | PENDING | Offline checkpoint HMAC key chỉ owner và signer/exporter đã review |
| Ordered audit/checkpoint/suppression verification | PENDING | `scripts/verify-audit-integrity.*`, offline verify-only key và Atlas data |
| Isolated pre-deletion/takedown restore | PENDING | Atlas owner/operator và target `techpulse_app_restore_*` được phê duyệt |
| Whole-Atlas-loss sidecar-first rehearsal | PENDING | Atlas recovery target, owner credential và sidecar continuity đã verify |
| Restored sessions/quota/answer/provider reservation cleanup | PENDING | Restore-only mutation credential và reconciliation runner đã review |
| Deleted-user/takedown replay và zero-match verification | PENDING | `scripts/reconcile-restored-governance.*` và governance ledger hiện tại |
| Provider failure-domain state reconciliation | PENDING | Provider configuration version hiện tại và restore runner |
| Session/CSRF/HMAC/runtime Mongo rotation và stale credential revocation | PENDING | Atlas/Vercel project owner |
| HMAC retirement/custody rehearsal | PENDING | Successor evidence 30 ngày, zero-dependent count và offline key inventory |
| Full primary-provider outage với cross-provider fallback | PENDING | Provider độc lập đã cấu hình và external call được cấp quyền |
| MVP serving approval | PENDING | Quyết định rõ ràng của project owner sau application/deployment gate MVP |

## Diễn giải release

Local scaffold chỉ validate plan shape và destructive-target guard. Nó không chứng
minh backup recoverability, governance signature authenticity, replay correctness
hoặc safe restore promotion. Các hạng mục này cố ý được deferred sang recovery track
hậu MVP và không block MVP application gate. Local E2E retry gần nhất bị rate-limit
bởi login bucket 15 phút đã cấu hình; hãy chạy lại sau khi window hết hạn, không thay
đổi rate-limit data và không bypass admission boundary. Quyết định MVP serving vẫn
pending cho tới khi local E2E hoàn tất với disposable credential hợp lệ. MVP vẫn cần
live governance mutation/audit atomicity, runtime role evidence, provider safety và
deployment verification.
