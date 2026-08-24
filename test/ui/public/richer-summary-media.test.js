import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ArticleView } from '../../../client/features/public/index.js'
import { safeMediaUrl } from '../../../client/features/public/safe-url.js'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))

const article = (overrides = {}) => ({
  id: 'article-detail-1',
  titleOriginal: 'Trusted media detail',
  titleVi: 'Chi tiết media đã kiểm duyệt',
  originalUrl: 'https://news.example.com/article',
  source: { id: 'source-1', name: 'Example News', authorityTier: 'editorial' },
  sourceLanguage: 'vi',
  publishedAt: '2026-08-20T08:00:00.000Z',
  summaryStatus: 'ready',
  summaryBasis: 'metadata',
  summaryVi: 'Tóm tắt ngắn chỉ dùng cho feed.',
  summaryDetailStatus: 'ready',
  summaryParagraphsVi: [
    'Đoạn chi tiết thứ nhất mô tả dữ kiện chính từ nguồn.',
    'Đoạn chi tiết thứ hai nêu phạm vi và giới hạn của thông tin.',
  ],
  leadMedia: null,
  ...overrides,
})

describe('public detail summary and trusted media presentation', () => {
  it('prioritizes detail paragraphs over the feed-sized summary', () => {
    const html = render(ArticleView, { state: 'ready', article: article() })

    expect(html).toContain('Đoạn chi tiết thứ nhất mô tả dữ kiện chính từ nguồn.')
    expect(html).toContain('Đoạn chi tiết thứ hai nêu phạm vi và giới hạn của thông tin.')
    expect(html).not.toContain('Tóm tắt ngắn chỉ dùng cho feed.')
    expect(html.match(/public-detail-summary-paragraph/g)).toHaveLength(2)
  })

  it('renders an allowed image with canonical attribution on the article detail', () => {
    const html = render(ArticleView, {
      state: 'ready',
      article: article({
        leadMedia: {
          type: 'image',
          displayMode: 'remote-preview',
          url: 'https://cdn.example.com/article.jpg',
          sourcePageUrl: 'https://news.example.com/article',
          altText: 'Sơ đồ hệ thống',
          attribution: 'Example News Media',
          mediaEvidenceStatus: 'not-analyzed',
        },
      }),
    })

    expect(html).toContain('class="public-detail-media"')
    expect(html).toContain('src="https://cdn.example.com/article.jpg"')
    expect(html).toContain('alt="Sơ đồ hệ thống"')
    expect(html).toContain('crossorigin="anonymous"')
    expect(html).toContain('referrerPolicy="no-referrer"')
    expect(readFileSync('client/features/public/components/reader-primitives.jsx', 'utf8')).toContain(
      'onError={() => setFailedSrc(src)}',
    )
    expect(html).toContain('Example News Media')
  })

  it('keeps video link-only and does not create a player or iframe', () => {
    const html = render(ArticleView, {
      state: 'ready',
      article: article({
        leadMedia: {
          type: 'video',
          displayMode: 'link-only',
          url: 'https://media.example.com/video.mp4',
          sourcePageUrl: 'https://news.example.com/video-page',
          attribution: 'Example News Media',
          mediaEvidenceStatus: 'not-analyzed',
        },
      }),
    })

    expect(html).toContain('Mở video nguồn')
    expect(html).toContain('href="https://news.example.com/video-page"')
    expect(html).toContain('AI chưa phân tích video này.')
    expect(html).toContain('Example News Media')
    expect(html).not.toMatch(/<video|<iframe/i)
  })

  it('shows a TechPulse fallback when an image URL is unsafe or cannot be used', () => {
    const html = render(ArticleView, {
      state: 'ready',
      article: article({
        leadMedia: {
          type: 'image',
          displayMode: 'remote-preview',
          url: 'javascript:alert(1)',
          sourcePageUrl: 'https://news.example.com/article',
          attribution: 'Example News Media',
          mediaEvidenceStatus: 'not-analyzed',
        },
      }),
    })

    expect(html).not.toContain('javascript:')
    expect(html).toContain('Ảnh nguồn không khả dụng')
  })

  it('uses the short summary while detail summary is pending or failed', () => {
    const pending = render(ArticleView, {
      state: 'ready',
      article: article({ summaryDetailStatus: 'pending' }),
    })
    const failed = render(ArticleView, {
      state: 'ready',
      article: article({ summaryDetailStatus: 'failed', summaryVi: null }),
    })

    expect(pending).not.toContain('Đoạn chi tiết thứ nhất mô tả dữ kiện chính từ nguồn.')
    expect(pending).toContain('Tóm tắt ngắn chỉ dùng cho feed.')
    expect(pending).toContain('Đang tạo tóm tắt chi tiết.')
    expect(failed).toContain('Tóm tắt chưa khả dụng.')
    expect(failed).not.toContain('Đoạn chi tiết thứ nhất mô tả dữ kiện chính từ nguồn.')
  })

  it('matches media URLs by exact reviewed host when an allowlist is supplied', () => {
    expect(safeMediaUrl('https://cdn.example.com/image.jpg', ['cdn.example.com'])).toBe(
      'https://cdn.example.com/image.jpg',
    )
    expect(safeMediaUrl('https://assets.cdn.example.com/image.jpg', ['cdn.example.com'])).toBeNull()
    expect(safeMediaUrl('https://cdn.example.com/image.jpg', ['other.example.com'])).toBeNull()
  })

  it('keeps server-reviewed media usable without adding hosts to the public DTO', () => {
    expect(safeMediaUrl('https://cdn.example.com/image.jpg')).toBe('https://cdn.example.com/image.jpg')
    expect(safeMediaUrl('javascript:alert(1)')).toBeNull()
  })
})
