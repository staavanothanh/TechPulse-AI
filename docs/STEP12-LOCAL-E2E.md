# Step 12: local E2E và dữ liệu demo

Step 12 hiện chỉ chạy trên local host. Chưa có bước deploy lên Vercel.

## 1. Kiểm tra migration

Chạy các lệnh này sau khi đã cấp quyền MongoDB cho runtime và operator:

```powershell
npm run db:verify -- provider-routing-v2 --require-role
```

Lệnh phải trả về `verified: true` trước khi khởi động server.

## 2. Chuẩn bị dữ liệu demo

Lệnh seed không ghi MongoDB nếu không có `--apply`:

```powershell
npm run seed:demo
```

Lệnh trên gọi connector thật (RSS The Verge, arXiv API và Hacker News API), fetch qua `safeFetch`, chỉ giữ metadata đã chuẩn hóa và không ghi MongoDB. Mỗi lần chạy tối đa 50 bài. Lệnh ghi dữ liệu cần quyền operator và phải được xác nhận riêng:

```powershell
node --env-file-if-exists=.env scripts/seed-demo.js --apply
```

Seed có tính idempotent. Chạy lại không cập nhật hay xóa bài đã tồn tại; khóa định danh dựa trên source key và external ID/canonical URL.

Script tạo ba source demo metadata-only (`demo:rss-the-verge`, `demo:arxiv-cs-ai`, `demo:hn-topstories`) từ nguồn công khai thật. Nó ghi audit bootstrap cho technical check, policy review và các bước draft → testing → active; audit này chỉ mô tả operator bootstrap local, không thay thế luồng review nguồn production. Không có raw HTML, full text, provider payload hoặc media binary được lưu.

Kiểm tra lại fixture bằng lệnh chỉ đọc:

```powershell
npm run verify:demo
```

## 3. Chạy server

Mở terminal thứ nhất:

```powershell
npm run dev
```

Server mặc định nghe tại `http://localhost:3000`.

## 4. Chạy Vitest local-host E2E

Đặt thông tin đăng nhập test trong biến môi trường của terminal thứ hai. Không ghi mật khẩu vào repository:

```powershell
$env:E2E_ENABLED='true'
$env:E2E_BASE_URL='http://localhost:3000'
$env:E2E_ORIGIN='http://localhost:3000'
$env:E2E_USER_EMAIL='user@example.com'
$env:E2E_USER_PASSWORD='mat-khau-test'
$env:E2E_ADMIN_EMAIL='admin@example.com'
$env:E2E_ADMIN_PASSWORD='mat-khau-admin-test'
$env:E2E_SEARCH_QUERY='AI'
$env:E2E_REQUIRE_ARTICLES='true'
npm run test:e2e:local
```

E2E kiểm tra health, login, session bootstrap, feed, text search, admin overview/articles/sources/audit và logout. Mỗi request mutation đều gửi `Origin`, cookie session và CSRF theo contract.

`npm run test:e2e:local` sẽ dừng với mã lỗi nếu thiếu credential hoặc `E2E_ENABLED` khác `true`. Lệnh `npm run test:e2e` tổng hợp vẫn bỏ qua local-host suite khi chưa bật gate. Suite E2E controlled hiện có vẫn chạy độc lập với server.

## Phạm vi chưa thực hiện

- Không deploy lên Vercel.
- Không tự động ghi MongoDB trong quá trình E2E.
- Chỉ chạy seed `--apply` sau khi đã xác nhận quyền ghi operator.
