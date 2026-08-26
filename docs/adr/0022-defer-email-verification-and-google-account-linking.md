# ADR-0022: Hoãn xác minh quyền sở hữu email và liên kết tài khoản Google

- **Trạng thái**: accepted
- **Ngày**: 2026-08-26
- **Bên quyết định**: Project owner và nhóm TechPulse AI

## Bối cảnh

Luồng đăng ký bằng mật khẩu hiện kiểm tra định dạng email, độ dài mật khẩu và
tính duy nhất của email trong hệ thống. Kiểm tra định dạng không chứng minh
người đăng ký sở hữu hộp thư hoặc địa chỉ đó còn tồn tại. Luồng Google OAuth
được Google xác minh email và dùng `sub` ổn định làm danh tính; nếu email đã
thuộc tài khoản mật khẩu nhưng chưa có `googleSub`, hệ thống trả
`oauth_identity_conflict` thay vì tự động chiếm hoặc gộp tài khoản.

Để bổ sung xác minh email thực (OTP hoặc verification link), cũng như liên kết
Google với tài khoản đã đăng ký bằng mật khẩu, cần thêm email delivery, token
verification có vòng đời, trạng thái xác minh, re-authentication và các bước
khôi phục an toàn. Các thay đổi này vượt quá thời gian còn lại để chốt MVP.

## Quyết định

- Không triển khai xác minh quyền sở hữu Gmail/email thực trong phạm vi MVP.
  Đăng ký bằng mật khẩu chỉ bảo đảm các kiểm tra cú pháp, chính sách mật khẩu
  và chống trùng email; hệ thống không gửi OTP hoặc verification link.
- Không triển khai liên kết Google với tài khoản mật khẩu hiện có trong MVP.
  Giữ hành vi fail-closed hiện tại: email trùng nhưng `googleSub` khác bị từ
  chối bằng `oauth_identity_conflict`, không tự động liên kết theo email.
- Giữ Google OAuth như một phương thức độc lập: Google xác minh email ở phía
  provider, còn TechPulse lưu `googleSub` riêng và tạo hoặc đăng nhập tài khoản
  OAuth theo identity đó.
- Ghi nhận hai khả năng trên vào backlog hậu MVP; mọi triển khai tương lai phải
  bổ sung contract, migration, audit event, rate limit và quy trình re-auth
  trước khi bật trên production.

## Phương án đã cân nhắc

- **Xác minh email ngay trong MVP**: không chọn vì cần thêm provider gửi thư,
  secret/template vận hành, token expiry, chống replay và test end-to-end.
- **Tự động liên kết email trùng**: không chọn vì email từ đăng ký mật khẩu
  chưa được chứng minh quyền sở hữu; có thể cho phép tài khoản Google chiếm
  tài khoản local.
- **Liên kết có xác nhận explicit**: là hướng phù hợp cho hậu MVP nhưng cần
  re-auth tài khoản local, xác minh Google, CSRF/state và audit đầy đủ nên chưa
  thực hiện trong thời hạn hiện tại.

## Hệ quả

### Tích cực

- Giữ phạm vi MVP nhỏ, tránh đưa email delivery và credential mới vào vận hành
  khi chưa có thời gian kiểm thử đầy đủ.
- Không tạo đường tắt tự động liên kết có thể dẫn đến account takeover.
- Google OAuth hiện tại vẫn bảo đảm email do Google xác minh và identity theo
  `sub`.

### Tiêu cực và rủi ro đã chấp nhận

- Người dùng có thể đăng ký địa chỉ Gmail không tồn tại hoặc không thuộc quyền
  sở hữu của họ nếu địa chỉ đúng cú pháp.
- Người dùng đã có tài khoản mật khẩu không thể dùng Google OAuth cùng email đó
  cho tới khi có flow liên kết explicit.
- MVP chưa có bằng chứng ownership email; đây là giới hạn đã biết, phải nêu rõ
  trong tài liệu vận hành và xử lý ở backlog hậu MVP.

## Phạm vi hậu MVP

Thiết kế tiếp theo cần quyết định provider email, schema trạng thái
`emailVerifiedAt`, token một lần có hash và expiry, rate limit, resend policy,
re-authentication cho cả hai phương thức, audit event và các test chống replay,
CSRF, account takeover trước khi cho phép liên kết.
