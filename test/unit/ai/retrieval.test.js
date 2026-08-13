import { describe, expect, it } from 'vitest'
import { cosineSimilarity, rankHybridCandidates, rankQnaEvidence } from '../../../server/ai/retrieval.js'

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

describe('Step 10 bounded Q&A relevance admission', () => {
  const records = [
    { article: { id: 'relevant', titleOriginal: 'Chip AI tiet kiem dien', excerptOriginal: 'Ket qua tiet kiem dien ro rang.', topics: ['ai'] } },
    { article: { id: 'irrelevant', titleOriginal: 'Du bao thoi tiet', excerptOriginal: 'Nhiet do va mua trong ngay mai.', topics: ['weather'] } },
  ]

  it('keeps visible evidence only when admitted question has lexical relevance', () => {
    expect(rankQnaEvidence({ question: 'Chip AI tiet kiem dien the nao?', records }).map(({ article }) => article.id)).toEqual(['relevant'])
    expect(rankQnaEvidence({ question: 'Gia co phieu hom nay?', records })).toEqual([])
  })

  it('bounds reranked evidence and does not expose internal scores', () => {
    const selected = rankQnaEvidence({ question: 'Chip AI', records, maxCandidates: 1 })
    expect(selected).toHaveLength(1)
    expect(selected[0]).not.toHaveProperty('relevanceScore')
  })

  it('selects a semantically matching Vietnamese paraphrase', () => {
    const vector = new Array(1024).fill(0)
    vector[0] = 1
    const semantic = { article: { id: 'semantic', titleOriginal: 'Toi uu tai nguyen cum may chu', embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1, embedding: vector } }
    const unrelated = { article: { id: 'unrelated', titleOriginal: 'Tin khac', embeddingStatus: 'ready', embeddingModel: 'baai/bge-m3', embeddingDimensions: 1024, embeddingVersion: 1, embedding: new Array(1024).fill(0) } }
    const result = rankQnaEvidence({ question: 'Lam sao giam chi phi van hanh may chu?', queryEmbedding: { model: 'baai/bge-m3', dimensions: 1024, version: 1, embedding: vector }, records: [semantic, unrelated], relevanceThreshold: 0.5 })
    expect(result.map(({ article }) => article.id)).toEqual(['semantic'])
  })
})
