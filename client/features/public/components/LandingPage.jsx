import AuthPanel from './AuthPanel.jsx'
import PublicHeader from './PublicHeader.jsx'

const FEATURES = Object.freeze([
  {
    id: 'feed',
    title: 'Feed có nguồn rõ ràng',
    copy: 'Mỗi bài dẫn về nguồn nguyên bản. Nội dung hiển thị theo chính sách nguồn hiện hành.',
  },
  {
    id: 'summary',
    title: 'Tóm tắt tiếng Việt',
    copy: 'Tóm tắt ngắn có nhãn rõ ràng và luôn giữ đường dẫn tới bài gốc.',
  },
  {
    id: 'qa',
    title: 'Hỏi đáp có citation',
    copy: 'Mỗi đoạn trả lời gắn với bằng chứng đã truy xuất. Thiếu bằng chứng thì không đoán.',
  },
  {
    id: 'search',
    title: 'Tìm kiếm hybrid',
    copy: 'Kết hợp tín hiệu từ khóa và ngữ nghĩa. Tìm kiếm văn bản vẫn có thể hoạt động độc lập.',
  },
])

const SOURCE_NAMES = Object.freeze([
  'DZone',
  'DEV Community',
  'VnExpress',
  'ARXIV',
  'Hacker News',
  'TECHPULSE',
  'GitHub Blog',
])

function FeatureGrid() {
  return (
    <section
      className="public-section public-feature-section"
      aria-labelledby="public-feature-title"
      data-od-id="features"
    >
      <div className="public-container">
        <h2 id="public-feature-title">Nắm nhanh công nghệ có căn cứ</h2>
        <p className="public-section-copy">
          Bốn phần của trải nghiệm reader cùng hướng về một nguyên tắc: kết luận phải mở được nguồn
          để kiểm chứng.
        </p>
        <div className="public-feature-grid">
          {FEATURES.map((feature) => (
            <article className="public-feature-card" key={feature.id}>
              <span className="public-feature-icon" aria-hidden="true">
                <FeatureIcon name={feature.id} />
              </span>
              <h3>{feature.title}</h3>
              <p>{feature.copy}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function FeatureIcon({ name }) {
  let paths
  if (name === 'feed') {
    paths = (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>
    )
  } else if (name === 'summary') {
    paths = <path d="M4 6h16M4 12h10M4 18h7" />
  } else if (name === 'qa') {
    paths = <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />
  } else {
    paths = (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      {paths}
    </svg>
  )
}

export default function LandingPage({
  auth = {},
  theme = 'light',
  onThemeToggle,
  onBrandClick,
  onGuestBrowse,
}) {
  return (
    <div className="public-page public-landing" data-theme={theme}>
      <PublicHeader theme={theme} onThemeToggle={onThemeToggle} onBrandClick={onBrandClick} />
      <div className="public-landing-hero" data-od-id="hero">
        <div className="public-container public-hero-grid">
          <div className="public-hero-copy">
            <p className="public-eyebrow">TechPulse AI · Cho người học và người làm công nghệ</p>
            <h1>
              Nắm nhanh công nghệ.
              <br />
              Biết rõ nguồn gốc.
            </h1>
            <p className="public-lead">
              Tin công nghệ mỗi ngày, tóm tắt gọn bằng tiếng Việt. Câu trả lời AI luôn kèm bằng
              chứng để bạn kiểm chứng.
            </p>
          </div>
          <AuthPanel {...auth} onGuestBrowse={onGuestBrowse} />
        </div>
        <div className="public-container public-source-marquee-wrap">
          <div className="public-source-marquee" aria-label="Các nguồn tin được hỗ trợ">
            <span className="public-sr-only">
              DZone, DEV Community, VnExpress, ARXIV, Hacker News, TECHPULSE và GitHub Blog
            </span>
            <div className="public-source-track" aria-hidden="true">
              {[...SOURCE_NAMES, ...SOURCE_NAMES].map((source, index) => (
                <span className="public-source-name" key={`${source}-${index}`}>
                  {source}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <FeatureGrid />
      <footer className="public-footer">
        <div className="public-container">© 2026 TechPulse AI</div>
      </footer>
    </div>
  )
}

export { FEATURES, SOURCE_NAMES }
