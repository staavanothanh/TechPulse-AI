import { describe, expect, it } from 'vitest'
import { evaluateContentPolicy } from '../../../server/domain/policy/content-policy.js'
import { evaluateMediaPolicy } from '../../../server/domain/policy/media-policy.js'

const source = (overrides = {}) => ({
  id: 'source-1', name: 'Example', operationalStatus: 'active', licenseStatus: 'metadata-only', llmInputScope: 'metadata', policyVersion: 4,
  storageScope: { metadata: true, excerpt: false, summary: true, embedding: true },
  mediaPolicy: { imageMode: 'remote-preview', videoMode: 'link-only', allowedHosts: ['media.example.com'], attributionRequired: true, evidenceNote: 'Reviewed.' },
  attributionRequired: true, attributionText: 'Example Publisher',
  ...overrides,
})

describe('Executable source policy gates', () => {
  it.each(['review-needed', 'blocked'])('blocks every processing purpose for %s', (licenseStatus) => {
    for (const purpose of ['metadata', 'excerpt', 'summary', 'embedding', 'retrieval']) {
      expect(evaluateContentPolicy(source({ licenseStatus, llmInputScope: 'none', storageScope: { metadata: false, excerpt: false, summary: false, embedding: false } }), purpose)).toEqual(expect.objectContaining({ allowed: false, purpose, policyVersion: 4 }))
    }
  })

  it('allows metadata-derived summary/embedding but never excerpt for metadata-only', () => {
    expect(evaluateContentPolicy(source(), 'summary')).toEqual(expect.objectContaining({ allowed: true, inputScope: 'metadata', policyVersion: 4 }))
    expect(evaluateContentPolicy(source(), 'embedding')).toEqual(expect.objectContaining({ allowed: true, inputScope: 'metadata', policyVersion: 4 }))
    expect(evaluateContentPolicy(source(), 'excerpt')).toEqual(expect.objectContaining({ allowed: false, code: 'source_scope_denied' }))
  })

  it('blocks provider purposes when input scope is none', () => {
    expect(evaluateContentPolicy(source({ llmInputScope: 'none', storageScope: { metadata: true, excerpt: false, summary: false, embedding: false } }), 'summary')).toEqual(expect.objectContaining({ allowed: false }))
  })

  it('fails closed on malformed or unversioned policy objects', () => {
    expect(evaluateContentPolicy(source({ policyVersion: null }), 'summary')).toEqual(expect.objectContaining({ allowed: false, code: 'source_policy_invalid' }))
    expect(evaluateMediaPolicy(source({ llmInputScope: 'everything' }), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article' })).toEqual(expect.objectContaining({ allowed: false, code: 'source_policy_invalid' }))
  })

  it('returns an exact field allowlist for fulltext-temporary without granting storage', () => {
    const decision = evaluateContentPolicy(source({ licenseStatus: 'permitted', llmInputScope: 'fulltext-temporary', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true } }), 'summary')
    expect(decision).toEqual(expect.objectContaining({ allowed: true, inputScope: 'fulltext-temporary' }))
    expect(decision.allowedFields).toContain('fullTextTemporary')
    expect(decision.allowedFields).not.toContain('excerptOriginal')
  })

  it('permits only current allowlisted media mode and host with server-resolved attribution', () => {
    const image = evaluateMediaPolicy(source(), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: 'Diagram' })
    expect(image).toEqual(expect.objectContaining({ allowed: true, displayMode: 'remote-preview', host: 'media.example.com', attribution: 'Example Publisher', policyVersion: 4 }))
    const video = evaluateMediaPolicy(source(), { type: 'video', url: 'https://media.example.com/watch/1', sourcePageUrl: 'https://example.com/article' })
    expect(video).toEqual(expect.objectContaining({ allowed: true, displayMode: 'link-only' }))
  })

  it('enforces every image/video mode combination independently', () => {
    for (const imageMode of ['none', 'remote-preview']) {
      for (const videoMode of ['none', 'link-only']) {
        const policy = source({ mediaPolicy: { ...source().mediaPolicy, imageMode, videoMode } })
        const image = evaluateMediaPolicy(policy, { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article' })
        const video = evaluateMediaPolicy(policy, { type: 'video', url: 'https://media.example.com/watch/1', sourcePageUrl: 'https://example.com/article' })
        expect(image.allowed).toBe(imageMode === 'remote-preview')
        expect(video.allowed).toBe(videoMode === 'link-only')
        if (!image.allowed) expect(image.code).toBe('media_mode_denied')
        if (!video.allowed) expect(video.code).toBe('media_mode_denied')
      }
    }
  })

  it.each([
    [{ type: 'image', url: 'https://other.example/image.jpg', sourcePageUrl: 'https://example.com/article' }, 'media_host_denied'],
    [{ type: 'image', url: 'https://127.0.0.1/image.jpg', sourcePageUrl: 'https://example.com/article' }, 'media_host_denied'],
    [{ type: 'image', url: 'http://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article' }, 'media_url_invalid'],
    [{ type: 'image', url: 'https://user:pass@media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article' }, 'media_url_invalid'],
  ])('returns a structured rejection for denied media', (candidate, code) => {
    expect(evaluateMediaPolicy(source(), candidate)).toEqual(expect.objectContaining({ allowed: false, code, policyVersion: 4 }))
  })

  it('rejects oversized untrusted media metadata', () => {
    expect(evaluateMediaPolicy(source(), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', credit: 'x'.repeat(501) })).toEqual(expect.objectContaining({ allowed: false, code: 'media_metadata_invalid' }))
  })

  it.each([undefined, null])('rejects a media candidate without a source page URL (%s)', (sourcePageUrl) => {
    expect(evaluateMediaPolicy(source(), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl })).toEqual(expect.objectContaining({ allowed: false, code: 'media_url_invalid' }))
  })

  it('rejects unknown purposes, inactive sources, invalid media metadata and missing attribution', () => {
    expect(evaluateContentPolicy(source(), 'unknown')).toEqual(expect.objectContaining({ allowed: false, code: 'source_purpose_unknown' }))
    expect(evaluateContentPolicy(source({ operationalStatus: 'paused' }), 'metadata')).toEqual(expect.objectContaining({ allowed: false, code: 'source_inactive' }))
    expect(evaluateContentPolicy(null, 'metadata')).toEqual(expect.objectContaining({ allowed: false }))
    expect(evaluateMediaPolicy(source(), { type: 'audio', url: 'https://media.example.com/audio', sourcePageUrl: 'https://example.com/article' })).toEqual(expect.objectContaining({ allowed: false, code: 'media_type_invalid' }))
    expect(evaluateMediaPolicy(source(), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article', altText: 42 })).toEqual(expect.objectContaining({ allowed: false, code: 'media_metadata_invalid' }))
    expect(evaluateMediaPolicy(source({ attributionRequired: false, attributionText: null, name: '' }), { type: 'image', url: 'https://media.example.com/image.jpg', sourcePageUrl: 'https://example.com/article' })).toEqual(expect.objectContaining({ allowed: false, code: 'media_attribution_missing' }))
  })
})
