# Bằng chứng TDD: điều hướng Source Registry của admin

## Phạm vi

Hành trình này được rút ra từ yêu cầu người dùng; không có file plan riêng.

Với vai trò admin, tôi muốn có đích đến Source Registry dễ thấy trong dashboard
để có thể xem policy của source và trạng thái lifecycle qua màn hình Source Registry
hiện có.

## Các mốc RED/GREEN

| Giai đoạn | Commit | Bằng chứng |
|---|---|---|
| RED | `0401ca2` | Chạy `npm test -- --run test/client/app-shell.test.js` trước implementation: 3 failed, 3 passed. Failure là thiếu đích đến Source Registry trên desktop và control trên mobile. |
| GREEN | `d033d7f` | Cùng target pass: 1 file, 6 tests. |
| Refactor | `cf0812c` | Căn chỉnh style `aria-current` trên mobile theo admin navigation style hiện có; focused suite tiếp tục green. |

## Các bảo đảm

| # | Bảo đảm | Test | Loại | Kết quả |
|---|---|---|---|---|
| 1 | Admin navigation trên desktop expose `Source Registry` và đánh dấu current khi được chọn. | `test/client/app-shell.test.js` | unit | PASS |
| 2 | Chọn Source Registry button trên desktop gọi `onNavigate('sources')`. | `test/client/app-shell.test.js` | unit | PASS |
| 3 | Admin workspace trên mobile expose cả Source Registry và account control, gồm route Jobs và Sources. | `test/client/app-shell.test.js` | unit | PASS |
| 4 | Source Registry screen hiện có và các regression của admin route đã mount vẫn green. | `test/client/source-registry.test.js`, `test/ui/admin/admin-mounted.test.js` | unit/mounted | PASS |

## Kiểm chứng

Các command thực sự đã chạy trên branch:

- `npm test -- --run test/client/app-shell.test.js`: PASS, 1 file/6 tests.
- `npm test -- --run test/client/app-shell.test.js test/client/source-registry.test.js test/ui/admin/admin-mounted.test.js`: PASS, 3 files/33 tests.
- `npx eslint client/App.jsx client/styles.css test/client/app-shell.test.js`: không có error; `styles.css` được project ESLint config bỏ qua có chủ đích.
- `npm run build`: PASS, Vite build 70 modules.
- `git diff --check`: PASS.
- `npm test -- --run`: PASS, 169 files/1.013 tests; 16 files/66 tests vẫn skipped theo configuration hiện có của repository.

Command coverage đầy đủ `npm test -- --run --coverage` đã hoàn tất 169 files và
1.013 tests, báo cáo 67,09% statements, 65,44% branches, 72,13% functions và
73,98% lines; global threshold của repository (80% statements/lines/functions và
75% branches) vì thế vẫn chưa đạt ngoài phạm vi feature này. Một lần chạy coverage
trước đó cũng gặp RSS parser timeout không ổn định, nhưng full suite thông thường và
lần coverage cuối đều hoàn tất. Focused coverage command không đại diện cho global
threshold của project vì Vitest instrument toàn bộ application khi chỉ chọn hai file.

## Bằng chứng merge

Trước khi merge, chạy lại focused suite, lint, build và `git diff --check` trên branch.
Chỉ fast-forward merge sau khi các kiểm tra pass; task này không thực hiện push.
