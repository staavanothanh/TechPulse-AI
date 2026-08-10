import { describe, expect, it } from 'vitest'
import {
  normalizeReviewedHostname,
  normalizeSourceDefinition,
  validateConnectorUnit,
  validatePolicyCompatibility,
} from '../../../server/domain/source/validation.js'

const storage = (overrides = {}) => ({ metadata: false, excerpt: false, summary: false, embedding: false, ...overrides })
const media = (overrides = {}) => ({ imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null, ...overrides })

describe('Source Registry connector and rights validation', () => {
  it.each([
    [{ connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example/feed.xml', batchSize: 20 } }],
    [{ connectorType: 'rss', accessMethod: 'atom', authorityTier: 'primary', connectorConfig: { kind: 'rss', feedUrl: 'https://research.example/atom.xml', batchSize: 10 } }],
    [{ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 30 } }],
    [{ connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 40 } }],
  ])('accepts a closed connector/access/authority unit', (input) => {
    expect(validateConnectorUnit(input)).toEqual(input)
  })

  it.each([
    { connectorType: 'rss', accessMethod: 'api', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://news.example/feed.xml', batchSize: 20 } },
    { connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'editorial', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 20 } },
    { connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } },
    { connectorType: 'rss', accessMethod: 'rss', authorityTier: 'primary', connectorConfig: { kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 } },
  ])('rejects connector mismatches and Hacker News authority escalation', (input) => {
    expect(() => validateConnectorUnit(input)).toThrow(/connector|authority|access/i)
  })

  it('enforces the complete license/input/storage/media compatibility matrix', () => {
    expect(() => validatePolicyCompatibility({ licenseStatus: 'review-needed', llmInputScope: 'metadata', storageScope: storage({ metadata: true }), mediaPolicy: media() })).toThrow(/review-needed/i)
    expect(() => validatePolicyCompatibility({ licenseStatus: 'blocked', llmInputScope: 'none', storageScope: storage({ metadata: true }), mediaPolicy: media() })).toThrow(/blocked/i)
    expect(() => validatePolicyCompatibility({ licenseStatus: 'metadata-only', llmInputScope: 'excerpt', storageScope: storage({ metadata: true }), mediaPolicy: media() })).toThrow(/metadata-only/i)
    expect(() => validatePolicyCompatibility({ licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: storage({ metadata: true, excerpt: true }), mediaPolicy: media() })).toThrow(/excerpt/i)
    expect(() => validatePolicyCompatibility({ licenseStatus: 'permitted', llmInputScope: 'none', storageScope: storage({ metadata: true, summary: true }), mediaPolicy: media() })).toThrow(/summary|embedding/i)
    expect(validatePolicyCompatibility({ licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: storage({ metadata: true, summary: true, embedding: true }), mediaPolicy: media() })).toBeTruthy()
    expect(validatePolicyCompatibility({ licenseStatus: 'permitted', llmInputScope: 'fulltext-temporary', storageScope: storage({ metadata: true, excerpt: true, summary: true, embedding: true }), mediaPolicy: media() })).toBeTruthy()
  })

  it('exhaustively checks every license × input × storage combination', () => {
    const licenses = ['permitted', 'metadata-only', 'review-needed', 'blocked']
    const inputs = ['none', 'metadata', 'excerpt', 'fulltext-temporary']
    const scopes = []
    for (let mask = 0; mask < 16; mask += 1) scopes.push({ metadata: Boolean(mask & 1), excerpt: Boolean(mask & 2), summary: Boolean(mask & 4), embedding: Boolean(mask & 8) })
    for (const licenseStatus of licenses) {
      for (const llmInputScope of inputs) {
        for (const storageScope of scopes) {
          const expected = licenseStatus === 'permitted'
            ? llmInputScope !== 'none' || !storageScope.summary && !storageScope.embedding
            : licenseStatus === 'metadata-only'
              ? ['none', 'metadata'].includes(llmInputScope) && storageScope.metadata && !storageScope.excerpt && (llmInputScope !== 'none' || !storageScope.summary && !storageScope.embedding)
              : llmInputScope === 'none' && Object.values(storageScope).every((value) => value === false)
          const operation = () => validatePolicyCompatibility({ licenseStatus, llmInputScope, storageScope, mediaPolicy: media(), attributionRequired: false })
          if (expected) expect(operation()).toBeTruthy()
          else expect(operation).toThrow()
        }
      }
    }
  })

  it('requires sanitized attribution text when attribution is mandatory', () => {
    expect(() => validatePolicyCompatibility({ licenseStatus: 'permitted', llmInputScope: 'metadata', storageScope: storage({ metadata: true }), mediaPolicy: media(), attributionRequired: true, attributionText: '   ' })).toThrow(/attribution/i)
  })

  it('normalizes reviewed IDN hostnames and rejects wildcard, IP, private and single-label hosts', () => {
    expect(normalizeReviewedHostname('BÜCHER.Example')).toBe('xn--bcher-kva.example')
    for (const host of ['*.example.com', '127.0.0.1', 'localhost', 'printer', '10.0.0.4', 'metadata.google.internal']) {
      expect(() => normalizeReviewedHostname(host)).toThrow(/host/i)
    }
  })

  it('normalizes the source identity and rejects non-public source domains', () => {
    expect(normalizeSourceDefinition({ name: ' Example ', sourceKey: 'rss:example', publisherName: ' Publisher ', domain: 'BÜCHER.Example' })).toEqual({ name: 'Example', sourceKey: 'rss:example', publisherName: 'Publisher', domain: 'xn--bcher-kva.example' })
    for (const domain of ['localhost', '127.0.0.1', 'metadata.google.internal']) {
      expect(() => normalizeSourceDefinition({ name: 'Example', sourceKey: 'rss:example', publisherName: 'Publisher', domain })).toThrow(/host|domain/i)
    }
  })
})
