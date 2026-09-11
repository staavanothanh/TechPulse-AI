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
function createMountedRunner(component) {
  let hookIndex = 0
  const hooks = []
  const effectCleanups = []
  let currentProps
  let latestResult
  let pendingEffects = []
  let rendering = false
  let rerenderPending = false
  let disposed = false

  const depsChanged = (previous, next) => (
    !previous || !next || !previous.deps || previous.deps.length !== next.length
      || previous.deps.some((value, index) => !Object.is(value, next[index]))
  )
  const dispatcher = {
    useState(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        const value = typeof next === 'function' ? next(hooks[index]) : next
        if (Object.is(value, hooks[index])) return
        hooks[index] = value
        rerenderPending = true
        if (!rendering) render()
      }
      return [hooks[index], setState]
    },
    useRef(initial) {
      const index = hookIndex++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useCallback(fn, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      if (previous && !depsChanged(previous, deps)) return previous.fn
      hooks[index] = { fn, deps }
      return fn
    },
    useMemo(fn, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      if (previous && !depsChanged(previous, deps)) return previous.value
      const value = fn()
      hooks[index] = { value, deps }
      return value
    },
    useEffect(effect, deps) {
      const index = hookIndex++
      const previous = hooks[index]
      hooks[index] = { effect, deps }
      if (depsChanged(previous, deps)) pendingEffects.push({ index, effect })
    },
  }

  function render(props = currentProps) {
    if (disposed) return latestResult
    currentProps = props
    if (rendering) {
      rerenderPending = true
      return latestResult
    }
    rendering = true
    try {
      do {
        rerenderPending = false
        hookIndex = 0
        pendingEffects = []
        const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
        const previousDispatcher = internals.H
        internals.H = dispatcher
        try {
          latestResult = component(currentProps)
        } finally {
          internals.H = previousDispatcher
        }
        for (const { index, effect } of pendingEffects) {
          if (typeof effectCleanups[index] === 'function') effectCleanups[index]()
          const cleanup = effect()
          effectCleanups[index] = typeof cleanup === 'function' ? cleanup : undefined
        }
      } while (rerenderPending)
    } finally {
      rendering = false
    }
    return latestResult
  }

  function unmount() {
    if (disposed) return
    disposed = true
    for (const cleanup of effectCleanups) {
      if (typeof cleanup === 'function') cleanup()
    }
  }

  return { render, unmount, get current() { return latestResult } }
}

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate)
      if (match) return match
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  return findElement(node.props?.children, predicate)
}

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
  it('opens the password-success dialog when its mounted signal transitions true and keeps logout semantics intact', () => {
    const previousDocument = globalThis.document
    const previousSetInterval = globalThis.setInterval
    const previousClearInterval = globalThis.clearInterval
    const fakeDocument = {
      activeElement: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }
    const onLogout = vi.fn()
    const baseProps = {
      user: { id: 'u-password', email: 'reader@example.test', role: 'user', topicPreferences: [], hasPassword: true },
      onChangePassword: vi.fn(),
      onLogout,
      initialPasswordSuccessOpen: false,
    }
    const runner = createMountedRunner(AccountView)
    globalThis.document = fakeDocument
    globalThis.setInterval = vi.fn(() => 1)
    globalThis.clearInterval = vi.fn()
    try {
      runner.render(baseProps)
      expect(findElement(runner.current, (element) => element.props?.role === 'dialog')).toBeNull()

      runner.render({ ...baseProps, initialPasswordSuccessOpen: true })
      const dialog = findElement(
        runner.current,
        (element) => element.props?.role === 'dialog' && element.props?.['aria-labelledby'] === 'public-password-success-title',
      )
      expect(dialog).not.toBeNull()
      const logoutButton = findElement(dialog, (element) => element.type === 'button' && element.props?.className === 'public-btn public-btn-primary')
      expect(logoutButton).not.toBeNull()

      logoutButton.props.onClick()

      expect(onLogout).toHaveBeenCalledTimes(1)
      expect(onLogout).toHaveBeenCalledWith('Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.')
      expect(findElement(runner.current, (element) => element.props?.role === 'dialog')).toBeNull()

      runner.render({ ...baseProps, initialPasswordSuccessOpen: true })
      expect(findElement(runner.current, (element) => element.props?.role === 'dialog')).toBeNull()
    } finally {
      runner.unmount()
      if (previousDocument === undefined) delete globalThis.document
      else globalThis.document = previousDocument
      globalThis.setInterval = previousSetInterval
      globalThis.clearInterval = previousClearInterval
    }
  })

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

  it('renders login form by default in AuthPanel and provides login action', () => {
    const html = render(AuthPanel, { onSubmit: handlers.onSubmit })
    expect(html).toContain('Đăng nhập')
    expect(html).not.toContain('Tạo tài khoản mới')
    expect(html).toContain('autoComplete="current-password"')
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

  it('renders numbered feed pagination from totalItems without exposing the opaque cursor', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [article],
      page: 2,
      meta: { hasNext: true, nextCursor: 'opaque-feed-cursor', totalItems: 35 },
      handlers,
    })

    expect(html).toContain('Trang 2/4')
    expect(html).toContain('>Đầu</button>')
    expect(html).toContain('>Cuối</button>')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="2"')
    expect(html).not.toContain('opaque-feed-cursor')
  })

  it('explains the safe intermediate-page limit while keeping the final-page shortcut', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [article],
      page: 1,
      meta: { hasNext: true, nextCursor: 'opaque-feed-cursor', totalItems: 200000 },
      handlers,
    })

    expect(html).toContain('Trang trung gian tối đa 10000; dùng Đầu hoặc Cuối để di chuyển nhanh.')
    expect(html).toContain('aria-describedby="phân-trang-feed-page-limit"')
  })

  it('does not expose an unsupported previous-page request after a deep final-page jump', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [article],
      page: 20_000,
      meta: { hasNext: false, nextCursor: null, totalItems: 200000 },
      handlers,
    })

    expect(html).toMatch(/disabled=""[^>]*>Trước<\/button>/)
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
  it('sanitizes saved source CTA to canonical originalUrl only', () => {
    const safeRunner = createMountedRunner(SavedView)
    const unsafeRunner = createMountedRunner(SavedView)
    try {
      safeRunner.render({ state: 'ready', articles: [article], handlers: {} })
      const safeSaved = renderToStaticMarkup(safeRunner.current)
      expect(safeSaved).toContain('href="https://example.com/articles/article-1"')

      unsafeRunner.render({
        state: 'ready',
        articles: [{ ...article, originalUrl: 'javascript:alert(1)', url: 'https://attacker.example/legacy' }],
        handlers: {},
      })
      const unsafeSaved = renderToStaticMarkup(unsafeRunner.current)
      expect(unsafeSaved).not.toContain('javascript:')
      expect(unsafeSaved).not.toContain('attacker.example')
      expect(unsafeSaved).not.toContain('href="#"')
      expect(unsafeSaved).toContain('Xem chi tiết bài viết')
    } finally {
      safeRunner.unmount()
      unsafeRunner.unmount()
    }
  })

  it('keeps saved pagination reachable when a later page is empty', () => {
    const html = render(SavedView, {
      state: 'ready',
      articles: [],
      meta: { hasNext: false, nextCursor: null, page: 2 },
      handlers,
    })
    expect(html).toContain('aria-label="Phân trang bài đã lưu"')
    expect(html).toContain('Trang này không còn bài viết')
    expect(html).not.toContain('Chưa có bài đã lưu')
  })

  it('shows a page-scoped indicator instead of an invented saved quota', () => {
    const first = render(SavedView, { state: 'ready', articles: [article], meta: { page: 1 }, handlers })
    const second = render(SavedView, {
      state: 'ready',
      articles: [{ ...article, id: 'article-2' }],
      meta: { page: 2, hasNext: true, nextCursor: 'cursor-2' },
      handlers,
    })
    expect(first).toContain('Trang 1')
    expect(second).toContain('Trang 2')
    expect(first).not.toMatch(/\d+\/20/)
  })

  it('makes saved list entries keyboard selectable', () => {
    const runner = createMountedRunner(SavedView)
    try {
      runner.render({ state: 'ready', articles: [article, { ...article, id: 'article-2' }], handlers })
      const row = findElement(
        runner.current,
        (element) => element.props?.role === 'listitem' && element.props?.tabIndex === 0,
      )
      expect(row).not.toBeNull()
      row.props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
      const selected = findElement(runner.current, (element) => element.props?.['aria-current'] === 'true')
      expect(selected).not.toBeNull()

      const nestedEvent = { key: 'Enter', target: {}, currentTarget: {}, preventDefault: vi.fn() }
      nestedEvent.currentTarget = { nested: true }
      row.props.onKeyDown(nestedEvent)
      expect(nestedEvent.preventDefault).not.toHaveBeenCalled()
    } finally {
      runner.unmount()
    }
  })

  it('suppresses saved summary text until the artifact status is ready', () => {
    const pending = createMountedRunner(SavedView)
    const ready = createMountedRunner(SavedView)
    try {
      pending.render({
        state: 'ready',
        articles: [{ ...article, summaryStatus: 'pending', summaryVi: 'Tóm tắt chưa sẵn sàng.' }],
        handlers: {},
      })
      const pendingHtml = renderToStaticMarkup(pending.current)
      expect(pendingHtml).not.toContain('Tóm tắt chưa sẵn sàng.')
      expect(pendingHtml).toContain('chưa có đủ thông tin để tóm tắt chi tiết')

      ready.render({ state: 'ready', articles: [article], handlers: {} })
      const readyHtml = renderToStaticMarkup(ready.current)
      expect(readyHtml).toContain(article.summaryVi)
    } finally {
      pending.unmount()
      ready.unmount()
    }
  })

  it('renders the topic filter and offers a reset when only the topic filter is applied', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [],
      filters: { topic: 'AI' },
      handlers,
    })
    expect(html).toContain('id="public-feed-topic"')
    expect(html).toContain('value="AI"')
    expect(html).toContain('Xóa bộ lọc')
  })

  it('groups canonical source options under connector labels using server-valid ObjectId values', () => {
    const html = render(FeedView, { state: 'ready', articles: [], handlers })
    expect(html).toContain('label="RSS Feeds"')
    expect(html).toContain('label="arXiv"')
    const optionValues = [...html.matchAll(/<option value="([^"]+)"/g)]
      .map((match) => match[1])
      .filter(Boolean)
    expect(optionValues.length).toBeGreaterThan(0)
    for (const value of optionValues) expect(value).toMatch(/^[0-9a-f]{24}$/)
  })

  it('keeps pagination reachable when the current feed page is empty', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [],
      page: 2,
      meta: { hasNext: false, nextCursor: null, totalItems: 20 },
      handlers,
    })
    expect(html).toContain('aria-label="Phân trang feed"')
    expect(html).toMatch(/>Trước<\/button>/)
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

  it('routes an authenticated reader to the donation view', () => {
    const html = render(PublicApp, {
      session: { status: 'ready', user: { id: 'u-1', role: 'user' } },
      route: 'donate',
    })
    expect(html).toContain('Ủng hộ TechPulse-AI')
    expect(html).toContain('Mã QR VietQR để ủng hộ TechPulse-AI')
    expect(html).toContain('MB Bank')
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
  it('renders all eight product domains in AccountView and activates buttons for old aliases', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: ['AI', 'Robot', 'Security', 'CustomTopic'] },
      onSavePreferences: handlers.onSubmit,
    })

    // All 8 parent domains should be present
    expect(account).toContain('AI')
    expect(account).toContain('AI Agent')
    expect(account).toContain('Robotics')
    expect(account).toContain('Software Engineering')
    expect(account).toContain('DevOps')
    expect(account).toContain('Bảo mật')
    expect(account).toContain('Dữ liệu')
    expect(account).toContain('Blockchain')

    // 'Robot' should activate 'Robotics', 'Security' should activate 'Bảo mật', 'AI' should activate 'AI'
    expect(account).toMatch(/aria-pressed="true"[^>]*>Robotics/)
    expect(account).toMatch(/aria-pressed="true"[^>]*>Bảo mật/)
    expect(account).toMatch(/aria-pressed="true"[^>]*>AI/)
  })
  it('renders all 22 active topics across 8 product domains, search input and selection counter in AccountView', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: ['Học máy', 'Container & Kubernetes'] },
      onSavePreferences: handlers.onSubmit,
    })

    // Tất cả 8 nhóm lĩnh vực hiển thị
    expect(account).toContain('AI &amp; Machine Learning')
    expect(account).toContain('AI Agent &amp; Hệ thống tự hành')
    expect(account).toContain('Robotics &amp; Tự động hóa')
    expect(account).toContain('Kỹ thuật phần mềm &amp; Lập trình')
    expect(account).toContain('DevOps &amp; Điện toán đám mây')
    expect(account).toContain('An ninh mạng &amp; Bảo mật')
    expect(account).toContain('Khoa học máy tính &amp; Dữ liệu')
    expect(account).toContain('Công nghệ mới nổi &amp; Web3')

    // Tất cả 14 chủ đề con (leaf topics) đều có mặt
    expect(account).toContain('Học máy')
    expect(account).toContain('Học sâu &amp; LLM')
    expect(account).toContain('Hệ thống Agentic')
    expect(account).toContain('Điều khiển Robot')
    expect(account).toContain('JavaScript')
    expect(account).toContain('Kiến trúc hệ thống')
    expect(account).toContain('Hạ tầng Cloud &amp; SRE')
    expect(account).toContain('Container &amp; Kubernetes')
    expect(account).toContain('Bảo mật ứng dụng')
    expect(account).toContain('Mật mã học &amp; Quyền riêng tư')
    expect(account).toContain('Cơ sở dữ liệu')
    expect(account).toContain('Kỹ nghệ dữ liệu')
    expect(account).toContain('Blockchain &amp; Web3')
    expect(account).toContain('Điện toán lượng tử')

    // Chủ đề con được kích hoạt độc lập, không kích hoạt chủ đề cha
    expect(account).toMatch(/aria-pressed="true"[^>]*>Học máy/)
    expect(account).toMatch(/aria-pressed="true"[^>]*>Container &amp; Kubernetes/)
    expect(account).toMatch(/aria-pressed="false"[^>]*>AI<span/)
    expect(account).toMatch(/aria-pressed="false"[^>]*>DevOps<span/)

    // Thanh công cụ, bộ đếm và ô tìm kiếm
    expect(account).toContain('Đã chọn:')
    expect(account).toContain('Tìm trong 22 chủ đề...')
    expect(account).toContain('Bỏ chọn hết')
  })
  it('hides the change-password form behind an activate button by default in AccountView', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: [], hasPassword: true },
      onChangePassword: handlers.onSubmit,
    })
    expect(account).toContain('Đổi mật khẩu')
    expect(account).not.toContain('id="account-current-password"')
    expect(account).not.toContain('id="account-new-password"')
    expect(account).not.toContain('id="account-confirm-password"')
  })
  it('renders the change-password form with a current-password field for accounts that already have a password', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: [], hasPassword: true },
      onChangePassword: handlers.onSubmit,
      initialPasswordOpen: true,
    })
    expect(account).toContain('Đổi mật khẩu')
    expect(account).toContain('id="account-current-password"')
    expect(account).toContain('id="account-new-password"')
    expect(account).toContain('id="account-confirm-password"')
    expect(account).toContain('autoComplete="current-password"')
    expect(account).toContain('class="public-input"')
    expect(account).toContain('Xác nhận')
    expect(account).toContain('Hủy')
    expect(account).not.toContain('đăng nhập bằng Google')

    // Dữ liệu cũ không có hasPassword → mặc định an toàn vẫn yêu cầu mật khẩu hiện tại
    const legacy = render(AccountView, {
      user: { id: 'u-2', email: 'legacy@example.com', role: 'user', topicPreferences: [] },
      onChangePassword: handlers.onSubmit,
      initialPasswordOpen: true,
    })
    expect(legacy).toContain('id="account-current-password"')
  })
  it('omits change-password and delete-account sections in AccountView for Google OAuth accounts', () => {
    const account = render(AccountView, {
      user: { id: 'u-3', email: 'google@example.com', role: 'user', topicPreferences: [], hasPassword: false },
      onChangePassword: handlers.onSubmit,
      onRequestDeletion: handlers.onSubmit,
      initialPasswordOpen: true,
      initialDeletionOpen: true,
    })
    // Không hiển thị thẻ đổi/đặt mật khẩu
    expect(account).not.toContain('Đổi mật khẩu')
    expect(account).not.toContain('Đặt mật khẩu')
    expect(account).not.toContain('public-account-security')
    expect(account).not.toContain('id="account-current-password"')
    expect(account).not.toContain('id="account-new-password"')
    expect(account).not.toContain('id="account-confirm-password"')

    // Không hiển thị thẻ xóa tài khoản
    expect(account).not.toContain('Quản lý dữ liệu')
    expect(account).not.toContain('Yêu cầu xóa tài khoản')
    expect(account).not.toContain('public-danger-zone')
    expect(account).not.toContain('public-deletion-dialog')

    // Vẫn hiển thị đầy đủ quản lý chủ đề và thông tin tài khoản
    expect(account).toContain('Chủ đề quan tâm')
    expect(account).toContain('google@example.com')
    expect(account).toContain('Lưu chủ đề')
  })
  it('renders a success pop-up modal dialog with auto-logout countdown when password change succeeds', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: [], hasPassword: true },
      onChangePassword: handlers.onSubmit,
      initialPasswordSuccessOpen: true,
    })
    expect(account).toContain('role="dialog"')
    expect(account).toContain('Đổi mật khẩu thành công!')
    expect(account).toContain('Hệ thống sẽ tự động đăng xuất sau')
    expect(account).toContain('5 giây')
    expect(account).toContain('Đăng xuất ngay (5s)')
  })
  it('renders account deletion modal with email verification, risk agreement checkbox, and safety countdown', () => {
    const account = render(AccountView, {
      user: { id: 'u-1', email: 'reader@example.com', role: 'user', topicPreferences: [], hasPassword: true },
      onRequestDeletion: handlers.onSubmit,
      initialDeletionOpen: true,
    })
    expect(account).toContain('role="dialog"')
    expect(account).toContain('Yêu cầu xóa tài khoản?')
    expect(account).toContain('public-deletion-warning-box')
    expect(account).toContain('Cảnh báo quan trọng:')
    expect(account).toContain('reader@example.com')
    expect(account).toContain('id="account-deletion-email"')
    expect(account).toContain('id="account-deletion-risk-confirm"')
    expect(account).toContain('Tôi hiểu và đồng ý xóa vĩnh viễn tài khoản này')
    expect(account).toContain('Xác nhận xóa (5s)')
    expect(account).toMatch(/disabled=""[^>]*>Xác nhận xóa \(5s\)/)
  })
  it('marks Q&A topic buttons active when scope uses legacy aliases', () => {
    const html = render(QaView, {
      state: 'empty',
      scope: { topics: ['robot', 'security'] },
      topics: ['Robotics', 'Bảo mật'],
      onAsk: handlers.onSubmit,
    })
    expect(html).toMatch(/aria-pressed="true"[^>]*>Robotics/)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Bảo mật/)
  })
})
