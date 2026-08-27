import { describe, expect, it } from 'vitest'
import { cosineSimilarity, rankHybridCandidates, rankQnaEvidence } from '../../../server/ai/retrieval.js'

const compatible = { embeddingModel: 'embedding-model-v1', embeddingDimensions: 2, embeddingVersion: 1, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingStatus: 'ready' }

describe('Step 9 application cosine retrieval', () => {
  it('combines normalized text and cosine only for exact compatible vectors', () => {
    const queryVector = [1, 0]
    const ranked = rankHybridCandidates({
      queryVector,
      queryModel: 'embedding-model-v1',
      queryDimensions: 2,
      queryVersion: 1,
      queryArtifactCompatibilityId: 'embedding-compat-v1',
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
    expect(rankHybridCandidates({ queryVector: [1, 0], queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: 'embedding-compat-v1', candidates: [{ id: 'bad', textScore: 1, ...compatible, embeddingDimensions: 12, embedding: [1, 0] }] })).toEqual([])
    expect(rankHybridCandidates({ queryVector: [1, 0], queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: 'embedding-compat-other', candidates: [{ id: 'bad', textScore: 1, ...compatible, embedding: [1, 0] }] })).toEqual([])
  })

  it('strictly requires non-empty artifactCompatibilityId on both query and candidate', () => {
    const queryVector = [1, 0]
    expect(rankHybridCandidates({ queryVector, queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: '', candidates: [{ id: 'c1', textScore: 0.5, ...compatible, embedding: [1, 0] }] })).toEqual([])
    expect(rankHybridCandidates({ queryVector, queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: undefined, candidates: [{ id: 'c1', textScore: 0.5, ...compatible, embedding: [1, 0] }] })).toEqual([])
    expect(rankHybridCandidates({ queryVector, queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: 'embedding-compat-v1', candidates: [{ id: 'c1', textScore: 0.5, ...compatible, embeddingArtifactCompatibilityId: '', embedding: [1, 0] }] })).toEqual([])
    expect(rankHybridCandidates({ queryVector, queryModel: 'embedding-model-v1', queryDimensions: 2, queryVersion: 1, queryArtifactCompatibilityId: 'embedding-compat-v1', candidates: [{ id: 'c1', textScore: 0.5, ...compatible, embeddingArtifactCompatibilityId: undefined, embedding: [1, 0] }] })).toEqual([])
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
    const vector = new Array(3).fill(0)
    vector[0] = 1
    const semantic = { article: { id: 'semantic', titleOriginal: 'Toi uu tai nguyen cum may chu', embeddingStatus: 'ready', embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingVersion: 1, embedding: vector } }
    const unrelated = { article: { id: 'unrelated', titleOriginal: 'Tin khac', embeddingStatus: 'ready', embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingVersion: 1, embedding: new Array(3).fill(0) } }
    const result = rankQnaEvidence({ question: 'Lam sao giam chi phi van hanh may chu?', queryEmbedding: { model: 'embedding-model-v1', dimensions: 3, version: 1, artifactCompatibilityId: 'embedding-compat-v1', embedding: vector }, records: [semantic, unrelated], relevanceThreshold: 0.5 })
    expect(result.map(({ article }) => article.id)).toEqual(['semantic'])
  })

  it('degrades to the full lexical score when embedding compatibility mismatches', () => {
    const records = [{ article: {
      id: 'lexical-only', titleOriginal: 'Chip AI tiet kiem dien', embeddingStatus: 'ready',
      embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1',
      embeddingVersion: 1, embedding: [1, 0, 0],
    } }]
    const result = rankQnaEvidence({
      question: 'Chip AI tiet kiem dien?',
      queryEmbedding: { model: 'embedding-model-v1', dimensions: 3, version: 1, artifactCompatibilityId: 'embedding-compat-v2', embedding: [1, 0, 0] },
      records,
      relevanceThreshold: 0.9,
    })

    expect(result.map(({ article }) => article.id)).toEqual(['lexical-only'])
  })

  it('selects semantic-only candidate despite zero lexical term overlap for mixed-language or typo queries', () => {
    const vector = [1, 0, 0]
    const records = [
      { article: { id: 'security-article', titleOriginal: 'An ninh mạng và phòng chống tấn công', excerptOriginal: 'Các giải pháp bảo vệ hệ thống thông tin.', topics: ['security'], embeddingStatus: 'ready', embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingVersion: 1, embedding: vector } },
      { article: { id: 'other-article', titleOriginal: 'Thị trường chứng khoán', excerptOriginal: 'Chỉ số biến động mạnh.', topics: ['finance'], embeddingStatus: 'ready', embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingVersion: 1, embedding: [0, 1, 0] } },
    ]
    const result = rankQnaEvidence({
      question: 'How to ensure cybersecurity and defense?',
      queryEmbedding: { model: 'embedding-model-v1', dimensions: 3, version: 1, artifactCompatibilityId: 'embedding-compat-v1', embedding: vector },
      records,
      relevanceThreshold: 0.25,
    })
    expect(result.map(({ article }) => article.id)).toEqual(['security-article'])
  })

  it('allows exact-compatible semantic candidate to survive when query terms are entirely stop words', () => {
    const vector = [1, 0, 0]
    const records = [
      { article: { id: 'semantic-match', titleOriginal: 'Thông tin công nghệ', embeddingStatus: 'ready', embeddingModel: 'embedding-model-v1', embeddingDimensions: 3, embeddingArtifactCompatibilityId: 'embedding-compat-v1', embeddingVersion: 1, embedding: vector } },
    ]
    const result = rankQnaEvidence({
      question: 'có là gì thế nào',
      queryEmbedding: { model: 'embedding-model-v1', dimensions: 3, version: 1, artifactCompatibilityId: 'embedding-compat-v1', embedding: vector },
      records,
      relevanceThreshold: 0.25,
    })
    expect(result.map(({ article }) => article.id)).toEqual(['semantic-match'])
    expect(rankQnaEvidence({ question: 'có là gì thế nào', records })).toEqual([])
  })
})
