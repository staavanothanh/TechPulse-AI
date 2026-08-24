# ADR-0020: Thêm đăng nhập Google OAuth theo redirect có state được ký

- **Trạng thái**: accepted
- **Ngày**: 2026-08-24

## Bối cảnh

Nhánh Google OAuth ban đầu chỉ có helper trao đổi authorization code. Runtime
không resolve credential từ các tên biến môi trường, callback nhận `POST` trong
khi Google redirect bằng `GET`, và server không tạo hoặc kiểm tra `state`. User
mới cũng không thể ghi vào Mongo vì validator chưa cho identity Google và audit
validator chưa cho hai action OAuth.

## Quyết định

- Dùng flow authorization-code redirect:
  - `GET /api/v1/auth/google` tạo state ngẫu nhiên có chữ ký HMAC và đặt cookie
    tạm `__Host-techpulse_google_oauth_state`.
  - Google redirect tới `GET /api/v1/auth/google/callback?code=...&state=...`.
  - Callback kiểm tra state đã ký, thời hạn và giá trị cookie trước khi tiêu tốn
    quota login hoặc gọi Google; sau đó xóa cookie, tạo session và redirect
    `303` về cùng origin.
- Dùng key riêng `GOOGLE_OAUTH_STATE_SECRET_ENV`; không tái sử dụng bearer secret
  của cron. Cấu hình Google phải đầy đủ và redirect URI phải khớp exact public
  origin với path callback.
- Xác minh user bằng Google OAuth2 v2 userinfo: email Gmail đã xác minh và stable
  subject (`id`, hoặc `sub` nếu endpoint tương thích OIDC trả field này). Không
  dùng email làm identity key duy nhất. Email local chưa được liên kết trả
  conflict, không tự động chiếm tài khoản.
- Thêm migration successor `google-oauth` thay vì sửa migration đã chạy:
  - mở rộng validator `users` cho `googleSub` bounded;
  - thêm unique partial index `users_google_sub_unique`;
  - mở rộng validator audit kế thừa `GOVERNANCE_AUDIT_VALIDATOR` cho
    `google_oauth_registered` và `google_oauth_login`;
  - kiểm tra predecessor trước mọi `collMod` để tránh downgrade schema.
- Tách runtime attestation scope `google-oauth-v1`. Deployment phải apply và
  verify migration, sau đó phát hành attestation tương ứng trước khi bật flow.
- Không đưa commit donate/QR vào merge này. QR chỉ được thêm sau khi owner cung
  cấp recipient, account/phone, payload hoặc ảnh QR thật và nội dung chuyển khoản.

## Hệ quả

- Google OAuth có thể chạy trên Vercel/serverless vì state nằm trong cookie ký,
  không phụ thuộc memory của instance.
- Callback error response được đánh dấu `Cache-Control: no-store` vì URL chứa
  authorization code và state.
- User OAuth dùng password hash ngẫu nhiên riêng cho validator; password login
  không biết giá trị này và không được tự động liên kết với tài khoản local.
- Mỗi môi trường phải cấu hình bốn tên biến Google OAuth và giá trị credential
  tương ứng; nếu chỉ cấu hình một phần, runtime fail closed.

## Phương án không chọn

- Không dùng state do client tự cấp hoặc state lưu trong memory instance.
- Không nhận callback JSON `POST` làm flow chính vì Google không redirect theo
  phương thức đó.
- Không sửa `scripts/migrations/auth-core.js` hoặc ghi refresh token vào Mongo.
- Không hardcode thông tin người nhận cho QR donate.
