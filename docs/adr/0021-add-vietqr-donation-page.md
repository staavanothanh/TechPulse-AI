# ADR-0021: Thêm trang ủng hộ công khai bằng VietQR không cố định số tiền

- **Trạng thái**: accepted
- **Ngày**: 2026-08-24

## Bối cảnh

TechPulse-AI cần một cách nhận ủng hộ đơn giản. Người dùng cần quét mã bằng
ứng dụng ngân hàng mà không phải nhập số tiền cố định. Thông tin người nhận
do project owner cung cấp và được phép hiển thị công khai trên trang ủng hộ.

## Quyết định

- Thêm route public `donate` vào reader navigation.
- Dùng VietQR image API của `img.vietqr.io` với BIN của MB Bank và số tài
  khoản của project owner.
- Không truyền query `amount`. Người quét tự nhập số tiền trong ứng dụng ngân
  hàng.
- Giữ nội dung chuyển khoản cố định là `User TechPulse-AI gửi Admin ly coffee`.
- Tạo URL từ `client/features/public/donation.js`. Hiển thị tên người nhận có
  dấu trong UI; gửi tên không dấu, viết hoa trong query `accountName` theo
  định dạng QR.
- Hiển thị ảnh QR remote bằng thẻ `img`. Không tạo QR giả bằng SVG, không
  rehost ảnh và không lưu ảnh nhị phân trong repository.
- Nếu ảnh QR không tải được, hiển thị thông báo fallback và thông tin chuyển
  khoản dạng chữ.

## Hệ quả

- QR có thể thay đổi khi project owner thay đổi thông tin tài khoản bằng một
  thay đổi code có kiểm thử.
- URL QR và thông tin tài khoản là dữ liệu public. Không đặt secret hoặc token
  trong payload.
- Trang phụ thuộc vào khả năng truy cập `img.vietqr.io`. Fallback chữ vẫn cho
  phép người dùng chuyển khoản thủ công.
- Không cần migration MongoDB vì feature không tạo hoặc lưu dữ liệu runtime.

## Phương án không chọn

- Không dùng Momo hoặc một deep link riêng của nhà cung cấp.
- Không đặt số tiền mặc định trong QR.
- Không nhận thông tin tài khoản từ user và không lưu thông tin người gửi.
