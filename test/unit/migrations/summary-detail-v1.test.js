import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  SUMMARY_DETAIL_ARTICLE_VALIDATOR,
  buildSummaryDetailV1Migration,
  runSummaryDetailV1Migration,
} from '../../../scripts/migrations/summary-detail-v1.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'

function validShortReadyArticle(overrides = {}) {
  const now = new Date('2026-08-24T00:00:00.000Z')
  return {
    _id: new ObjectId(),
    sourceId: new ObjectId(),
    summaryStatus: 'ready',
    summaryVi: 'Tóm tắt ngắn tiếng Việt đã tồn tại từ phiên bản trước.',
    summaryBasis: 'metadata',
    summaryModel: 'summary-model',
    summaryInputHash: 'a'.repeat(64),
    summarySourcePolicyVersion: 4,
    summaryGeneratedAt: now,
    summaryError: null,
    ...overrides,
  }
}

describe('summary-detail-v1 migration contract', () => {
  it('adds a strict forward-only article validator with canonical rich detail and official-payload', () => {
    const plan = buildSummaryDetailV1Migration({ dryRun: true })

    expect(plan).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'collMod', collection: 'articles' }),
      expect.objectContaining({ type: 'backfillLegacySummaryDetail', collection: 'articles' }),
    ]))
    expect(plan.every((operation) => !operation.type.startsWith('drop'))).toBe(true)
    const schema = SUMMARY_DETAIL_ARTICLE_VALIDATOR.$or[0].$and[0].$jsonSchema
    expect(schema.required).toEqual(expect.arrayContaining(['summaryParagraphsVi', 'summaryDetailStatus']))
    expect(schema.properties.summaryBasis.enum).toContain('official-payload')
    expect(plan.map(({ type }) => type)).toEqual(['collMod', 'backfillLegacySummaryDetail', 'collMod'])
  })

  it('marks legacy short-ready records pending rather than fabricating a one-paragraph canonical detail', async () => {
    const legacy = validShortReadyArticle()
    const toArray = vi.fn().mockResolvedValueOnce([legacy]).mockResolvedValueOnce([])
    const collection = {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ project: () => ({ toArray }) }) }) })),
      countDocuments: vi.fn(async () => 0),
      updateOne: vi.fn(async () => ({ matchedCount: 1 })),
    }
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } }] })),
      command: vi.fn(async () => ({ ok: 1 })),
      collection: vi.fn(() => collection),
    }

    await expect(runSummaryDetailV1Migration({ db, batchSize: 10, writerMode: 'paused' })).resolves.toEqual(expect.objectContaining({ legacyUpdated: 1 }))
    expect(collection.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: legacy._id,
        $or: expect.arrayContaining([
          { summaryDetailStatus: { $exists: false } },
          { summaryParagraphsVi: { $exists: false } },
        ]),
      }),
      expect.objectContaining({ $set: expect.objectContaining({ summaryDetailStatus: 'pending', summaryParagraphsVi: null }) }),
    )
  })

  it('is idempotent when canonical detail state is already materialized', async () => {
    const collection = {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ project: () => ({ toArray: async () => [] }) }) }) })),
      countDocuments: vi.fn(async () => 0),
      updateOne: vi.fn(),
    }
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } }] })),
      command: vi.fn(async () => ({ ok: 1 })),
      collection: vi.fn(() => collection),
    }

    await expect(runSummaryDetailV1Migration({ db, batchSize: 10 })).resolves.toEqual(expect.objectContaining({ legacyUpdated: 0 }))
    expect(collection.updateOne).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
  })

  it('refuses the final strict validator until writers are paused', async () => {
    const collection = {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ project: () => ({ toArray: async () => [] }) }) }) })),
      countDocuments: vi.fn(async () => 0),
      updateOne: vi.fn(),
    }
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } }] })),
      command: vi.fn(async () => ({ ok: 1 })),
      collection: vi.fn(() => collection),
    }

    await expect(runSummaryDetailV1Migration({ db })).rejects.toThrow(/writers-paused/i)
    expect(db.command).not.toHaveBeenCalled()
  })

  it('does not install the strict validator while legacy detail residue remains', async () => {
    const collection = {
      find: vi.fn(() => ({ sort: () => ({ limit: () => ({ project: () => ({ toArray: async () => [] }) }) }) })),
      countDocuments: vi.fn(async () => 1),
      updateOne: vi.fn(),
    }
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } }] })),
      command: vi.fn(async () => ({ ok: 1 })),
      collection: vi.fn(() => collection),
    }

    await expect(runSummaryDetailV1Migration({ db, writerMode: 'paused' })).rejects.toThrow(/backfill is incomplete/i)
    expect(db.command).toHaveBeenCalledTimes(1)
  })
})
