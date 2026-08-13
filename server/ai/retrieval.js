import { BGE_M3 } from './embedding.js'

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length === 0 || left.length !== right.length) throw new Error('Embedding dimensions must match')
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error('Embedding values must be finite')
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return Math.max(-1, Math.min(1, dot / Math.sqrt(leftNorm * rightNorm)))
}

function compatible(candidate, input) {
  return candidate?.embeddingStatus === 'ready'
    && candidate.embeddingModel === input.queryModel
    && candidate.embeddingDimensions === input.queryDimensions
    && candidate.embeddingVersion === input.queryVersion
    && Array.isArray(candidate.embedding)
    && candidate.embedding.length === input.queryVector.length
}

export function rankHybridCandidates({ queryVector, queryModel, queryDimensions, queryVersion, candidates = [], textWeight = 0.45, semanticWeight = 0.55 } = {}) {
  if (!Number.isFinite(textWeight) || !Number.isFinite(semanticWeight) || textWeight < 0 || semanticWeight < 0 || Math.abs(textWeight + semanticWeight - 1) > Number.EPSILON * 4) throw new Error('Hybrid ranking weights are invalid')
  return candidates.flatMap((candidate) => {
    if (!compatible(candidate, { queryVector, queryModel, queryDimensions, queryVersion })) return []
    const textScore = Math.max(0, Math.min(1, Number(candidate.textScore) || 0))
    const semanticScore = Math.max(0, cosineSimilarity(queryVector, candidate.embedding))
    return [{ ...candidate, textScore, semanticScore, score: Number((textWeight * textScore + semanticWeight * semanticScore).toFixed(12)) }]
  }).sort((left, right) => right.score - left.score || right.textScore - left.textScore || String(left.id).localeCompare(String(right.id)))
}

const QNA_STOP_WORDS = new Set(['va', 'la', 'gi', 'the', 'nao', 'co', 'cua', 'cho', 'mot', 'nhung', 'duoc', 'trong', 'tu', 'voi', 've', 'nào', 'gì', 'là'])

function queryTerms(value) {
  return [...new Set(String(value ?? '')
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/đ/gi, 'd')
    .toLocaleLowerCase('vi')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 && !QNA_STOP_WORDS.has(term)))]
}

function evidenceText(record) {
  const article = record?.article ?? record
  return [article?.titleOriginal, article?.titleVi, article?.summaryVi, article?.excerptOriginal, ...(article?.topics ?? [])].filter(Boolean).join(' ')
}

/**
 * Rerank a bounded visible evidence set against the admitted question.
 * The score is an internal admission value and is never part of a public DTO.
 */
export function rankQnaEvidence({ question, records = [], queryEmbedding, relevanceThreshold = 0.25, maxCandidates = 50 } = {}) {
  if (typeof question !== 'string' || question.trim().length === 0 || !Array.isArray(records)) return []
  if (!Number.isFinite(relevanceThreshold) || relevanceThreshold < 0 || relevanceThreshold > 1) throw new Error('Q&A relevance threshold is invalid')
  const terms = queryTerms(question)
  if (terms.length === 0) return []
  const semanticReady = queryEmbedding?.model === BGE_M3.model
    && queryEmbedding?.dimensions === BGE_M3.dimensions
    && queryEmbedding?.version === BGE_M3.version
    && Array.isArray(queryEmbedding.embedding)
    && queryEmbedding.embedding.length === BGE_M3.dimensions
  const ranked = records.flatMap((record, index) => {
    const textTerms = new Set(queryTerms(evidenceText(record)))
    const lexicalScore = terms.filter((term) => textTerms.has(term)).length / terms.length
    const article = record?.article ?? record
    const candidate = { ...article, embeddingStatus: article?.embeddingStatus, embeddingModel: article?.embeddingModel, embeddingDimensions: article?.embeddingDimensions, embeddingVersion: article?.embeddingVersion, embedding: article?.embedding, textScore: lexicalScore }
    const semantic = semanticReady ? rankHybridCandidates({ queryVector: queryEmbedding.embedding, queryModel: BGE_M3.model, queryDimensions: BGE_M3.dimensions, queryVersion: BGE_M3.version, candidates: [candidate], textWeight: 0.45, semanticWeight: 0.55 })[0]?.semanticScore ?? 0 : null
    const score = semanticReady ? 0.45 * lexicalScore + 0.55 * semantic : lexicalScore
    return score >= relevanceThreshold ? [{ record, relevanceScore: Number(score.toFixed(6)), index }] : []
  }).sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index)
  return ranked.slice(0, Math.min(50, Math.max(1, maxCandidates))).map(({ record }) => record)
}
