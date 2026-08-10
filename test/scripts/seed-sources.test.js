import { describe, expect, it } from 'vitest'
import { SOURCE_SEEDS, buildSeedDrafts } from '../../scripts/seed-sources.js'

describe('Source Registry seed definitions', () => {
  it('covers RSS, arXiv and Hacker News while granting no rights', () => {
    expect(new Set(SOURCE_SEEDS.map(({ connectorType }) => connectorType))).toEqual(new Set(['rss', 'arxiv', 'hacker-news']))
    const drafts = buildSeedDrafts({ now: new Date('2026-08-10T00:00:00.000Z') })
    expect(drafts).toHaveLength(SOURCE_SEEDS.length)
    for (const source of drafts) {
      expect(source).toEqual(expect.objectContaining({ operationalStatus: 'draft', licenseStatus: 'review-needed', llmInputScope: 'none', policyVersion: 1 }))
      expect(source.storageScope).toEqual({ metadata: false, excerpt: false, summary: false, embedding: false })
      expect(source.mediaPolicy).toEqual(expect.objectContaining({ imageMode: 'none', videoMode: 'none', allowedHosts: [] }))
      expect(source.reviewedBy).toBeNull()
    }
  })
})
