# Bằng chứng TDD: tương thích callback Google OAuth

## Phạm vi

Hành trình được rút ra từ lỗi callback thực tế: Google trả thêm metadata trong
redirect, nhưng ingress chỉ cho phép `code` và `state`, nên trình duyệt nhận
`400 bad_request` thay vì hoàn tất đăng nhập.

- Với vai trò người dùng, tôi muốn callback Google chấp nhận metadata hợp lệ để
  đăng nhập thành công và quay về giao diện cùng origin.
- Với vai trò người dùng, tôi muốn callback từ chối quyền được xử lý an toàn mà
  không gọi token exchange, không tạo session và không làm lộ thông báo từ
  provider.
- Với hệ thống, tôi muốn callback giữ state cookie và chính sách `no-store` khi
  request không hợp lệ.

## Bằng chứng RED/GREEN

| Giai đoạn | Command | Kết quả |
|---|---|---|
| RED | `npm test -- --run test/security/google-oauth-http-fix.test.js` sau khi thêm kiểm thử metadata lỗi | 1 test failed, 8 passed; callback trả 422 thay vì 400 cho metadata không có `error`. |
| RED | Cùng target sau khi thêm kiểm thử state-cookie, URI và target quá lớn | 3 lỗi nghiệp vụ còn lại: state callback trả 303, URI không hợp lệ trả 403, target 413 thiếu `Cache-Control`. |
| GREEN | `npm test -- --run test/security/google-oauth-http-fix.test.js` | 1 file, 11 tests passed. |

## Các bảo đảm

| # | Bảo đảm | Test hoặc command | Loại | Kết quả |
|---|---|---|---|---|
| 1 | Callback thành công chấp nhận `scope`, `authuser`, `hd`, `prompt` và `iss`, chỉ chuyển `code`/`state` vào service, xóa state cookie sau khi xác minh và trả 303 về `/`. | `test/security/google-oauth-http-fix.test.js` | integration | PASS |
| 2 | Callback từ chối xác minh state trước, trả thông báo cố định, không gọi `googleLogin` và không phản hồi `error_description`/`error_uri`. | `test/security/google-oauth-http-fix.test.js` | integration/security | PASS |
| 3 | Callback không chấp nhận đồng thời `code` và `error`, không chấp nhận metadata lỗi nếu thiếu `error`, và không chấp nhận query trùng hoặc không nằm trong allowlist. | `test/security/google-oauth-http-fix.test.js` | integration/security | PASS |
| 4 | State cookie không bị xóa khi state callback không hợp lệ; callback luôn có `Cache-Control: no-store, private`, kể cả khi request target vượt giới hạn. | `test/security/google-oauth-http-fix.test.js` | security | PASS |
| 5 | `error_uri` phải là URI tuyệt đối; contract và generated schema đồng bộ với allowlist callback. | `test/security/google-oauth-http-fix.test.js`, `npm run contract:validate`, `npm run contract:generate`, `npm run contract:test` | contract/security | PASS |

## Thay đổi chính

- `docs/contracts/openapi.json`: khai báo metadata success/error của Google và
  làm `code` optional để biểu diễn redirect lỗi.
- `server/http/ingress.js`: allowlist callback được dùng cho query validation,
  kiểm tra URI và đặt `no-store` trước giới hạn request target.
- `server/http/auth-router.js`: xử lý nhánh denial, xác minh state trước khi
  tiêu thụ cookie và chỉ gọi login cho callback có `code` hợp lệ.
- `server/application/auth/service.js`: tách thao tác xác minh state để dùng
  chung cho callback thành công và callback lỗi.
- `shared/generated/api-schema.js`: sinh lại từ OpenAPI; không sửa thủ công.

## Kiểm chứng cuối

- `npm test -- --run test/security/google-oauth-auth-service-fix.test.js test/security/google-oauth-http-fix.test.js test/security/google-oauth.test.js test/security/auth-http.test.js`: PASS, 4 files/38 tests.
- `npm run test:security`: PASS, 16 files/113 tests.
- `npm test -- --run test/http/boundary.test.js test/contract/generated-artifact.test.js test/ui/public/google-oauth.test.js test/unit/auth/google-oauth-lazy-runtime.test.js test/unit/auth/google-oauth-readiness.test.js`: PASS, 5 files/19 tests.
- `npm run contract:validate`: PASS, 58 operations.
- `npm run contract:generate`: PASS, generated 58 operations.
- `npm run contract:test`: PASS, all contract fixtures.
- `npm run lint`: PASS.
- `npm run build`: PASS, Vite production build.
- `git diff --check`: PASS.

Lệnh `npm test -- --run --coverage` đã chạy toàn bộ suite nhưng vẫn gặp 5
kiểm thử migration/client không liên quan đã lỗi và 18 test được skip theo cấu
hình hiện có; vì suite kết thúc lỗi nên không có báo cáo coverage hợp lệ cho
feature này. `npm run format:check` cũng đang fail trên 521 file do baseline
format của repository, ngoài phạm vi callback.

## Trạng thái merge

Chưa stage, commit hoặc push. Các thay đổi hiện có của owner trong
`AGENTS.md` và `CLAUDE.md` được giữ nguyên để stage cùng ở lần commit theo yêu
cầu.
