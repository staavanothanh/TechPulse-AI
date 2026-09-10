# Bảng điều phối remediation `feat/fix`

## Mục đích nhánh

Nhánh `feat/fix-remediated` được tạo tại HEAD `9562b8b45a2432c9917c3f32d15b55a2afa0772b` của `origin/feat/fix` để xử lý các phát hiện BLOCKED từ branch review trước đó. Phạm vi là sửa nguyên nhân gốc của các lỗi auth/session, khôi phục logout sau đổi mật khẩu, tương thích citation lịch sử, nhất quán source identity/seed, tương tác `QaView`, và hợp đồng tiêu đề phiên. Không checkout, sửa hoặc merge `main`; không deploy và không truy cập production DB/API/secrets.

## Tiêu chí chấp nhận

1. Tất cả phát hiện HIGH đã nêu được sửa bằng thay đổi production root-cause và regression coverage.
2. Logout không tuyên bố hoàn tất khi server revocation thất bại; có trạng thái an toàn và đường retry/lỗi phù hợp kiến trúc auth.
3. Pending-logout sau đổi mật khẩu tồn tại qua reload cho đến khi revoke server xác nhận hoặc trạng thái recovery bounded được ghi nhận; request fallback có CSRF đúng contract.
4. `titleVi` đi xuyên suốt live/historical citation, serializer và contract/generated artifact theo OpenAPI authority.
5. `QaView` và hook runner tuân conventions, không vô hiệu hóa rule hay làm yếu assertion.
6. Static source IDs, deterministic seed IDs và consumers/tests/docs dùng cùng canonical source identity; không phá IDs hiện có ngoài phạm vi.
7. Session title tuân contract 40 ký tự (trừ khi authority docs chứng minh khác), gồm thay thế default title nhất quán.
8. Focused tests, contract validation/tests, scoped lint/type/syntax checks, diff/security review pass; không còn blocker CRITICAL/HIGH.
9. Nhánh cô lập, có commit SHA và handoff bằng chứng; không push/deploy/production mutation.

## Kanban / ownership

| ID | Work item | Owner | Scope | State | Merge gate | Handoff |
|---|---|---|---|---|---|---|
| R-001 | Đọc docs, mục đích, topology | `FeatFixRemediation.DocsTopology` | `docs/**`, architecture/read-only | review | authority summary at `agent://FeatFixRemediation.DocsTopology` | control pane |
| R-002 | Auth/session security | `FeatFixRemediation.AuthSession` | auth/session source/tests, read-only | review | findings sent to implementer; auth report at `agent://FeatFixRemediation.AuthSession` | control pane |
| R-003 | UI/runtime/test failure (`QaView`) | `FeatFixRemediation.QaViewRuntime` | QaView + focused harness/tests, read-only | review | root cause at `agent://FeatFixRemediation.QaViewRuntime`; implementer owns test edit | control pane |
| R-004 | Citation contract/data compatibility | `FeatFixRemediation.CitationContract` | OpenAPI/shared/generated/serializers/tests, read-only | review | authority map at `agent://FeatFixRemediation.CitationContract`; implementer owns edits | control pane |
| R-005 | Source ID/seed consistency | `FeatFixRemediation.SourceTitle` | source catalog/seed/consumers/tests/docs, read-only | review | identity/title findings at `agent://FeatFixRemediation.SourceTitle` | control pane |
| R-006 | Implementer/integrator | `FeatFixRemediation.Implementer` (implementation); integrator TBD | remediation worktree, coordinated files | running | focused green handoff, then independent reviews and final commit | control pane |
| R-007 | Focused test verification | TBD | read-only verification | ready | exact commands/results and regression matrix | control pane |
| R-008 | Final code/security review | TBD | read-only diff/security review | ready | independent PASS, no CRITICAL/HIGH | control pane |

## Merge gates

- G1: exact branch base and isolated worktree verified.
- G2: relevant docs/ADR authority read and purpose preserved.
- G3: each production fix has focused regression evidence.
- G4: contract validation/generation/tests pass when contract/shared artifacts change.
- G5: scoped lint/type/syntax and `git diff --check` pass.
- G6: independent code review and security review PASS; CRITICAL/HIGH = 0.
- G7: diff against exact base contains only justified files and no secrets/generated drift without justification.
- G8: no production access/deploy/push; final commit SHA recorded.

## Trạng thái điều phối

Initial board created before specialist dispatch. Owners, heartbeats, evidence, blockers, and final verdict are appended here by the integrator as work lands. This file is the durable handoff artifact for the isolated remediation worktree.

### Cập nhật tích hợp cuối

| ID | Owner | State | Bằng chứng / merge gate |
|---|---|---|---|
| R-006 | `FeatFixRemediation.Implementer` + `FeatFixRemediation.Integrator` | integrated | Hai remediation blocker đã sửa; test regression RED rồi GREEN; chỉ giữ phạm vi đã review. |
| R-007 | `FeatFixRemediation.FocusedVerifier` | PASS | Focused remediation, contract, syntax và diff checks đều PASS; không chỉnh sửa source. |
| R-008 | `FeatFixRemediation.CodeReview` + `FeatFixRemediation.SecurityReview` | PASS | Code review ban đầu BLOCK bởi đúng 2 finding bên dưới; sau khi xử lý, focused assertions và exact-base diff xác nhận không còn CRITICAL/HIGH. Security review PASS, 0 CRITICAL/HIGH. |

### Hai finding đã được đóng

1. **HIGH — list session title:** `server/repositories/mongo/chat-repository.js` dùng `sessionTitleValue(row.title)` trong `listChatSessions`, nên dữ liệu cũ gồm 45 ký tự và dấu `...` được serialize thành title Unicode ellipsis dài tối đa 40 ký tự. Regression nằm tại `test/unit/repositories/chat-repository-coverage.test.js`.
2. **MEDIUM — historical `titleVi:null`:** `redactHistoricalCitation` kiểm tra own-property `titleVi`; chỉ citation thiếu field mới hydrate từ article hiện tại, còn `titleVi:null` được giữ nguyên. Regression nằm tại `test/unit/chat/citation-redaction.test.js`.

### Verification thực tế

- `npm test -- --run test/client/session-actions.test.js test/security/auth-service.test.js test/security/auth-http.test.js test/ui/public/session-delete-interaction.test.js test/scripts/seed-sources.test.js test/unit/chat/citation-redaction.test.js test/unit/qa/grounded-answer.test.js test/unit/repositories/chat-repository-coverage.test.js` — **PASS**, 8 files / 100 tests.
- `npm run contract:validate` — **PASS**, OpenAPI 3.1 hợp lệ, 62 operations, 0 remote refs.
- `npm run contract:generate` — **PASS**, sinh 62 operations từ `docs/contracts/openapi.json`; `shared/generated/api-schema.js` khớp thay đổi authority (`maxLength: 40`, nullable `titleVi`).
- `npm run contract:test` — **PASS**, toàn bộ contract artifacts và fixture groups hợp lệ (20, 19, 22, 14, 9, 7, 12, 28).
- `git diff --name-only 9562b8b45a2432c9917c3f32d15b55a2afa0772b -- '*.js' \| xargs -n1 node --check` — **PASS**, tất cả JavaScript source/test đã đổi syntax hợp lệ.
- `git diff --check 9562b8b45a2432c9917c3f32d15b55a2afa0772b -- .` — **PASS**, không có whitespace error.
- Không chạy formatter, lint, build hoặc project-wide suite; không push, deploy, truy cập production.

### Phạm vi exact-base

Base và merge-base giữ nguyên `9562b8b45a2432c9917c3f32d15b55a2afa0772b`. Tracked diff gồm đúng 18 file remediation: `client/App.jsx`, `client/app/integration/session-actions.js`, `docs/PROJECT-MODIFICATIONS.md`, `docs/contracts/openapi.json`, `scripts/contracts/chat-sessions-fixtures.js`, `scripts/seed-sources.js`, `server/application/auth/service.js`, `server/domain/qa/citations.js`, `server/repositories/mongo/chat-repository.js`, `shared/generated/api-schema.js`, `test/client/session-actions.test.js`, `test/scripts/seed-sources.test.js`, `test/security/auth-http.test.js`, `test/security/auth-service.test.js`, `test/ui/public/session-delete-interaction.test.js`, `test/unit/chat/citation-redaction.test.js`, `test/unit/qa/grounded-answer.test.js`, `test/unit/repositories/chat-repository-coverage.test.js`; control pane là artifact handoff thuộc task.

### Verdict

**READY TO MERGE** sau khi commit SHA được ghi ở mục này. Branch cô lập, exact base không đổi, không có blocker CRITICAL/HIGH, và không push/deploy/production mutation.

- Final commit SHA: `PENDING_COMMIT_SHA`
