import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FeedView } from '../../../client/features/public/views/FeedView.jsx'
import { SearchView } from '../../../client/features/public/views/SearchView.jsx'
import { QaView, CitationDrawer } from '../../../client/features/public/views/QaView.jsx'
import { ArticleView } from '../../../client/features/public/views/ArticleView.jsx'

const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props))
const noop = vi.fn()

const article = {
  id: 'article-flow-fix',
  titleVi: 'Bài viết kiểm thử luồng người dùng',
  titleOriginal: 'Public user-flow article',
  source: { id: 'source-flow', name: 'Nguồn luồng người dùng' },
  publishedAt: '2026-08-20T08:00:00.000Z',
  summaryStatus: 'ready',
  summaryVi: 'Tóm tắt kiểm thử.',
}

describe('public user-flow regressions', () => {
  it('renders source options from article source metadata when the source catalog is unavailable', () => {
    const html = render(FeedView, { state: 'ready', articles: [article] })

    expect(html).toContain('value="source-flow"')
    expect(html).toContain('Nguồn luồng người dùng')
  })

  it('renders the published-before search filter and preserves its value', () => {
    const html = render(SearchView, {
      query: { publishedBefore: '2026-08-31T23:59' },
    })

    expect(html).toContain('id="public-search-before"')
    expect(html).toContain('value="2026-08-31T23:59"')
  })

  it('keeps the Q&A composer bounded to questions of at least three characters', () => {
    const html = render(QaView, { state: 'ready', messages: [{ role: 'assistant', paragraphs: [{ text: 'Câu trả lời hiện tại.' }] }] })

    expect(html).toContain('minLength="3"')
  })

  it('offers retry from the article error state', () => {
    const html = render(ArticleView, {
      state: 'error',
      error: 'Article failed',
      onBack: noop,
      onRetry: noop,
    })

    expect(html).toContain('Article failed')
    expect(html).toContain('>Thử lại</button>')
  })

  it('announces save errors and exposes a retry action without replacing results', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [article],
      saveError: { message: 'Không thể lưu bài viết.' },
      handlers: { onSaveRetry: noop },
    })

    expect(html).toContain('role="alert"')
    expect(html).toContain('Không thể lưu bài viết.')
    expect(html).toContain('>Thử lại lưu bài</button>')
    expect(html).toContain(article.titleVi)
  })

  it('distinguishes an available historical citation when status metadata is present', () => {
    const html = render(CitationDrawer, {
      citation: {
        id: 'citation-history',
        status: 'available',
        articleId: 'article-flow-fix',
        sourceId: 'source-flow',
        sourceName: 'Nguồn lịch sử',
        titleOriginal: 'Historical source article',
        originalUrl: 'https://example.com/history',
        publishedAt: '2026-08-19T08:00:00.000Z',
      },
      onClose: noop,
    })

    expect(html).toContain('Citation lịch sử')
    expect(html).toContain('Nguồn còn khả dụng')
  })
})
