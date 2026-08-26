# TDD: Thêm source trong Source Registry

## Phạm vi

Tính năng bổ sung thao tác tạo source trong trang quản trị Source Registry. UI dùng mô hình disclosure inline: biểu mẫu chỉ xuất hiện sau khi quản trị viên bấm **Thêm nguồn**. Luồng gửi dữ liệu vẫn đi qua mutation boundary hiện có của `AdminSourcesView`, vì vậy CSRF, quyền admin và việc tải lại danh sách không bị tách khỏi contract hiện tại.

## RED

- Commit `51a6387` bổ sung kiểm thử semantic disclosure, giới hạn độ dài input và loại bỏ form legacy.
- Kiểm thử RED: `npm test -- --run test/ui/admin/admin-views.test.js` thất bại tại assertion panel còn dùng `role="dialog"`.

## GREEN

- Commit `6c04ac6` đổi panel thành `section[role="region"]`, bỏ khai báo modal không đúng ngữ nghĩa, thêm giới hạn input theo contract và xoá `SourceCreateForm` RSS-only không còn được gọi.
- `npm test -- --run test/ui/admin/admin-views.test.js`: 1 file, 13 kiểm thử đạt.
- `npm test -- --run test/ui/admin/admin-shell.test.js`: kiểm thử shell admin đạt.

## Bảo đảm hành vi

| Hành vi                             | Bằng chứng                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| Form tạo source mặc định ẩn         | Nút disclosure có `aria-expanded=false`; form không render khi đóng.                    |
| Mở/đóng không giả mạo modal         | Panel dùng `role="region"` và `aria-labelledby`; không còn `aria-modal`.                |
| Connector hợp lệ                    | RSS/Atom dùng `accessMethod=rss`; arXiv và Hacker News dùng `accessMethod=api`.         |
| Không thu thập bí mật               | Form chỉ nhận metadata và endpoint connector; không có credential/API key.              |
| Payload đúng contract               | `buildSourceCreateInput` map authority tier và `connectorConfig` theo loại connector.   |
| CSRF và quyền admin được giữ nguyên | `createSource` gọi `mutateAdmin` với CSRF token; chỉ đóng form sau response thành công. |
| Input có giới hạn                   | Name/source key/publisher/domain/endpoint có `maxLength` phù hợp.                       |
| Không còn implementation lệch       | `SourceCreateForm` RSS-only cũ đã được loại khỏi `AdminSourceForms.jsx`.                |

## Gate xác minh

- `npm test -- --run test/ui/admin/admin-views.test.js`: đạt, 13/13.
- `npm test -- --run test/client/app-policy.test.js test/migrations/admin-performance-indexes.test.js test/migrations/governance-capability-probes.test.js test/unit/migrations/qa-evidence-fence.test.js test/unit/indexing/provider-routing-persistence.test.js`: đạt, 5 file/46 kiểm thử.
- Các kiểm thử migration trong nhóm trên chỉ được đồng bộ assertion với dispatcher hiện có (`appDb`); không thay đổi runtime migration.

## Toàn bộ repository

- `npm test -- --run`: đạt, 207 file/1.265 kiểm thử; 18 file và 70 kiểm thử được skip theo điều kiện môi trường.
- `npm run lint`: đạt.
- `npm run build`: đạt.
- `npm run contract:validate`: đạt, 58 operation.
- `npm run contract:test`: đạt.
- `npm run test:ui`: đạt, 14 file/75 kiểm thử.
- `npm run test:e2e`: đạt, 5 kiểm thử pass; 11 kiểm thử skip theo cấu hình E2E.
- `npm test -- --run --coverage`: các kiểm thử pass nhưng command dừng ở ngưỡng coverage global hiện có của repository (statements 74,06%, branches 69,24%, functions 79,2%).
- `npm run format:check`: command hiện báo 523 file chưa theo format chuẩn hiện hành của repository; không thuộc thay đổi Source Registry. Các file liên quan đã được kiểm tra riêng, không phát sinh lỗi cú pháp hoặc lint.
