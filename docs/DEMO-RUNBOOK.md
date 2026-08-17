# Demo data runbook

Runbook này chỉ dùng cho Step 12 trên local host. Seed gọi RSS The Verge, arXiv API và Hacker News API qua `safeFetch`. Dataset lưu tối đa 50 article ở phạm vi metadata-only; nó không lưu raw HTML, full text, provider payload hoặc media binary.

## Điều kiện trước khi chạy

- Migration đến `provider-routing-v2` đã được áp dụng và verify.
- `.env` có runtime credential qua `MONGODB_URI_ENV` để chạy verifier chỉ đọc.
- Khi apply, `.env` có `MONGODB_OPERATOR_URI_ENV` trỏ tới operator credential.
- Operator có quyền đọc schema/index, đọc active admin và `find`, `insert`, `update` trên `sources`, `articles`, `adminAuditLogs`.
- Database có admin reviewer đang `active`. Owner phải xác nhận policy metadata-only và cung cấp đúng ObjectId của reviewer; seed không tự chọn một admin để gán audit.
- Máy local truy cập được ba endpoint nguồn công khai.

## Dry-run

```powershell
npm run seed:demo
```

Dry-run gọi connector thật và dựng dataset trong bộ nhớ. Lệnh không kết nối hoặc ghi MongoDB. Dry-run có thể giữ phần dữ liệu hợp lệ khi một source lỗi, nhưng vẫn fail nếu tổng số article hợp lệ nhỏ hơn 20.

Kiểm tra `diagnostics` trong JSON output. Mỗi source cho biết số bản ghi `fetched`, `accepted`, `skipped` hoặc error code an toàn.

## Apply

Chỉ chạy sau khi owner xác nhận quyền ghi database:

```powershell
$env:DEMO_SOURCE_POLICY_ATTESTED='true'
$env:DEMO_SOURCE_REVIEWER_ID='<active-admin-object-id>'
npm run seed:demo -- --apply
```

Apply ghi ba source, article và năm lifecycle audit cho mỗi source trong transaction. Audit ghi đúng chuỗi `created → policy reviewed → technical check → draft/testing → testing/active`. `targetId` của audit là Mongo ObjectId.

Apply fail nếu bất kỳ connector nào lỗi hoặc một source có ít hơn năm article trong manifest cuối. Mỗi source audit chứa manifest hash và run timestamp của đúng lần seed đó.

Hai biến attestation chỉ xác nhận bootstrap demo local. Chúng không cấp quyền sử dụng nguồn ở production. Production vẫn cần project owner phê duyệt terms/license và Source Registry policy riêng.

Seed chỉ dùng `$setOnInsert`. Seed không update, replace hoặc delete dữ liệu đã có. Cùng identity, manifest và payload được báo là `existing`. Một live run mới tạo manifest/run timestamp mới; nếu identity cũ đã tồn tại, seed fail closed thay vì trộn hai lần quan sát. Configuration, policy hoặc nội dung article khác cũng tạo payload conflict.

## Verify

```powershell
npm run verify:demo
```

Verifier dùng runtime Mongo credential và chỉ đọc database. Kết quả hợp lệ phải có:

- đủ ba source key và mọi source ở trạng thái `active` với policy cho phép;
- ít nhất 20 article `published`, đồng thời ít nhất năm article cho từng source;
- đủ 15 lifecycle audit, gồm năm audit bắt buộc cho mỗi source.
- manifest hash của từng source khớp đúng article có `retrievedAt` bằng run timestamp trong audit active hiện tại.

`verified: false` hoặc exit code khác `0` là release gate fail.

## Reset-safe

Không có lệnh broad reset cho database dùng chung. Chạy lại seed chỉ giữ fixture đã tồn tại và không hoàn tác thay đổi vận hành. Payload conflict dừng toàn bộ transaction để operator kiểm tra dữ liệu lệch.

Khi cần một demo sạch, dùng database local/Atlas test riêng rồi chạy migration và seed từ đầu. Không xóa source, article hoặc audit trong database dùng chung để “reset” demo. Seed và E2E không tự cleanup audit evidence.
