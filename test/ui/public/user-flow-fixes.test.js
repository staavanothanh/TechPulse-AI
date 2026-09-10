import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FeedView } from '../../../client/features/public/views/FeedView.jsx'
import { SearchView } from '../../../client/features/public/views/SearchView.jsx'
import { SavedView } from '../../../client/features/public/views/SavedView.jsx'
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

  it('renders the topic search filter as a select dropdown with active topics', () => {
    const html = render(SearchView, {
      query: { topic: 'AI' },
      topics: ['AI', 'Cloud', 'Security'],
    })

    expect(html).toContain('id="public-search-topic"')
    expect(html).toContain('<select')
    expect(html).toContain('Tất cả chủ đề')
    expect(html).toContain('value="ai-ml"')
    expect(html).toContain('DevOps')
  })

  it('renders the source search filter as a select dropdown with human-readable source names', () => {
    const html = render(SearchView, {
      query: { sourceId: 'source-flow' },
      sources: [{ id: 'source-flow', name: 'Nguồn kiểm thử' }],
    })

    expect(html).toContain('id="public-search-source"')
    expect(html).toContain('<select')
    expect(html).toContain('Tất cả nguồn')
    expect(html).toContain('value="source-flow"')
    expect(html).toContain('Nguồn kiểm thử')
  })

  it('renders source options in search from results when sources prop is empty', () => {
    const html = render(SearchView, {
      results: [{ article }],
    })

    expect(html).toContain('id="public-search-source"')
    expect(html).toContain('value="source-flow"')
    expect(html).toContain('Nguồn luồng người dùng')
  })
  it('announces topic and source filter errors on the replacement selects', () => {
    const html = render(SearchView, {
      errors: { topic: 'Chủ đề quá dài.', sourceId: 'Source ID quá dài.' },
    })

    expect(html).toContain('aria-describedby="public-search-topic-error"')
    expect(html).toContain('id="public-search-topic-error"')
    expect(html).toContain('Chủ đề quá dài.')
    expect(html).toContain('aria-describedby="public-search-source-error"')
    expect(html).toContain('id="public-search-source-error"')
    expect(html).toContain('Source ID quá dài.')
  })
  it('retains an active source filter when the cold search catalog and results are empty', () => {
    const html = render(SearchView, {
      query: { sourceId: 'source-missing' },
      sources: [],
      results: [],
    })

    expect(html).toContain('<option value="source-missing" selected="">source-missing</option>')
  })

  it('normalizes topic aliases and leaf ids to selected stable topic options', () => {
    const aliasHtml = render(SearchView, { query: { topic: 'ai' } })
    const leafHtml = render(SearchView, { query: { topic: 'machine-learning' } })

    expect(aliasHtml).toContain('<option value="ai-ml" selected="">AI</option>')
    expect(leafHtml).toContain('<option value="machine-learning" selected="">Học máy</option>')
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

  it('renders suggested prompt chips in the Q&A empty state', () => {
    const html = render(QaView, { state: 'empty' })

    expect(html).toContain('Gợi ý câu hỏi mẫu từ nguồn tin có trong hệ thống:')
    expect(html).toContain('Google DeepMind có bài viết nào về Gemini 3.1 Flash TTS không?')
    expect(html).toContain('public-suggestion-chip')
  })

  it('renders helpful guidance when a Q&A answer is refused due to insufficient evidence', () => {
    const html = render(QaView, {
      state: 'ready',
      messages: [
        {
          role: 'assistant',
          status: 'refused',
          refusalReason: 'insufficient-evidence',
        },
      ],
    })

    expect(html).toContain('Chưa đủ bằng chứng để trả lời câu hỏi này.')
    expect(html).toContain('Hệ thống chưa tìm thấy bài viết hoặc dữ liệu liên quan')
    expect(html).toContain('Bảng tin (Feed)')
    expect(html).toContain('Tìm kiếm')
  })

  it('renders rich article context card in Q&A when asking about an article and hides generic suggested prompts', () => {
    const html = render(QaView, {
      state: 'empty',
      scope: {
        articleId: '507f1f77bcf86cd799439011',
        article,
      },
    })

    expect(html).toContain('public-qa-article-context')
    expect(html).toContain('Đang hỏi về bài viết')
    expect(html).toContain('Bỏ chọn')
    expect(html).toContain(article.titleVi)
    expect(html).toContain('Nguồn luồng người dùng')
    expect(html).toContain('Tóm tắt kiểm thử.')
    expect(html).toContain('Hỏi đáp về bài viết')
    expect(html).toContain('placeholder="Nhập câu hỏi về bài viết này"')
    expect(html).not.toContain('Gợi ý câu hỏi mẫu từ nguồn tin có trong hệ thống:')
    expect(html).not.toContain('public-suggestion-chip')
  })

  it('renders fallback article context in Q&A when only articleId is provided', () => {
    const html = render(QaView, {
      state: 'empty',
      scope: {
        articleId: '507f1f77bcf86cd799439011',
      },
    })

    expect(html).toContain('public-qa-article-context')
    expect(html).toContain('Đang hỏi về bài viết')
    expect(html).toContain('Bỏ chọn')
    expect(html).toContain('Bài viết #507f1f77…')
    expect(html).toContain('507f1f77bcf86cd799439011')
  })

  it('renders direct Hỏi đáp button on feed article cards when handler is supplied', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [article],
      handlers: { onAskAboutArticle: noop },
    })

    expect(html).toContain('>Hỏi đáp</button>')
  })

  it('renders direct Hỏi đáp button on search and saved article cards when handler is supplied', () => {
    const searchHtml = render(SearchView, {
      state: 'ready',
      results: [{ article }],
      handlers: { onAskAboutArticle: noop },
    })
    expect(searchHtml).toContain('>Hỏi đáp</button>')

    const savedHtml = render(SavedView, {
      state: 'ready',
      articles: [article],
      handlers: { onAskAboutArticle: noop },
    })
    expect(savedHtml).toContain('>Hỏi đáp</button>')
  })

  it('renders all standard catalog sources grouped by connectors in SearchView', () => {
    const html = render(SearchView, {})

    expect(html).toContain('label="RSS Feeds"')
    expect(html).toContain('label="arXiv"')
    expect(html).toContain('label="Hacker News"')
    expect(html).toContain('OpenAI News')
    expect(html).toContain('Google DeepMind Blog')
    expect(html).toContain('The Verge Technology')
    expect(html).toContain('Ars Technica')
    expect(html).toContain('Hugging Face Blog')
    expect(html).toContain('arXiv Computer Science AI')
    expect(html).toContain('Hacker News Top Stories')
  })

  it('renders sources grouped by connectors in FeedView', () => {
    const html = render(FeedView, { state: 'ready', articles: [] })

    expect(html).toContain('label="RSS Feeds"')
    expect(html).toContain('label="arXiv"')
    expect(html).toContain('label="Hacker News"')
    expect(html).toContain('OpenAI News')
    expect(html).toContain('Google DeepMind Blog')
  })

  it('renders Phạm vi chủ đề heading and multi-select trigger in QaView', () => {
    const html = render(QaView, {
      state: 'empty',
      scope: { topics: ['AI', 'Học máy'] },
      handlers: { onToggleTopic: noop },
    })

    expect(html).toContain('Phạm vi chủ đề')
    expect(html).toContain('Giới hạn chủ đề và thời gian bài viết cần hỏi đáp.')
    expect(html).toContain('Đã chọn (2) chủ đề')
    expect(html).toContain('Bỏ chọn hết')
    expect(html).toContain('public-selected-topic-chip')
    expect(html).toContain('Học máy')
    expect(html).toContain('AI')
  })

  it('renders unselected trigger text when no topics are chosen in QaView', () => {
    const html = render(QaView, {
      state: 'empty',
      scope: { topics: [] },
      handlers: { onToggleTopic: noop },
    })

    expect(html).toContain('Phạm vi chủ đề')
    expect(html).toContain('Chọn chủ đề bài viết...')
    expect(html).not.toContain('Bỏ chọn hết')
  })

  it('keeps parent and child topics independent so selecting AI does not select Học máy and Software Engineering does not select JavaScript', () => {
    const aiOnlyHtml = render(QaView, {
      state: 'empty',
      scope: { topics: ['AI'] },
      handlers: { onToggleTopic: noop },
    })
    expect(aiOnlyHtml).toContain('Đã chọn (1) chủ đề')
    expect(aiOnlyHtml).toContain('public-selected-topic-chip')
    expect(aiOnlyHtml).toContain('<span>AI</span>')
    expect(aiOnlyHtml).not.toContain('<span>Học máy</span>')

    const seOnlyHtml = render(QaView, {
      state: 'empty',
      scope: { topics: ['Software Engineering'] },
      handlers: { onToggleTopic: noop },
    })
    expect(seOnlyHtml).toContain('Đã chọn (1) chủ đề')
    expect(seOnlyHtml).toContain('public-selected-topic-chip')
    expect(seOnlyHtml).toContain('<span>Software Engineering</span>')
    expect(seOnlyHtml).not.toContain('<span>JavaScript</span>')
  })

  it('renders citation chips with consecutive numbers [1], [2], [3] and displays feed titles instead of only source names', () => {
    const html = render(QaView, {
      state: 'ready',
      messages: [
        { id: 'q1', role: 'user', text: 'Tình hình phát triển AI gần đây thế nào?' },
        {
          id: 'a1',
          role: 'assistant',
          status: 'answered',
          paragraphs: [
            { text: 'Mô hình DeepSeek mới đạt hiệu năng cao.', citationIds: ['c1'] },
            { text: 'Apple cũng vừa cập nhật hệ thống AI mới.', citationIds: ['c2'] },
            { text: 'Các nghiên cứu về AI Agent đang bùng nổ.', citationIds: ['c3'] },
          ],
          citations: [
            { id: 'c1', titleOriginal: 'DeepSeek-V3 Technical Report', sourceName: 'arXiv' },
            { id: 'c2', titleOriginal: 'Apple Intelligence Overview', sourceName: 'The Verge' },
            { id: 'c3', titleVi: 'Bước tiến mới trong AI Agent', titleOriginal: 'New AI Agent Milestone', sourceName: 'Google AI Blog' },
          ],
        },
      ],
    })

    // Kiểm tra các con số tuần tự [1], [2], [3] phía trước các bài feed
    expect(html).toContain('>[1]<')
    expect(html).toContain('>[2]<')
    expect(html).toContain('>[3]<')

    // Kiểm tra tiêu đề của bài feed được hiển thị nổi bật
    expect(html).toContain('DeepSeek-V3 Technical Report')
    expect(html).toContain('Apple Intelligence Overview')
    expect(html).toContain('Bước tiến mới trong AI Agent')

    // Kiểm tra thông tin nguồn kèm theo
    expect(html).toContain('arXiv')
    expect(html).toContain('The Verge')
    expect(html).toContain('Google AI Blog')
  })
})
