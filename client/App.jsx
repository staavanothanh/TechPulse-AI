import { useEffect, useState } from 'react'
import { createApiClient } from '../shared/generated/api-client.js'

const api = createApiClient()

export default function App() {
  const [health, setHealth] = useState({ status: 'loading', message: 'Đang kiểm tra API…' })

  useEffect(() => {
    let active = true
    api
      .getHealth()
      .then((response) => {
        if (active) setHealth({ status: 'ok', message: `API sẵn sàng · ${response.data.timestamp}` })
      })
      .catch(() => {
        if (active) setHealth({ status: 'warning', message: 'API chưa phản hồi. Có thể tiếp tục làm việc local.' })
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <>
      <a className="skip-link" href="#main-content">
        Bỏ qua điều hướng
      </a>
      <header className="site-header">
        <div className="brand-mark" aria-hidden="true">
          TP
        </div>
        <div>
          <div className="brand-name">TechPulse AI</div>
          <div className="brand-sub">News intelligence foundation</div>
        </div>
        <div className="header-status" role="status" aria-live="polite">
          <span className={`status-dot status-${health.status}`} aria-hidden="true" />
          {health.message}
        </div>
      </header>

      <div className="app-layout">
        <nav className="side-nav" aria-label="Điều hướng nền tảng">
          <span className="nav-label">Foundation</span>
          <a className="nav-item active" href="#main-content" aria-current="page">
            App shell
          </a>
          <span className="nav-note">Các màn hình Feed, Search, Article, Q&amp;A và Admin sẽ được triển khai ở các step sau.</span>
        </nav>

        <main id="main-content" tabIndex="-1">
          <section className="hero-card" aria-labelledby="page-title">
            <div className="eyebrow">STEP 01 · CONTRACT-FIRST FOUNDATION</div>
            <h1 id="page-title">Theo dõi công nghệ với bằng chứng rõ ràng.</h1>
            <p className="hero-copy">
              App shell này chỉ xác nhận nền tảng React/Vite đã kết nối được với Express health contract.
              Chưa có business UI hoặc dữ liệu nguồn ở Step 1.
            </p>
            <div className="foundation-grid">
              <article className="foundation-card">
                <span className="mono">01</span>
                <h2>JavaScript/JSX</h2>
                <p>Frontend và backend dùng chung quy ước module, JSDoc và OpenAPI.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">02</span>
                <h2>Boundary trước feature</h2>
                <p>Ingress, error envelope, Origin và request ID được khóa trước business flow.</p>
              </article>
              <article className="foundation-card">
                <span className="mono">03</span>
                <h2>Accessibility mặc định</h2>
                <p>Skip link, focus-visible, live status và responsive layout sẵn sàng cho step kế tiếp.</p>
              </article>
            </div>
          </section>
        </main>
      </div>
    </>
  )
}
