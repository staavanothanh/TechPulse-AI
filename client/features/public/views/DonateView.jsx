import { useMemo } from 'react'

const PAYMENT_URL = 'https://me.momo.vn/qr/0866952918'

function generateQrMatrix(text) {
  const size = 21
  const matrix = Array.from({ length: size }, () => Array(size).fill(false))

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      matrix[r][c] = (r + c + text.charCodeAt((r * size + c) % text.length)) % 2 === 0
    }
  }

  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      matrix[r][c] = true
      matrix[size - 1 - r][c] = true
      matrix[r][size - 1 - c] = true
    }
  }

  return matrix
}

function QrCode({ text, size = 200 }) {
  const matrix = useMemo(() => generateQrMatrix(text), [text])
  const cellSize = size / matrix.length

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="QR code"
      className="donate-qr-svg"
    >
      <rect width={size} height={size} fill="#ffffff" />
      {matrix.map((row, r) =>
        row.map((cell, c) =>
          cell ? (
            <rect
              key={`${r}-${c}`}
              x={c * cellSize}
              y={r * cellSize}
              width={cellSize}
              height={cellSize}
              fill="#0f172a"
            />
          ) : null,
        ),
      )}
    </svg>
  )
}

export default function DonateView() {
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
              <QrCode text={PAYMENT_URL} size={220} />
            </div>
            <p className="donate-qr-hint">
              Quét mã bằng ứng dụng Momo / Ngân hàng
            </p>
          </div>

          <div className="donate-info">
            <div className="donate-info-row">
              <span className="donate-info-label">Người nhận</span>
              <span className="donate-info-value">Nguyễn Văn A</span>
            </div>
            <div className="donate-info-row">
              <span className="donate-info-label">Số điện thoại</span>
              <span className="donate-info-value">0866 952 918</span>
            </div>
            <div className="donate-info-row">
              <span className="donate-info-label">Nội dung chuyển khoản</span>
              <span className="donate-info-value donate-info-highlight">
                Ung ho TechPulse
              </span>
            </div>
          </div>

          <div className="donate-thanks">
            <p>
              Cảm ơn bạn đã ủng hộ! Mỷ đóng góp, dù nhỏ, đều giúp duy trì dự án
            </p>
          </div>
        </section>
      </div>
    </div>
  )
}
