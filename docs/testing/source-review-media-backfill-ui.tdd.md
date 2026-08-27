# Source review UI — TDD evidence

## Phạm vi

Worktree: `fix/source-review-media-backfill-v2`.

Phạm vi chỉ gồm luồng admin policy review ở frontend và test liên quan. Không sửa server, media worker, OpenAPI hoặc dữ liệu runtime.

## User journeys

- Admin nhận được thông báo lifecycle có mã lỗi canonical khi thao tác review gặp race.
- Admin không thể gửi policy review trực tiếp khi source đang `active` và được hướng dẫn yêu cầu re-review.
- Sau khi re-review fail-close và reload trả source về `paused`, admin có thể gửi quyết định policy review.

## RED/GREEN

| Hành vi | RED | GREEN | Bảo đảm |
| --- | --- | --- | --- |
| Giữ mã `invalid_state_transition` và không áp dụng hướng dẫn re-review cho mọi lỗi 409 | `npm test -- --run test/ui/admin/source-media-policy.test.js` — 1 test mới fail vì `safeAdminError` không nhận operation context | Cùng command — 6/6 pass | Lỗi generic 409 giữ thông báo chung và hiển thị mã; chỉ `reviewSourcePolicy` có hướng dẫn re-review |
| Chặn review trực tiếp ở source `active` | `npm test -- --run test/ui/admin/source-media-policy.test.js` — test active fail vì form chưa có guard | Cùng command — 6/6 pass | Form hiển thị hướng dẫn, khóa nút submit và chặn submit handler |
| Cho phép review sau re-review/reload | `npm test -- --run test/ui/admin/source-media-policy.test.js` — test paused fail vì form chưa phân biệt lifecycle | Cùng command — 6/6 pass | Source `paused` không bị khóa submit |

## Verification

- `npm test -- --run test/ui/admin/source-media-policy.test.js` — PASS, 1 file / 6 tests.
- `npm test -- --run test/ui/admin/source-media-policy.test.js test/ui/admin/admin-views.test.js test/ui/admin/admin-coverage.test.js test/unit/admin-data-coverage.test.js` — PASS, 4 files / 30 tests.
- `npm run test:ui` — PASS, 16 files / 86 tests.
- `npm run build` — PASS.
- `npx eslint client/features/admin/ui/AdminSourceForms.jsx client/features/admin/ui/AdminSourcesView.jsx client/features/admin/ui/admin-data.js test/ui/admin/source-media-policy.test.js --quiet` — PASS.
- `git diff --check` — PASS.

Coverage command trên bốn test file liên quan chạy được nhưng không đạt ngưỡng global vì đây là subset: statements 52.77%, branches 54.92%, functions 50%, lines 55.04%. Không chạy full suite coverage theo quy ước project.

Không tạo commit hoặc push trong worktree này.
