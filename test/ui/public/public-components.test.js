import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import PublicApp, {
  AccountView,
  ArticleView,
  AuthPanel,
  FeedView,
  LandingPage,
  QaView,
  ReaderShell,
  SavedView,
  SearchView,
  validateCredentials,
} from '../../../client/features/public/index.js'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))

const article = {
  id: 'article-1',
  titleVi: 'Mô hình nhỏ thay đổi cách đội ngũ vận hành AI',
  titleOriginal: 'Small models change how teams operate AI',
  originalUrl: 'https://example.com/articles/article-1',
  source: { id: 'source-1', name: 'Tech Review', domain: 'example.com' },
  sourceLanguage: 'en',
  publishedAt: '2026-08-18T08:00:00.000Z',
  topics: ['AI', 'DevOps'],
  summaryStatus: 'ready',
  summaryBasis: 'metadata',
  summaryVi: 'Bản tóm tắt ngắn có thể kiểm chứng tại nguồn gốc.',
  isSaved: false,
}

const handlers = Object.freeze({
  onNavigate: vi.fn(),
  onOpenArticle: vi.fn(),
  onSaveToggle: vi.fn(),
  onSubmit: vi.fn(),
  onRetry: vi.fn(),
  onClear: vi.fn(),
})

describe('public feature presentation contract', () => {
  it('renders the landing/auth presentation with the guarded guest affordance', () => {
    const html = render(LandingPage, { auth: { mode: 'login', onSubmit: handlers.onSubmit } })
    expect(html).toContain('Nắm nhanh công nghệ.')
    expect(html).toContain('Biết rõ nguồn gốc.')
    expect(html).toContain('id="public-auth-form"')
    expect(html).toContain('id="public-auth-email"')
    expect(html).toContain('id="public-auth-password"')
    expect(html).toContain('Tiếp tục như khách →')
    expect(html).toContain('DZone')
    expect(html).toContain('DEV Community')
    expect(html).toContain('VnExpress')
    expect(html).toContain('ARXIV')
    expect(html).toContain('Hacker News')
    expect(html).toContain('TECHPULSE')
    expect(html).toContain('GitHub Blog')
    expect(html).toContain('© 2026 TechPulse AI')
    expect(html).toContain('public-container public-source-marquee-wrap')
    expect(html).toContain('public-feature-icon')
    expect(html).toContain('M4 19.5A2.5 2.5')
    expect(html).toContain('M4 6h16M4 12h10M4 18h7')
    expect(html).toContain('M21 12a8 8 0 0 1-11.6 7.1')
    expect(html).toContain('M21 21l-4.3-4.3')
    expect(html).not.toMatch(/user@techpulse|admin@|password123|sessionStorage/i)
  })

  it('validates auth fields at the UI boundary and exposes only the supplied submit callback', () => {
    expect(validateCredentials({ email: '', password: '' })).toEqual(
      expect.objectContaining({ valid: false }),
    )
    expect(
      validateCredentials({ email: 'reader@example.com', password: 'long-enough-password' }),
    ).toEqual({ valid: true, errors: {} })
    const html = render(AuthPanel, { mode: 'register', onSubmit: handlers.onSubmit })
    expect(html).toContain('Tạo tài khoản mới')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).not.toContain('Tiếp tục như khách')
  })

  it('renders authenticated reader shell navigation with route callback and mobile labels', () => {
    const html = render(ReaderShell, {
      route: 'feed',
      onNavigate: handlers.onNavigate,
      status: 'API sẵn sàng · 2026-08-20T00:00:00.000Z',
      children: React.createElement('div', null, 'Reader body'),
    })
    expect(html).toContain('aria-label="Điều hướng chính"')
    expect(html).toContain('aria-label="Điều hướng di động"')
    expect(html).toContain('Feed')
    expect(html).toContain('Tìm kiếm')
    expect(html).toContain('Đã lưu')
    expect(html).toContain('Hỏi đáp')
    expect(html).toContain('Tài khoản')
    expect(html).toContain('Reader body')
    expect(html).not.toContain('API sẵn sàng')
    expect(html).toContain('public-scroll-top')
    expect(html).toContain('aria-label="Về đầu trang"')
    expect(html).toContain('M12 19V5M5 12l7-7 7 7')
    expect(html).not.toMatch(/<main(?:\s|>)/)
  })

  it('keeps feed and search states bounded and does not expose transport cursors or mock data', () => {
    const loading = render(FeedView, { state: 'loading', handlers })
    const ready = render(FeedView, {
      state: 'ready',
      articles: [article],
      meta: { hasNext: true, nextCursor: 'opaque-cursor' },
      handlers,
    })
    const search = render(SearchView, {
      state: 'ready',
      query: { q: 'AI', mode: 'hybrid' },
      results: [article],
      meta: { hasNext: false, nextCursor: 'opaque-search-cursor' },
      handlers,
    })
    expect(loading).toContain('aria-busy="true"')
    expect(ready).toContain(article.titleVi)
    expect(ready).toContain('AI')
    expect(ready).toContain('DevOps')
    expect(ready).toContain('public-card-media-placeholder')
    expect(ready).toContain('Ảnh nguồn: Tech Review')
    expect(ready).toContain('aria-label="Chủ đề"')
    expect(ready).toContain('public-icon-btn')
    expect(ready).toContain('M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z')
    expect(ready).toContain('Trang 1')
    expect(ready).not.toContain('opaque-cursor')
    expect(search).toContain('Tìm kiếm hybrid')
    expect(search).not.toContain('opaque-search-cursor')
    expect(search).not.toMatch(/score|semanticScore|providerPayload|rawHtml/i)
  })

  it('renders saved empty state and article detail with a safe canonical source link', () => {
    const empty = render(SavedView, {
      state: 'ready',
      articles: [],
      onOpenFeed: handlers.onNavigate,
    })
    const detail = render(ArticleView, { state: 'ready', article, onBack: handlers.onNavigate })
    const unsafe = render(ArticleView, {
      state: 'ready',
      article: { ...article, originalUrl: 'javascript:alert(1)' },
    })
    const insecure = render(ArticleView, {
      state: 'ready',
      article: { ...article, originalUrl: 'http://example.com/article-1' },
    })
    expect(empty).toContain('Chưa có bài đã lưu')
    expect(detail).toContain('Nguồn kiểm chứng')
    expect(detail).toContain('href="https://example.com/articles/article-1"')
    expect(detail).toContain('rel="noopener noreferrer external"')
    expect(unsafe).not.toContain('javascript:')
    expect(insecure).not.toContain('http://example.com/article-1')
  })

  it('renders grounded Q&A and account controls from props without inventing sessions or credentials', () => {
    const qa = render(QaView, { sessions: [], state: 'empty', onAsk: handlers.onSubmit })
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: ['AI'] },
      onSavePreferences: handlers.onSubmit,
    })
    expect(qa).toContain('Hỏi đáp có nguồn')
    expect(qa).toContain('id="public-qa-question"')
    expect(account).toContain('Cài đặt tài khoản')
    expect(account).toContain('reader@example.com')
    expect(account).toContain('Yêu cầu xóa tài khoản')
    expect(account).not.toMatch(/password123|admin@|demo/i)
  })

  it('selects landing or reader composition from session state and never treats a guest as authenticated', () => {
    const landing = render(PublicApp, {
      session: { status: 'ready', user: null },
      auth: { onSubmit: handlers.onSubmit },
    })
    const reader = render(PublicApp, {
      session: { status: 'ready', user: { id: 'u-1', role: 'user' } },
      route: 'feed',
      feed: { state: 'ready', articles: [article] },
    })
    expect(landing).toContain('Nắm nhanh công nghệ.')
    expect(landing).toContain('Tiếp tục như khách →')
    expect(landing).not.toContain('Bài đã lưu')
    expect(reader).toContain('Feed công nghệ')
    expect(reader).toContain(article.titleVi)
    expect(reader).not.toMatch(/tiếp tục như khách|user@techpulse|password123/i)
  })

  it('renders an allowed lead image in the artifact-compatible media frame', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [
        {
          ...article,
          id: 'article-with-image',
          leadMedia: {
            type: 'image',
            displayMode: 'remote-preview',
            url: 'https://cdn.example.com/article-image.jpg',
          },
        },
      ],
      handlers,
    })
    expect(html).toContain('class="public-card-media-figure"')
    expect(html).toContain('class="public-card-media"')
    expect(html).toContain('src="https://cdn.example.com/article-image.jpg"')
    expect(html).toContain('AI')
    expect(html).toContain('DevOps')
  })

  it('uses artifact topic labels for normalized API values', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [{ ...article, topics: ['devops', 'dữ liệu'] }],
      handlers,
    })

    expect(html).toContain('>DevOps</span>')
    expect(html).toContain('>Dữ liệu</span>')
  })
})
