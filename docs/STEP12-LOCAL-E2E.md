# Step 12: local va Vercel Preview E2E va du lieu demo

Local host là môi trường mặc định. Vercel Preview chỉ chạy khi đã có deployment HTTPS và các biến Preview tương ứng; Production deploy/Cron activation vẫn là gate riêng.

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
$env:E2E_DEMO_SOURCE_ID='<source-id-24-ky-tu>'
$env:E2E_DEMO_ARTICLE_ID='<article-id-24-ky-tu>'
$env:E2E_SEARCH_QUERY='AI'
npm run test:e2e:local
```

E2E runner tự ép `E2E_REQUIRE_ARTICLES=true`, yêu cầu source/article ID 24 ký tự từ deterministic demo seed và yêu cầu `E2E_SEARCH_QUERY` không rỗng. Suite kiểm tra health, login, session bootstrap, feed của đúng demo source, detail của đúng demo article, text search phải có kết quả, admin overview/articles/sources/audit và logout. Mỗi request mutation đều gửi `Origin`, cookie session và CSRF theo contract.

`npm run test:e2e:local` sẽ dừng với mã lỗi nếu thiếu credential hoặc `E2E_ENABLED` khác `true`. Lệnh `npm run test:e2e` tổng hợp vẫn bỏ qua local-host suite khi chưa bật gate. Suite E2E controlled hiện có vẫn chạy độc lập với server.

Các boundary governance (user không đọc được admin, deletion/takedown thiếu CSRF bị từ chối) luôn chạy cùng local suite nhưng không ghi dữ liệu. Luồng mutation governance thật là opt-in và chỉ dùng account/article disposable:

```powershell
$env:E2E_GOVERNANCE_MUTATIONS='true'
$env:E2E_DELETION_EMAIL='deletion-e2e@example.com'
$env:E2E_DELETION_PASSWORD='mat-khau-disposable'
$env:E2E_DELETION_CONFIRM_EMAIL='deletion-e2e@example.com'
$env:E2E_TAKEDOWN_ARTICLE_ID=$env:E2E_DEMO_ARTICLE_ID

# Tạo account user disposable cho mutation E2E; mặc định chỉ dry-run.
npm run seed:e2e-user
npm run seed:e2e-user -- --apply
npm run test:e2e:local
```

`seed:e2e-user -- --apply` chỉ tạo user mới nếu email chưa tồn tại, ghi audit `user_registered` trong cùng transaction và không reset/reactivate account cũ. Ưu tiên dùng domain dành cho test như `example.com`, `.invalid` hoặc `.test`. Nếu dùng một account test riêng trên domain thật, đặt `E2E_SEED_CONFIRM=true` trong terminal local trước khi chạy `--apply`; không dùng account admin/user chính.

`test:e2e:local` chỉ chấp nhận `E2E_BASE_URL` và `E2E_ORIGIN` cùng là `http://localhost`. Hai biến Preview phải được đặt lại theo từng terminal khi chạy `test:e2e:vercel`; không dùng URL Preview cho local suite.

Runner refuse unsafe env nếu deletion email trùng user/admin hoặc confirmation không khớp. Suite cũng xác nhận login account deletion có `role=user`. Luồng opt-in tạo takedown rồi reject để không ẩn bài viết; deletion request chỉ được accept và không chạy worker purge. Không dùng email admin/user thật cho luồng này.

## 5. Chạy API/Cron E2E trên Vercel Preview

Vercel Cron chỉ được kích hoạt ở Production, nên Preview kiểm tra trực tiếp cùng HTTP route và bearer boundary; không chờ scheduler tự gọi.

Đặt Preview URL và secret của Preview trong terminal, không ghi secret vào repository:

```powershell
$env:E2E_VERCEL_ENABLED='true'
$env:E2E_BASE_URL='https://<preview>.vercel.app'
$env:E2E_ORIGIN='https://<preview>.vercel.app'
$env:E2E_CRON_SECRET='preview-cron-secret-tu-vercel'
npm run test:e2e:vercel
```

Deployment Protection không được tắt để chạy test. Nếu Preview được bảo vệ, truyền các header xác thực do provider cấp qua biến môi trường (không ghi giá trị vào repo):

```powershell
$env:E2E_VERCEL_PROTECTION_HEADERS_JSON='{"x-vercel-protection-bypass":"<provider-issued-value>"}'
npm run test:e2e:vercel
```

Nếu health request trả về `401/403` hoặc trang Deployment Protection, test sẽ fail-closed với chẩn đoán yêu cầu header xác thực; suite không coi Preview bị chặn là thành công và không hướng dẫn vô hiệu hóa protection. Script cũng dừng với mã lỗi nếu chưa bật gate, URL không phải HTTPS, thiếu `E2E_CRON_SECRET` hoặc JSON header không hợp lệ.

## Phạm vi chưa thực hiện

- Chưa promote Production hoặc kích hoạt Cron Production.
- Không tự động ghi MongoDB trong quá trình E2E.
- Chỉ chạy seed `--apply` sau khi đã xác nhận quyền ghi operator.
