import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  AccountView,
  ArticleView,
  FeedView,
  QaView,
  ReaderShell,
  SavedView,
  SearchView,
} from '../../../client/features/public/index.js'
import {
  ArticleCard,
  ErrorState,
  FilterField,
  MediaImage,
  PageHeading,
  Pagination,
  Skeleton,
  StateCard,
  Summary,
} from '../../../client/features/public/components/reader-primitives.jsx'
import ThemeToggle from '../../../client/features/public/components/ThemeToggle.jsx'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))
const noop = vi.fn()

const baseArticle = {
  id: 'article-coverage',
  titleVi: 'Bài viết tiếng Việt',
  titleOriginal: 'Original article title',
  originalUrl: 'https://example.com/articles/coverage',
  source: { id: 'source-coverage', name: 'Coverage Source', domain: 'example.com' },
  sourceLanguage: 'en',
  publishedAt: '2026-08-20T08:00:00.000Z',
  topics: ['AI', 'devops'],
  summaryStatus: 'ready',
  summaryBasis: 'excerpt',
  summaryVi: 'Tóm tắt có thể kiểm chứng.',
  isSaved: false,
}

const handlers = {
  onBack: noop,
  onClear: noop,
  onClearFilters: noop,
  onClearSessions: noop,
  onFilterChange: noop,
  onNavigate: noop,
  onNextPage: noop,
  onOpenArticle: noop,
  onOpenSearch: noop,
  onPreviousPage: noop,
  onRetry: noop,
  onSaveToggle: noop,
  onScopeChange: noop,
  onSelectSession: noop,
  onSubmit: noop,
  onToggleTopic: noop,
}

describe('public coverage states', () => {
  it('covers primitive success, empty, error, pagination and summary branches', () => {
    expect(render(PageHeading, { id: 'heading', eyebrow: 'Eyebrow', title: 'Title' })).toContain(
      'Title',
    )
    expect(
      render(PageHeading, { id: 'heading', eyebrow: 'Eyebrow', title: 'Title', copy: 'Copy' }),
    ).toContain('Copy')
    expect(render(StateCard, { title: 'Empty' })).toContain('Empty')
    expect(
      render(StateCard, {
        title: 'With action',
        copy: 'Copy',
        action: React.createElement('button', null, 'Action'),
      }),
    ).toContain('Action')

    const errorWithRequest = render(ErrorState, {
      title: 'Error',
      error: { message: 'Request failed', requestId: 'request-coverage' },
      onRetry: noop,
    })
    const errorWithoutRetry = render(ErrorState, { title: 'Error', error: 'Plain error' })
    expect(errorWithRequest).toContain('Mã yêu cầu: request-coverage')
    expect(errorWithRequest).toContain('Thử lại')
    expect(errorWithoutRetry).toContain('Plain error')
    expect(errorWithoutRetry).not.toContain('Mã yêu cầu')
    expect(render(Skeleton, { label: 'Loading label' })).toContain('Loading label')
    expect(
      render(FilterField, { id: 'filter', label: 'Filter', value: '', error: 'Invalid value' }),
    ).toContain('Invalid value')

    expect(render(Pagination, { page: 1, hasNext: false })).toBe('')
    const numbered = render(Pagination, {
      page: 2,
      hasNext: true,
      totalPages: 20,
      maxPage: 10,
      canGoPrevious: false,
      label: 'Coverage pagination',
    })
    const cursorPagination = render(Pagination, {
      page: 2,
      hasNext: true,
      label: 'Cursor pagination',
    })
    expect(numbered).toContain('Trang 2/20')
    expect(numbered).toContain('Trang trung gian tối đa 10')
    expect(cursorPagination).toContain('Trang 2')
    expect(cursorPagination).not.toContain('Trang 2/')

    expect(render(Summary, { article: { summaryStatus: 'pending' } })).toContain('Đang tạo tóm tắt')
    expect(render(Summary, { article: { summaryStatus: 'processing' } })).toContain(
      'Đang tạo tóm tắt',
    )
    expect(
      render(Summary, {
        article: { summaryStatus: 'ready', summaryVi: 'Excerpt summary', summaryBasis: 'excerpt' },
      }),
    ).toContain('đoạn trích nguồn')
    expect(
      render(Summary, {
        article: {
          summaryStatus: 'ready',
          summaryVi: 'Metadata summary',
          summaryBasis: 'metadata',
        },
      }),
    ).toContain('metadata nguồn')
    expect(
      render(Summary, { article: { summaryStatus: 'ready', summaryVi: 'Other summary' } }),
    ).toContain('AI tổng hợp</span>')
    expect(render(Summary, { article: { summaryStatus: 'failed' } })).toBe('')
  })

  it('covers media and article-card variants without exposing unsafe URLs', () => {
    expect(render(MediaImage, { fallbackLabel: 'Fallback image' })).toContain('Fallback image')
    expect(
      render(MediaImage, { src: 'https://cdn.example.com/image.jpg', alt: 'Alt text' }),
    ).toContain('src="https://cdn.example.com/image.jpg"')

    const image = render(ArticleCard, {
      article: {
        ...baseArticle,
        leadMedia: {
          type: 'image',
          displayMode: 'remote-preview',
          url: 'https://cdn.example.com/image.jpg',
          allowedHosts: ['cdn.example.com'],
          altText: 'Article image',
          attribution: 'Image attribution',
        },
      },
      savedOverride: true,
      busy: true,
      onOpenArticle: noop,
      onSaveToggle: noop,
    })
    const video = render(ArticleCard, {
      article: {
        ...baseArticle,
        topics: [],
        leadMedia: {
          type: 'video',
          displayMode: 'link-only',
          sourcePageUrl: 'https://video.example.com/watch/1',
        },
      },
      onOpenArticle: noop,
      onSaveToggle: noop,
    })
    const unsafeVideo = render(ArticleCard, {
      article: {
        ...baseArticle,
        leadMedia: {
          type: 'video',
          displayMode: 'link-only',
          sourcePageUrl: 'javascript:alert(1)',
        },
      },
    })
    const placeholder = render(ArticleCard, {
      article: { ...baseArticle, titleOriginal: null, leadMedia: null, topics: null },
    })
    const saved = render(ArticleCard, { article: baseArticle, savedOverride: true })

    expect(image).toContain('Image attribution')
    expect(image).toContain('Đang cập nhật...')
    expect(saved).toContain('Bỏ lưu bài')
    expect(video).toContain('Mở video nguồn')
    expect(video).toContain('Video nguồn chưa được AI phân tích.')
    expect(unsafeVideo).not.toContain('javascript:')
    expect(placeholder).toContain('public-card-media-placeholder')
    expect(placeholder).not.toContain('Original article title')
  })

  it('covers feed, search and saved view state combinations', () => {
    const feedEmpty = render(FeedView, { state: 'ready', articles: [], handlers })
    const filteredEmpty = render(FeedView, {
      state: 'ready',
      articles: [],
      filters: { topic: 'AI' },
      applying: true,
      errors: { topic: 'Topic error' },
      handlers,
    })
    const feedError = render(FeedView, {
      state: 'error',
      error: { message: 'Feed failed' },
      handlers,
    })
    const feedReady = render(FeedView, {
      state: 'ready',
      articles: [baseArticle],
      sources: [{ id: 'source-coverage', name: 'Coverage Source' }, { id: 'source-2' }],
      savedOverrides: { [baseArticle.id]: true },
      pendingArticleId: baseArticle.id,
      handlers,
    })

    const searchInitial = render(SearchView, { state: 'initial', handlers })
    const searchLoading = render(SearchView, { state: 'loading', handlers })
    const searchError = render(SearchView, { state: 'error', error: 'Search failed', handlers })
    const searchEmpty = render(SearchView, {
      state: 'ready',
      results: [],
      meta: { effectiveMode: 'text' },
      handlers,
    })
    const searchReady = render(SearchView, {
      state: 'ready',
      query: { q: 'AI', mode: 'text', topic: 'devops' },
      results: [{ article: baseArticle }, { ...baseArticle, id: 'article-direct' }],
      meta: { effectiveMode: 'text', fallbackUsed: false, hasNext: true },
      handlers,
    })
    const searchFallback = render(SearchView, {
      state: 'ready',
      meta: { fallbackUsed: true },
      handlers,
    })

    const savedLoading = render(SavedView, { state: 'loading', handlers })
    const savedError = render(SavedView, {
      state: 'error',
      error: { message: 'Saved failed' },
      handlers,
    })
    const savedClear = render(SavedView, {
      state: 'ready',
      articles: [baseArticle],
      clearOpen: true,
      handlers,
    })

    expect(feedEmpty).toContain('Chưa có bài đã xuất bản')
    expect(filteredEmpty).toContain('Xóa một vài bộ lọc')
    expect(filteredEmpty).toContain('Topic error')
    expect(feedError).toContain('Feed failed')
    expect(feedReady).toContain('Coverage Source')
    expect(filteredEmpty).toContain('Đặt lại')
    expect(searchInitial).toContain('Nhập từ khóa để bắt đầu')
    expect(searchLoading).toContain('Đang tìm bài')
    expect(searchError).toContain('Search failed')
    expect(searchEmpty).toContain('Không tìm thấy bài phù hợp')
    expect(searchReady).toContain('Tìm kiếm văn bản')
    expect(searchReady).toContain('Bài viết tiếng Việt')
    expect(searchFallback).toContain('Chỉ mục ngữ nghĩa tạm thời chưa sẵn sàng')
    expect(savedLoading).toContain('aria-busy="true"')
    expect(savedError).toContain('Saved failed')
    expect(savedClear).toContain('Xóa tất cả bài đã lưu?')
    expect(savedClear).toContain('Xác nhận')
  })

  it('covers article, account and reader-shell variants', () => {
    const articleLoading = render(ArticleView, { state: 'loading' })
    const articleError = render(ArticleView, {
      state: 'error',
      error: 'Article failed',
      onBack: noop,
    })
    const articleMissing = render(ArticleView, { state: 'ready', article: null, onBack: noop })
    const articleDetailed = render(ArticleView, {
      state: 'ready',
      article: {
        ...baseArticle,
        sourceLanguage: null,
        originalUrl: null,
        summaryDetailStatus: 'ready',
        summaryParagraphsVi: [
          '  Đoạn một.  ',
          '',
          'Đoạn hai.',
          'Đoạn ba.',
          'Đoạn bốn.',
          'Đoạn năm.',
          'Đoạn sáu.',
        ],
        aiDisclosure: 'Nội dung AI có giới hạn.',
        leadMedia: {
          type: 'image',
          displayMode: 'remote-preview',
          url: 'https://cdn.example.com/detail.jpg',
          allowedHosts: ['cdn.example.com'],
          attribution: 'Detail attribution',
        },
      },
      onBack: noop,
      onOpenSource: noop,
    })
    const articlePending = render(ArticleView, {
      state: 'ready',
      article: {
        ...baseArticle,
        summaryStatus: 'ready',
        summaryDetailStatus: 'pending',
        summaryParagraphsVi: ['one'],
      },
    })
    const articleFailedSummary = render(ArticleView, {
      state: 'ready',
      article: {
        ...baseArticle,
        summaryStatus: 'ready',
        summaryDetailStatus: 'failed',
        summaryParagraphsVi: [],
      },
    })
    const articleProcessing = render(ArticleView, {
      state: 'ready',
      article: {
        ...baseArticle,
        summaryStatus: 'processing',
        summaryDetailStatus: 'processing',
        leadMedia: {
          type: 'video',
          displayMode: 'link-only',
          sourcePageUrl: 'https://video.example.com/watch/2',
          attribution: 'Video attribution',
        },
      },
    })

    const account = render(AccountView, {
      user: { email: 'reader@example.com', topicPreferences: ['AI'] },
      topics: ['AI', 'Cloud'],
      notice: 'Saved',
      error: { message: 'Account warning' },
      saving: true,
      deleting: true,
      onLogout: noop,
      onToggleTopic: noop,
      onSavePreferences: noop,
      onRequestDeletion: noop,
    })
    const accountDefaults = render(AccountView, { user: null, topics: null })
    const reader = render(ReaderShell, {
      route: 'missing-route',
      theme: 'dark',
      onNavigate: noop,
      onThemeToggle: noop,
      onBrandClick: noop,
      onLogout: noop,
      children: React.createElement('p', null, 'Reader content'),
    })
    const themeDark = render(ThemeToggle, { theme: 'dark', onToggle: noop })
    const themeLight = render(ThemeToggle, { theme: 'light', onToggle: noop })

    expect(articleLoading).toContain('Đang tải bài viết')
    expect(articleError).toContain('Article failed')
    expect(articleMissing).toContain('Chưa chọn bài viết')
    expect(articleDetailed).toContain('Đoạn năm.')
    expect(articleDetailed).not.toContain('Đoạn sáu.')
    expect(articleDetailed).toContain('Nội dung AI có giới hạn.')
    expect(articleDetailed).toContain('Detail attribution')
    expect(articleDetailed).toContain('Liên kết bài gốc không khả dụng.')
    expect(articlePending).toContain('Đang tạo tóm tắt chi tiết.')
    expect(articleFailedSummary).toContain('Tóm tắt chi tiết chưa khả dụng.')
    expect(articleProcessing).toContain('Mở video nguồn')
    expect(articleProcessing).toContain('Tóm tắt đang được tạo.')
    expect(account).toContain('Đang lưu...')
    expect(account).toContain('Đang gửi...')
    expect(account).toContain('Account warning')
    expect(accountDefaults).toContain('Cài đặt tài khoản')
    expect(reader).toContain('Reader content')
    expect(reader).toContain('data-theme="dark"')
    expect(themeDark).toContain('Sáng')
    expect(themeLight).toContain('Tối')
  })

  it('covers Q&A history, message, citation and confirmation states', () => {
    const citation = {
      id: 'citation-1',
      sourceName: 'Citation Source',
      titleOriginal: 'Citation title',
      originalUrl: 'https://example.com/citation',
      publishedAt: '2026-08-19T08:00:00.000Z',
      sourceLanguage: 'en',
      author: 'Author',
    }
    const sessions = [
      { id: 'session-1', title: '', messageCount: 2 },
      { id: 'session-2', title: 'Named', messageCount: 0 },
    ]
    const ready = render(QaView, {
      state: 'ready',
      sessions,
      scope: { sessionId: 'session-1', topics: ['AI'], articleId: 'article-1' },
      topics: ['AI', 'Cloud'],
      messages: [
        { id: 'user-message', role: 'user', text: 'Câu hỏi' },
        {
          id: 'assistant-message',
          role: 'assistant',
          paragraphs: [{ text: 'Trả lời', citationIds: ['citation-1', 'missing'] }],
          citations: [citation],
        },
        {
          id: 'refused-message',
          role: 'assistant',
          status: 'refused',
          refusalReason: 'policy-blocked',
          paragraphs: [],
        },
        { role: 'assistant', status: 'refused', refusalReason: 'unknown', paragraphs: [] },
      ],
      handlers,
    })
    const empty = render(QaView, { state: 'empty', sessions: [], handlers })
    const nullScope = render(QaView, { state: 'empty', scope: null, sessions: [], handlers })
    const loading = render(QaView, { state: 'loading', handlers })
    const error = render(QaView, {
      state: 'error',
      error: { message: 'Q&A failed', requestId: 'qa-request' },
      handlers,
    })

    expect(ready).toContain('Phiên hỏi đáp')
    expect(ready).toContain('Named')
    expect(ready).toContain('Trả lời')
    expect(ready).toContain('Citation Source')
    expect(ready).toContain('Câu hỏi này nằm ngoài phạm vi hỗ trợ.')
    expect(ready).toContain('Câu hỏi bị từ chối an toàn.')
    expect(empty).toContain('Bắt đầu một câu hỏi')
    expect(empty).toContain('Chưa có phiên hỏi đáp.')
    expect(empty).toContain('Chọn ít nhất một chủ đề, nhập ID bài viết hoặc cung cấp đủ hai mốc thời gian trước khi hỏi.')
    expect(empty).toContain('Từ ngày')
    expect(empty).toContain('Đến ngày')
    expect(empty).toContain('Nhấn Enter để gửi')
    expect(empty).toContain('Shift+Enter để xuống dòng')
    expect(nullScope).toContain('Chọn ít nhất một chủ đề, nhập ID bài viết hoặc cung cấp đủ hai mốc thời gian trước khi hỏi.')
    expect(loading).toContain('Đang truy xuất nguồn')
    expect(error).toContain('Q&amp;A failed')
  })
})
