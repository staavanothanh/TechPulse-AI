import { useState } from 'react'
import { DONATION_DETAILS, DONATION_QR_URL } from '../donation.js'

export default function DonateView() {
  const [qrUnavailable, setQrUnavailable] = useState(false)

  return (
    <div className="public-page">
      <div className="public-container">
        <section className="donate-card">
          <div className="donate-header">
            <span className="donate-icon" aria-hidden="true">
              ☕
            </span>
            <h1 className="donate-title">Ủng hộ TechPulse-AI</h1>
          </div>

          <p className="donate-subtitle">
            TechPulse-AI là dự án mã nguồn mở miễn phí. Nếu bạn thấy dự án hữu ích,
            hãy mua cho tôi một ly cà phê để tiếp tục phát triển!
          </p>

          <div className="donate-qr-section">
            <div className="donate-qr-frame">
              {qrUnavailable ? (
                <p className="donate-qr-fallback" role="status">
                  QR tạm thời chưa tải được. Bạn vẫn có thể chuyển khoản theo thông tin bên dưới.
                </p>
              ) : (
                <img
                  className="donate-qr-image"
                  src={DONATION_QR_URL}
                  alt="Mã QR VietQR để ủng hộ TechPulse-AI"
                  width="220"
                  height="220"
                  loading="eager"
                  referrerPolicy="no-referrer"
                  onError={() => setQrUnavailable(true)}
                />
              )}
            </div>
            <p className="donate-qr-hint">
              Quét mã bằng ứng dụng MB Bank hoặc ứng dụng ngân hàng của bạn
            </p>
          </div>

          <div className="donate-info">
            <div className="donate-info-row">
              <span className="donate-info-label">Ngân hàng</span>
              <span className="donate-info-value">{DONATION_DETAILS.bankName}</span>
            </div>
            <div className="donate-info-row">
              <span className="donate-info-label">Người nhận</span>
              <span className="donate-info-value">{DONATION_DETAILS.accountName}</span>
            </div>
            <div className="donate-info-row">
              <span className="donate-info-label">Số tài khoản</span>
              <span className="donate-info-value">{DONATION_DETAILS.accountNumber}</span>
            </div>
            <div className="donate-info-row">
              <span className="donate-info-label">Nội dung chuyển khoản</span>
              <span className="donate-info-value donate-info-highlight">
                {DONATION_DETAILS.transferContent}
              </span>
            </div>
          </div>

          <div className="donate-thanks">
            <p>Cảm ơn bạn đã ủng hộ! Mỗi đóng góp đều giúp duy trì dự án.</p>
          </div>
        </section>
      </div>
    </div>
  )
}
