# TDD: Rich summary, trusted connector payload va media

## Phạm vi

- Summary ngắn cho feed và summary nhiều đoạn cho trang chi tiết.
- Prompt injection guard với delimiter và schema output.
- Exact source key cho payload trusted (bao gồm key demo của seed runtime); Q&A vẫn tuân theo evidence eligibility.
- Media HTTPS allowlist, remote image preview và video link-only.
- Migration/backfill `summary-detail-v1` và các đường lifecycle/recovery.

## RED

Đã bổ sung test thất bại trước khi sửa production cho normalization rich defaults, lifecycle cleanup, policy exact-source exception, Q&A evidence fence và indexing lease recovery.

## GREEN

- `npm test -- --run test/unit/articles/normalization.test.js test/unit/articles/lifecycle.test.js test/unit/ai/policy-input.test.js test/unit/qa/qna-fence-regressions.test.js test/unit/indexing/repository.test.js` — 5 files, 36 tests pass.
- `npm test -- --run test/unit/governance/takedown-repository.test.js test/integration/indexing/artifact-commit.test.js test/integration/articles/repository.test.js test/integration/chat/qa-evidence-fence.mongo.test.js test/unit/ai/policy-input.test.js test/unit/qa/qna-fence-regressions.test.js` — 5 files pass, 1 integration file skipped by Mongo gate; 60 tests pass, 2 skipped.
- `npm test -- --run test/unit/migrations/summary-detail-v1.test.js` — 5 tests pass.
- `npm run lint -- --quiet` — pass.
- `npm run build` — pass.
- `npm run contract:validate`, `npm run contract:generate`, `npm run contract:test` — pass; 56 operations.
- `npm run db:migrate:dry-run -- --to summary-detail-v1 --writers-paused` — 3 operations.
- `npm run db:migrate -- --to summary-detail-v1 --writers-paused` — applied 3 operations.
- `npm run db:verify -- summary-detail-v1 --require-role` — `verified:true`, `roleStatus:verified`.
- `git diff --check` — pass; chỉ có cảnh báo chuyển đổi LF/CRLF của Git, không có whitespace error.
- `npm test -- --run` — 198 files pass, 18 files skipped; 1.209 tests pass, 70 skipped.
- `npm test -- --run test/unit/ai/policy-input.test.js` — 1 file, 6 tests pass (canonical và demo source key matrix).
- `npm test -- --run test/ui/public/richer-summary-media.test.js test/ui/admin/source-media-policy.test.js test/security/media test/unit/connectors test/unit/migrations/summary-detail-v1.test.js` — 5 files, 19 tests pass.
- Review độc lập bằng sol — không phát hiện CRITICAL/HIGH; xác nhận migration paused-only, trusted-source matrix, Q&A `sourceKey` fence, lifecycle cleanup và media fail-closed.

## Còn cần verify trước khi merge

- `npm run smoke:deepseek:v4-flash` đã được thử qua `.env` nhưng dừng an toàn ở stage configuration (`deepseek_credential_unavailable`) vì `LLM_PRIMARY_API_KEY_ENV` đang trỏ đến `DEEPSEEK_API_KEY` chưa có giá trị trong môi trường hiện tại; không in secret hoặc raw payload.
- Chạy browser E2E trên local sau khi schema attestation và migration đã pass.
