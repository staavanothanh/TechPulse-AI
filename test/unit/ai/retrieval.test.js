import { describe, expect, it } from 'vitest'
import { cosineSimilarity, rankHybridCandidates } from '../../../server/ai/retrieval.js'

const compatible = { embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1, embeddingStatus: 'ready' }

describe('Step 9 application cosine retrieval', () => {
  it('combines normalized text and cosine only for exact compatible vectors', () => {
    const queryVector = [1, 0]
    const ranked = rankHybridCandidates({
      queryVector,
      queryModel: 'baai/bge-m3',
      queryDimensions: 1024,
      queryVersion: 1,
      candidates: [
        { id: 'semantic', textScore: 0.2, ...compatible, embedding: [1, 0] },
        { id: 'text', textScore: 0.9, ...compatible, embedding: [0, 1] },
        { id: 'stale', textScore: 1, ...compatible, embeddingVersion: 2, embedding: [1, 0] },
      ],
    })
    expect(ranked.map(({ id }) => id)).toEqual(['semantic', 'text'])
    expect(ranked[0]).toEqual(expect.objectContaining({ semanticScore: 1, score: 0.64 }))
  })

  it('handles zero vectors and refuses incompatible dimensions', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
    expect(() => cosineSimilarity([1], [1, 0])).toThrow(/dimension/i)
    expect(rankHybridCandidates({ queryVector: [1, 0], queryModel: 'baai/bge-m3', queryDimensions: 1024, queryVersion: 1, candidates: [{ id: 'bad', textScore: 1, ...compatible, embeddingDimensions: 12, embedding: [1, 0] }] })).toEqual([])
  })
})
