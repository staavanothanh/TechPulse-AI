import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SourcePolicyReviewForm } from '../../../client/features/admin/ui/AdminSourceForms.jsx'
import { buildPolicyReview } from '../../../client/features/admin/sources/source-form.js'

const source = {
  id: 'source-1',
  name: 'Example News',
  policyVersion: 3,
  licenseStatus: 'metadata-only',
  llmInputScope: 'metadata',
  attributionRequired: true,
  attributionText: 'Example News',
  mediaPolicy: {
    imageMode: 'none',
    videoMode: 'none',
    allowedHosts: [],
    attributionRequired: false,
    evidenceNote: null,
  },
  storageScope: { summary: true, embedding: true },
}

describe('admin source media policy controls', () => {
  it('renders independent image, video, host and media attribution controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(SourcePolicyReviewForm, { source, onSubmit: () => {}, busy: false }),
    )

    expect(html).toContain('Chế độ preview ảnh')
    expect(html).toContain('Chế độ video')
    expect(html).toContain('Host media được duyệt')
    expect(html).toContain('Bắt buộc attribution media')
    expect(html).toContain('Bằng chứng media policy')
    expect(html).toContain('reload/restart runtime để cập nhật CSP')
  })

  it('normalizes exact host entries and preserves media modes in the review payload', () => {
    const result = buildPolicyReview({
      licenseStatus: 'permitted',
      llmInputScope: 'metadata',
      storeMetadata: true,
      storeExcerpt: false,
      storeSummary: true,
      storeEmbedding: true,
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: 'CDN.Example.com, cdn.example.com',
      mediaAttributionRequired: true,
      mediaEvidenceNote: 'Terms cho phép remote preview.',
      attributionRequired: true,
      attributionText: 'Example News',
      termsUrl: '',
      licenseUrl: '',
      evidenceNote: 'Human review.',
    })

    expect(result.mediaPolicy).toEqual({
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: ['cdn.example.com'],
      attributionRequired: true,
      evidenceNote: 'Terms cho phép remote preview.',
    })
  })

  it('drops wildcard, URL, IP and private host entries before submit', () => {
    const result = buildPolicyReview({
      licenseStatus: 'permitted',
      llmInputScope: 'metadata',
      storeMetadata: true,
      storeExcerpt: false,
      storeSummary: true,
      storeEmbedding: true,
      imageMode: 'remote-preview',
      videoMode: 'link-only',
      allowedHosts: '*.example.com, https://evil.example.com, 127.0.0.1, cdn.example.com, media.local',
      mediaAttributionRequired: true,
      mediaEvidenceNote: 'Human review.',
      attributionRequired: true,
      attributionText: 'Example News',
      termsUrl: '',
      licenseUrl: '',
      evidenceNote: 'Human review.',
    })

    expect(result.mediaPolicy.allowedHosts).toEqual(['cdn.example.com'])
  })
})
