# TDD evidence — user/public flow fixes

## Phạm vi

Các user journey được suy ra từ yêu cầu user-flow-fixes:

- Là người đọc, tôi muốn Donate QR tải được dưới CSP chặt để có thể quét mã mà không mở rộng quyền tải ảnh.
- Là người đọc, tôi muốn một lần submit tìm kiếm chỉ tạo một GET và kết quả mới không bị request cũ ghi đè.
- Là người đọc, tôi muốn Feed có lựa chọn nguồn và bộ lọc ngày kết thúc trên Search.
- Là người dùng Q&A, tôi muốn câu hỏi quá ngắn giữ nguyên trong composer và báo lỗi rõ ràng.
- Là người dùng, tôi muốn dialog công khai có focus ban đầu, vòng Tab, Escape và trả focus về nút mở.
- Là người đọc, tôi muốn thử lại khi tải article lỗi và không mất cache sau retry thành công.
- Là người dùng Q&A, tôi muốn phạm vi article theo URL được đồng bộ, reset an toàn khi đổi article và xóa cả URL khi bỏ chọn.
- Là người dùng, tôi muốn lỗi save/unsave/clear được thông báo, retry/dismiss được, và kết quả hiện tại không bị thay thế.
- Là người dùng Q&A, tôi muốn citation lịch sử giữ nhãn nguồn hợp lệ kể cả khi nguồn hiện tại đổi tên, nhưng không lộ metadata sau redaction.

## RED/GREEN evidence

| Hành vi | RED | GREEN | Test |
|---|---|---|---|
| Donate CSP Express | `npm test -- --run test/security/media/csp.test.js`: 4 test, 3 fail khi tạm khôi phục assembly baseline (fixed host vắng) | Cùng lệnh: 1 file, 4 test pass | `test/security/media/csp.test.js` |
| Donate CSP static Vercel | `npm test -- --run test/security/media/vercel-static-csp.test.js`: 3 test, 2 fail vì chưa có rule | Cùng lệnh: 1 file, 3 test pass | `test/security/media/vercel-static-csp.test.js` |
| CSP HTTP fixture | `npm test -- --run test/integration/content/content-http.test.js`: 1 assertion fail vì expected policy cũ | Cùng lệnh: 1 file, 4 test pass | `test/integration/content/content-http.test.js` |
| Q&A article route đổi | `npm test -- --run test/ui/public/public-integration-flow-regressions.test.js`: 13 test, 1 fail (state `loading` thay vì `empty`) | Cùng lệnh: 1 file, 13 test pass | `test/ui/public/public-integration-flow-regressions.test.js` |
| Q&A bỏ scope đồng bộ URL | Cùng file: 14 test, 1 fail (không gọi `onNavigate('qa')`) | Cùng file: 1 file, 14 test pass; adjacent 3 file/29 test pass | `test/ui/public/public-integration-flow-regressions.test.js` |
| Search request race | Cùng file: 16 test, 2 fail (A ghi đè B; re-entry trả error) | Cùng lệnh: 1 file, 16 test pass | `test/ui/public/public-integration-flow-regressions.test.js` |
| Search URL-clear invalidation | Regression deferred mới ban đầu cho thấy kết quả cũ vẫn làm trạng thái thành `ready` thay vì `initial`; sau khi vô hiệu hóa bằng `requestSequence` | `npm test -- --run test/ui/public/public-integration-flow-regressions.test.js -t "pending search repopulate"` — 1 test pass | `test/ui/public/public-integration-flow-regressions.test.js` |
| Citation source label replay | `npm test -- --run test/unit/chat/citation-redaction.test.js`: 1 test fail (nhãn nguồn hiện tại ghi đè nhãn lịch sử) | `npm test -- --run test/unit/chat/citation-redaction.test.js test/unit/repositories/chat-repository-coverage.test.js`: 2 file, 17 test pass | citation tests |
| Dialog focus/Escape | `npm exec vitest run test/ui/qa/dialog-focus.test.js`: 5 test, 2 fail (Tab ngoài dialog và thiếu document binding) | Cùng lệnh: 1 file, 5 test pass | `test/ui/qa/dialog-focus.test.js` |

## Focused verification

- `npm test -- --run test/ui/public/public-integration-flow-regressions.test.js test/ui/public/user-flow-fixes.test.js test/ui/qa/dialog-focus.test.js test/security/media/csp.test.js test/security/media/vercel-static-csp.test.js test/integration/content/content-http.test.js test/unit/chat/citation-redaction.test.js test/unit/repositories/chat-repository-coverage.test.js test/client/public-integration-coverage.test.js test/client/qa-article-scope.test.js test/client/qa-session-lifecycle.test.js test/unit/qa/grounded-answer.test.js` — 12 file, 90 test pass after pending-search invalidation.
- `npm test -- --run test/ui/public` — 9 file, 68 test pass (also run by integration race owner).
- Focused integration coverage: `npm test -- --run --coverage --coverage.include=client/app/integration/use-public-integration.js test/ui/public/public-integration-flow-regressions.test.js test/client/public-integration-coverage.test.js test/client/qa-article-scope.test.js test/client/qa-session-lifecycle.test.js` — 4 file, 39 test pass; use-public-integration.js: 92.43% statements, 77.97% branches, 92.53% functions, 95.32% lines.
- Combined focused coverage was also run and passed tests but failed the repository global threshold because only the focused subset was selected: 41.31% statements, 31.35% branches, 40.69% functions, 46.26% lines. Project-wide suite was intentionally not run under the bounded lane rule.

## Contract verification

- `npm run contract:validate` — OpenAPI 3.1 valid, 60 operations, 0 remote refs.
- `npm run contract:generate` — Generated 60 operations into `shared/generated/`.
- `npm run contract:test` — Contract artifacts valid; health/auth/admin/content/indexing/chat/answers/governance fixtures validated.
- `HistoricalCitationAvailable.sourceName` is optional with `minLength: 1`, `maxLength: 120`; `shared/generated/api-schema.js` was regenerated by the command above. `shared/generated/api-client.js` has no functional diff.

## Browser/API smoke

- Dev lane was started through hub as `user-flow-fixes-dev` on port `3012` with `node --env-file-if-exists=.env server/dev.js` and stopped through hub after verification.
- Browser observed local `/donate` response status `304` and CSP exactly `base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://img.vietqr.io`; screenshot showed the unauthenticated public landing surface.
- Browser API smoke observed `GET /api/v1/health` status `200` with `Cache-Control: no-store, private`; unauthenticated `GET /api/v1/articles` status `401`.
- Runtime user mutation smoke was blocked safely: runtime `E2E_USER_EMAIL`/`E2E_USER_PASSWORD` were loaded without printing, but `POST /api/v1/auth/login` returned `503` (`Authentication service is not configured`). No registration, save/unsave, Q&A delete, preference mutation, payment, or account deletion was attempted. Therefore no mutation or rollback claim is made.

## Review status

- Initial independent React/a11y review: APPROVE; medium residual noted that custom dialogs do not inert/scroll-lock the background, outside the requested focus/Escape behavior.
- Initial security review: APPROVE; no security findings.
- Initial code review identified and was followed by RED/GREEN fixes for URL clearing, search request recency, article cache reuse, and pending-search clean-URL invalidation. The final code-review child could not re-run after the last one-line fix because child tool calls were suspended; the direct regression and adjacent focused suite pass are recorded above. Final React review child was cancelled and final security review child failed due unavailable model credits; initial independent React/security approvals remain factual and the final post-fix review gap is disclosed.

## Known bounded gaps

- No project-wide suite, formatter, or lint was run.
- Browser could not reach authenticated user screens or reversible mutations because the configured local authentication service returned 503; this is an environment blocker, not a claimed pass.
- Scoped Q&A route intentionally clears global session summaries on article changes; it does not repopulate unscoped history because the current list endpoint is not article-scope aware. The stale route state is prevented and a plain `/qa` navigation is canonicalized when the user clears the article scope.
