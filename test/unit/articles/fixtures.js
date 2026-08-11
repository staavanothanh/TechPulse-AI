export const SOURCE_ID = '507f1f77bcf86cd799439011'
export const OTHER_SOURCE_ID = '507f1f77bcf86cd799439012'
export const RETRIEVED_AT = new Date('2026-08-11T00:00:00.000Z')

export function makeSource(overrides = {}) {
  return {
    id: SOURCE_ID,
    name: 'Example Source',
    sourceKey: 'rss:example',
    publisherName: 'Example Publisher',
    domain: 'example.com',
    connectorType: 'rss',
    accessMethod: 'rss',
    authorityTier: 'editorial',
    connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    operationalStatus: 'active',
    licenseStatus: 'permitted',
    llmInputScope: 'excerpt',
    storageScope: { metadata: true, excerpt: true, summary: true, embedding: true },
    mediaPolicy: { imageMode: 'remote-preview', videoMode: 'link-only', allowedHosts: ['cdn.example.com'], attributionRequired: false, evidenceNote: null },
    attributionRequired: false,
    attributionText: null,
    policyVersion: 3,
    technicalCheck: { status: 'passed' },
    ...overrides,
  }
}

export function makeCandidate(overrides = {}) {
  return {
    connectorType: 'rss',
    sourceId: SOURCE_ID,
    authorityTier: 'editorial',
    externalId: 'item-1',
    titleOriginal: 'AI systems & safety',
    originalUrl: 'https://Example.com/articles/ai-systems?utm_source=feed&b=2&a=1#comments',
    author: 'Ada Example',
    publishedAt: '2026-08-10T12:00:00.000Z',
    retrievedAt: RETRIEVED_AT,
    sourceLanguage: 'EN_us',
    topics: ['AI', 'Safety', 'ai'],
    excerptOriginal: '<p>Safe <strong>excerpt</strong>.</p><script>ignore()</script>',
    mediaCandidate: { type: 'image', url: 'https://cdn.example.com/image.jpg', sourcePageUrl: 'https://example.com/articles/ai-systems', alt: 'A diagram', credit: 'Example' },
    provenance: { connectorType: 'rss', sourceId: SOURCE_ID, sourceKey: 'rss:example', externalId: 'item-1', originalUrl: 'https://example.com/articles/ai-systems', observedAt: RETRIEVED_AT },
    ...overrides,
  }
}

export function makeJob(overrides = {}) {
  return {
    id: '507f1f77bcf86cd799439013',
    sourceId: SOURCE_ID,
    connectorType: 'rss',
    expectedSourcePolicyVersion: 3,
    expectedConnectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
    batchSize: 20,
    leaseGeneration: 1,
    ...overrides,
  }
}
