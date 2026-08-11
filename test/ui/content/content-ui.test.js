import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ArticleCard from '../../../client/features/feed/ArticleCard.jsx'
import { FeedView } from '../../../client/features/feed/FeedScreen.jsx'
import { validateFeedFilters } from '../../../client/features/feed/feed-validation.js'
import { SearchView } from '../../../client/features/search/SearchScreen.jsx'
import { validateSearchInput } from '../../../client/features/search/search-validation.js'
import { ArticleDetailView } from '../../../client/features/article-detail/ArticleDetailScreen.jsx'
import LeadMediaView from '../../../client/features/article-detail/LeadMediaView.jsx'
import { SavedView } from '../../../client/features/saved/SavedScreen.jsx'
import ClearSavedDialog from '../../../client/features/saved/ClearSavedDialog.jsx'
import { focusTrapTarget } from '../../../client/features/saved/dialog-focus.js'
import ContentWorkspace from '../../../client/features/feed/ContentWorkspace.jsx'

const baseArticle = {
  id: '507f1f77bcf86cd799439011',
  titleOriginal: 'A very long original technology article title that must wrap safely',
  titleVi: 'Tiêu đề công nghệ tiếng Việt',
  source: { id: '507f1f77bcf86cd799439021', name: 'Tech Review', authorityTier: 'editorial' },
  publishedAt: '2026-08-10T08:00:00.000Z',
  sourceLanguage: 'en',
  topics: ['AI', 'Chip'],
  summaryVi: 'Bản tóm tắt đã sẵn sàng.',
  summaryStatus: 'ready',
  summaryBasis: 'metadata',
  leadMedia: null,
  isSaved: false,
}

const handlers = Object.freeze({ onRetry: vi.fn(), onSubmit: vi.fn(), onLoadMore: vi.fn(), onSaveToggle: vi.fn(), onOpenArticle: vi.fn(), onClear: vi.fn() })
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))

describe('Step 8 content UI', () => {
  it('renders summary copy only for ready and never exposes removed/internal state', () => {
    const ready = render(ArticleCard, { article: baseArticle, onSaveToggle: handlers.onSaveToggle })
    const pending = render(ArticleCard, { article: { ...baseArticle, summaryStatus: 'pending', summaryVi: null, summaryBasis: null }, onSaveToggle: handlers.onSaveToggle })
    const processing = render(ArticleCard, { article: { ...baseArticle, summaryStatus: 'processing', summaryVi: null, summaryBasis: null }, onSaveToggle: handlers.onSaveToggle })
    expect(ready).toContain('Bản tóm tắt đã sẵn sàng.')
    expect(ready).toContain('AI tổng hợp')
    expect(ready).toContain('Cơ sở: metadata nguồn')
    expect(ready).toContain('content-summary-ready')
    expect(pending).not.toContain('Bản tóm tắt đã sẵn sàng.')
    expect(pending).not.toContain('summaryBasis')
    expect(pending).not.toContain('removed')
    expect(processing).toContain('content-summary-processing')
    expect(processing).toContain('aria-busy="true"')
  })

  it('implements remote image, link-only video and owned fallback without unsafe embedding', () => {
    const image = render(LeadMediaView, { media: { type: 'image', displayMode: 'remote-preview', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: 'Một bảng mạch', credit: null, attribution: 'Tech Review', mediaEvidenceStatus: 'not-analyzed' } })
    const captionedImage = render(LeadMediaView, { media: { type: 'image', displayMode: 'remote-preview', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: null, credit: null, attribution: 'Tech Review', mediaEvidenceStatus: 'not-analyzed' } })
    const video = render(LeadMediaView, { media: { type: 'video', displayMode: 'link-only', url: 'https://video.example.com/file', sourcePageUrl: 'https://example.com/video', altText: null, credit: null, attribution: 'Tech Review', mediaEvidenceStatus: 'not-analyzed' } })
    const fallback = render(LeadMediaView, { media: null })
    const unsafe = render(LeadMediaView, { media: { type: 'image', displayMode: 'remote-preview', url: 'javascript:alert(1)', sourcePageUrl: 'https://example.com/article', altText: 'unsafe', credit: null, attribution: 'Unsafe', mediaEvidenceStatus: 'not-analyzed' } })
    expect(image).toContain('loading="lazy"')
    expect(image).toContain('referrerPolicy="no-referrer"')
    expect(image).toContain('Tech Review')
    expect(captionedImage).toContain('alt=""')
    expect(video).toContain('AI chưa phân tích video này')
    expect(video).toContain('rel="noopener noreferrer external"')
    expect(video).not.toMatch(/<iframe|<video/i)
    expect(fallback).toContain('TechPulse')
    expect(unsafe).not.toContain('javascript:')
  })

  it('covers feed skeleton, empty, error, success and opaque load-more states', () => {
    expect(render(FeedView, { state: 'loading', articles: [], filters: {}, handlers })).toContain('aria-busy="true"')
    expect(render(FeedView, { state: 'ready', articles: [], filters: { topic: 'AI' }, handlers })).toContain('Không có bài phù hợp')
    const error = render(FeedView, { state: 'error', articles: [], filters: { topic: 'AI' }, error: { status: 503, message: 'Unavailable', requestId: 'req_feed' }, handlers })
    expect(error).toContain('role="alert"')
    expect(error).toContain('req_feed')
    const success = render(FeedView, { state: 'ready', articles: [baseArticle], filters: {}, meta: { hasNext: true, nextCursor: 'opaque-secret-cursor' }, handlers })
    expect(success).toContain('Tải thêm bài')
    expect(success).not.toContain('opaque-secret-cursor')
    expect(success).not.toContain('429')
  })

  it('keeps the feed apply control visibly pending while filters are applying', () => {
    const html = render(FeedView, { state: 'loading', applying: true, articles: [], filters: { topic: 'AI' }, handlers })
    expect(html).toContain('Đang áp dụng…')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Đang áp dụng…<\/button>/)
  })

  it('keeps the article heading semantic and places the interactive title inside it', () => {
    const html = render(ArticleCard, { article: baseArticle, onSaveToggle: handlers.onSaveToggle, onOpenArticle: handlers.onOpenArticle })
    expect(html).toMatch(/<h2[^>]*><button[^>]*class="content-title-action"/)
    expect(html).not.toMatch(/<button[^>]*class="content-title-action"[^>]*><h2>/)
  })

  it('renders friendly search mode/fallback copy without score or transport debug values', () => {
    const html = render(SearchView, { state: 'ready', query: { q: 'AI', mode: 'hybrid' }, results: [{ article: baseArticle, score: 0.7, textScore: 0.7, semanticScore: null }], meta: { hasNext: false, nextCursor: null, requestedMode: 'hybrid', effectiveMode: 'text', fallbackUsed: true, fallbackReason: 'embedding-unavailable' }, handlers })
    expect(html).toContain('Chỉ mục ngữ nghĩa chưa sẵn sàng')
    expect(html).toContain('Kết quả văn bản vẫn đầy đủ')
    expect(html).not.toMatch(/requestedMode|effectiveMode|fallbackUsed|fallbackReason|score:|textScore|semanticScore/)
  })

  it('binds detail CTA and citation only to canonical HTTPS fields with safe external rel', () => {
    const detail = { ...baseArticle, originalUrl: 'https://example.com/article', author: 'Nguyễn An', retrievedAt: '2026-08-10T09:00:00.000Z', citation: { sourceId: baseArticle.source.id, sourceName: baseArticle.source.name, titleOriginal: baseArticle.titleOriginal, originalUrl: 'https://example.com/article', author: 'Nguyễn An', publishedAt: baseArticle.publishedAt, sourceLanguage: baseArticle.sourceLanguage }, aiDisclosure: 'AI tổng hợp; hãy kiểm chứng với nguồn gốc.' }
    const html = render(ArticleDetailView, { state: 'ready', article: detail, handlers })
    expect(html).toContain('href="https://example.com/article"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer external"')
    expect(html).toContain('Nguồn kiểm chứng')
    expect(html).toContain('content-verification-band')
    expect(html).toContain('Kiểm chứng với nguồn gốc')
    expect(html).not.toMatch(/rawHtml|fullText|providerPayload/)
  })

  it('renders saved cleanup-only empty/success states with no unavailable row inference', () => {
    const empty = render(SavedView, { state: 'ready', articles: [], handlers })
    const success = render(SavedView, { state: 'ready', articles: [{ ...baseArticle, isSaved: true }], meta: { hasNext: true, nextCursor: 'opaque-saved-cursor' }, handlers })
    expect(empty).toContain('Chưa có bài đã lưu')
    expect(empty).not.toMatch(/không còn khả dụng|unavailable/i)
    expect(success).toContain('Bỏ lưu bài này')
    expect(success).toContain('id="saved-list-status"')
    expect(success).toContain('role="region"')
    expect(success).toContain('Tải thêm bài đã lưu')
    expect(success).not.toContain('opaque-saved-cursor')
    expect(success).toContain('aria-busy="false"')
  })

  it('exposes a destructive dialog and deterministic focus trapping/return behavior', () => {
    const html = render(ClearSavedDialog, { open: true, busy: false, onCancel: vi.fn(), onConfirm: vi.fn() })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Xóa tất cả bài đã lưu?')
    const first = { id: 'first' }
    const last = { id: 'last' }
    expect(focusTrapTarget({ key: 'Tab', shiftKey: true, activeElement: first, focusables: [first, last] })).toBe(last)
    expect(focusTrapTarget({ key: 'Tab', shiftKey: false, activeElement: last, focusables: [first, last] })).toBe(first)
  })

  it('keeps clear-saved failures visible and cooldown-gated inside the dialog', () => {
    const html = render(SavedView, {
      state: 'ready',
      articles: [{ ...baseArticle, isSaved: true }],
      clearOpen: true,
      clearError: 'Không thể xóa danh sách đã lưu. Thử lại.',
      clearCooldown: 12,
      handlers,
    })
    expect(html).toContain('Không thể xóa danh sách đã lưu. Thử lại.')
    expect(html).toContain('Thử lại sau 12 giây')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Thử lại sau 12 giây<\/button>/)
  })

  it('keeps an unsave row disabled and relabelled for a bounded Retry-After cooldown', () => {
    const html = render(SavedView, {
      state: 'ready',
      articles: [{ ...baseArticle, isSaved: true }],
      unsaveCooldowns: { [baseArticle.id]: 17 },
      mutationError: 'Không thể bỏ lưu bài. Thử lại sau 17 giây.',
      handlers,
    })
    expect(html).toContain('Không thể bỏ lưu bài. Thử lại sau 17 giây.')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Thử lại sau 17 giây<\/button>/)
    expect(html).not.toContain('opaque-saved-cursor')
  })

  it('provides the Saved-list status region as the distinct post-unsave focus target', () => {
    const html = render(SavedView, {
      state: 'ready',
      articles: [{ ...baseArticle, isSaved: true }],
      savedListNotice: 'Đã bỏ lưu bài.',
      handlers,
    })
    expect(html).toMatch(/id="saved-list-status"[^>]*role="status"[^>]*tabindex="-1"/)
    expect(html).toContain('Đã bỏ lưu bài.')
  })

  it('bounds unsave Retry-After and focuses the Saved-list status target', async () => {
    const { focusSavedListStatus, savedMutationCooldownSeconds } = await import('../../../client/features/saved/saved-mutation.js')
    expect(savedMutationCooldownSeconds({ status: 429, retryAfter: 999_999 })).toBe(300)
    expect(savedMutationCooldownSeconds({ status: 429, retryAfter: 17 })).toBe(17)
    expect(savedMutationCooldownSeconds({ status: 429, retryAfter: 0 })).toBe(60)
    expect(savedMutationCooldownSeconds({ status: 503, retryAfter: 17 })).toBe(0)
    const focus = vi.fn()
    focusSavedListStatus({ current: { focus } })
    expect(focus).toHaveBeenCalledOnce()
  })

  it('validates query/filter boundaries before submit', () => {
    expect(validateFeedFilters({ topic: 'x'.repeat(65) })).toEqual(expect.objectContaining({ valid: false, firstInvalid: 'topic' }))
    expect(validateFeedFilters({ publishedAfter: '2026-08-12T00:00:00.000Z', publishedBefore: '2026-08-11T00:00:00.000Z' })).toEqual(expect.objectContaining({ valid: false, firstInvalid: 'publishedAfter' }))
    expect(validateSearchInput({ q: 'x', mode: 'text' })).toEqual(expect.objectContaining({ valid: false, firstInvalid: 'q' }))
    expect(validateSearchInput({ q: 'AI', mode: 'text' }).valid).toBe(true)
  })

  it('does not introduce a nested main landmark inside the application main', () => {
    const html = render(ContentWorkspace, { generatedApi: {}, route: 'feed' })
    expect(html).not.toMatch(/<main(?:\s|>)/)
    expect(html).toContain('id="content-workspace"')
  })
})
