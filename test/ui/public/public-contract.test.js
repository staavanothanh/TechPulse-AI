import React from 'react'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DonateView, FeedView, QaView } from '../../../client/features/public/index.js'
import { DONATION_DETAILS, buildVietQrImageUrl } from '../../../client/features/public/donation.js'

const render = (Component, props = {}) =>
  renderToStaticMarkup(React.createElement(Component, props))

describe('public feature contract boundaries', () => {
  it('renders the owner donation details with an amount-free VietQR image URL', () => {
    const qrUrl = new URL(buildVietQrImageUrl(DONATION_DETAILS))
    const html = render(DonateView)

    expect(qrUrl.hostname).toBe('img.vietqr.io')
    expect(qrUrl.pathname).toBe('/image/970422-0392375486-compact2.png')
    expect(qrUrl.searchParams.get('accountName')).toBe('TA VAN THANH')
    expect(qrUrl.searchParams.get('addInfo')).toBe(DONATION_DETAILS.transferContent)
    expect(qrUrl.searchParams.has('amount')).toBe(false)
    expect(html).toContain(DONATION_DETAILS.bankName)
    expect(html).toContain(DONATION_DETAILS.accountName)
    expect(html).toContain(DONATION_DETAILS.accountNumber)
    expect(html).toContain(DONATION_DETAILS.transferContent)
    expect(html).toContain('img.vietqr.io/image/970422-0392375486-compact2.png')
  })

  it('renders answered and refused Q&A branches from the public response shape', () => {
    const answered = render(QaView, {
      state: 'ready',
      messages: [
        { id: 'q1', role: 'user', text: 'AI đang thay đổi hạ tầng thế nào?' },
        {
          id: 'a1',
          role: 'assistant',
          status: 'answered',
          paragraphs: [
            { text: 'Các đội ngũ đang tối ưu hạ tầng để kiểm soát chi phí.', citationIds: ['c1'] },
          ],
          citations: [
            {
              id: 'c1',
              sourceName: 'Tech Review',
              titleOriginal: 'AI infrastructure',
              originalUrl: 'https://example.com/article',
            },
          ],
        },
      ],
    })
    const refused = render(QaView, {
      state: 'ready',
      messages: [
        {
          id: 'a2',
          role: 'assistant',
          status: 'refused',
          refusalReason: 'insufficient-evidence',
          paragraphs: [],
          citations: [],
        },
      ],
    })
    expect(answered).toContain('Các đội ngũ đang tối ưu hạ tầng')
    expect(answered).toContain('Tech Review')
    expect(answered).not.toMatch(/score|vector|providerPayload|internal/i)
    expect(refused).toContain('Chưa đủ bằng chứng')
  })

  it('keeps remote media policy link-only for video and rejects unsafe image URLs', () => {
    const html = render(FeedView, {
      state: 'ready',
      articles: [
        {
          id: 'image',
          titleOriginal: 'Image',
          source: { name: 'Source' },
          leadMedia: { type: 'image', displayMode: 'remote-preview', url: 'javascript:alert(1)' },
          summaryStatus: 'pending',
        },
        {
          id: 'video',
          titleOriginal: 'Video',
          source: { name: 'Source' },
          leadMedia: {
            type: 'video',
            displayMode: 'link-only',
            url: 'https://example.com/video',
            sourcePageUrl: 'https://example.com/video-page',
          },
          summaryStatus: 'pending',
        },
      ],
    })
    expect(html).not.toContain('javascript:')
    expect(html).not.toMatch(/<video|<iframe/i)
    expect(html).toContain('Mở video nguồn')
    expect(html).toContain('rel="noopener noreferrer external"')
  })

  it('keeps the article source link text contrasting in both themes', () => {
    const css = readFileSync(
      join(process.cwd(), 'client', 'features', 'public', 'public-base.css'),
      'utf8',
    )
    expect(css).toMatch(
      /\.public-page a\.public-btn-primary\s*\{[^}]*color:\s*var\(--public-surface\)/s,
    )
  })

  it('keeps the article back control visibly bordered like the artifact', () => {
    const css = readFileSync(
      join(process.cwd(), 'client', 'features', 'public', 'public-components.css'),
      'utf8',
    )
    expect(css).toMatch(/\.public-back\s*\{[^}]*border:\s*1px solid var\(--public-border\)/s)
    expect(css).toMatch(/\.public-back:hover\s*\{[^}]*border-color:\s*var\(--public-accent\)/s)
  })

  it('keeps feed media frames and source placeholders aligned with the artifact', () => {
    const css = readFileSync(
      join(process.cwd(), 'client', 'features', 'public', 'public-components.css'),
      'utf8',
    )
    expect(css).toMatch(
      /\.public-card-media-figure\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*overflow:\s*hidden/s,
    )
    expect(css).toMatch(
      /\.public-card-media-placeholder\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*radial-gradient\([^}]*var\(--public-accent-soft\)/s,
    )
  })

  it('keeps the public UI callback/API boundary free of credential storage and direct transport calls', () => {
    const root = join(process.cwd(), 'client', 'features', 'public')
    const files = []
    function collect(directory) {
      for (const name of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, name.name)
        if (name.isDirectory()) collect(path)
        else files.push(path)
      }
    }
    collect(root)
    const source = files.map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(source).not.toMatch(
      /sessionStorage|localStorage|password123|user@techpulse|admin@techpulse/i,
    )
    expect(source).not.toMatch(/\bfetch\s*\(|\baxios\b|XMLHttpRequest/)
    expect(source).toContain('onSubmit')
    expect(source).toContain('api')
  })
  it('keeps Q&A scope children inside the panel padding', () => {
    const css = readFileSync(
      join(process.cwd(), 'client', 'features', 'public', 'public-components.css'),
      'utf8',
    )
    expect(css).toMatch(/\.public-qa-scope\s*>\s*\*\s*\{[^}]*min-width:\s*0\s*;/s)
  })
})
