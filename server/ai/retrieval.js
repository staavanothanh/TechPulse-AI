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
    && typeof input.queryModel === 'string'
    && input.queryModel.length > 0
    && candidate.embeddingModel === input.queryModel
    && Number.isInteger(input.queryDimensions)
    && input.queryDimensions > 0
    && candidate.embeddingDimensions === input.queryDimensions
    && Number.isInteger(input.queryVersion)
    && input.queryVersion > 0
    && candidate.embeddingVersion === input.queryVersion
    && typeof input.queryArtifactCompatibilityId === 'string'
    && input.queryArtifactCompatibilityId.length > 0
    && typeof candidate.embeddingArtifactCompatibilityId === 'string'
    && candidate.embeddingArtifactCompatibilityId.length > 0
    && candidate.embeddingArtifactCompatibilityId === input.queryArtifactCompatibilityId
    && Array.isArray(candidate.embedding)
    && Array.isArray(input.queryVector)
    && input.queryVector.length === input.queryDimensions
    && candidate.embedding.length === input.queryDimensions
    && candidate.embedding.every((val) => typeof val === 'number' && Number.isFinite(val))
    && input.queryVector.every((val) => typeof val === 'number' && Number.isFinite(val))
}

export function rankHybridCandidates({ queryVector, queryModel, queryDimensions, queryVersion, queryArtifactCompatibilityId, candidates = [], textWeight = 0.45, semanticWeight = 0.55 } = {}) {
  if (!Number.isFinite(textWeight) || !Number.isFinite(semanticWeight) || textWeight < 0 || semanticWeight < 0 || Math.abs(textWeight + semanticWeight - 1) > Number.EPSILON * 4) throw new Error('Hybrid ranking weights are invalid')
  return candidates.flatMap((candidate) => {
    if (!compatible(candidate, { queryVector, queryModel, queryDimensions, queryVersion, queryArtifactCompatibilityId })) return []
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
  const semanticReady = typeof queryEmbedding?.model === 'string'
    && queryEmbedding.model.length > 0
    && Number.isInteger(queryEmbedding?.dimensions)
    && queryEmbedding.dimensions > 0
    && Number.isInteger(queryEmbedding?.version)
    && queryEmbedding.version > 0
    && typeof queryEmbedding?.artifactCompatibilityId === 'string'
    && queryEmbedding.artifactCompatibilityId.length > 0
    && Array.isArray(queryEmbedding.embedding)
    && queryEmbedding.embedding.length === queryEmbedding.dimensions
    && queryEmbedding.embedding.every((item) => typeof item === 'number' && Number.isFinite(item))
  if (terms.length === 0 && !semanticReady) return []
  const ranked = records.flatMap((record, index) => {
    const textTerms = new Set(queryTerms(evidenceText(record)))
    const lexicalScore = terms.length > 0 ? terms.filter((term) => textTerms.has(term)).length / terms.length : 0
    const article = record?.article ?? record
    const candidate = { ...article, embeddingStatus: article?.embeddingStatus, embeddingModel: article?.embeddingModel, embeddingDimensions: article?.embeddingDimensions, embeddingArtifactCompatibilityId: article?.embeddingArtifactCompatibilityId, embeddingVersion: article?.embeddingVersion, embedding: article?.embedding, textScore: lexicalScore }
    const hybrid = semanticReady ? rankHybridCandidates({ queryVector: queryEmbedding.embedding, queryModel: queryEmbedding.model, queryDimensions: queryEmbedding.dimensions, queryVersion: queryEmbedding.version, queryArtifactCompatibilityId: queryEmbedding.artifactCompatibilityId, candidates: [candidate], textWeight: 0.45, semanticWeight: 0.55 })[0] : null
    let score = lexicalScore
    if (hybrid) {
      const combined = 0.45 * lexicalScore + 0.55 * hybrid.semanticScore
      score = terms.length === 0 ? hybrid.semanticScore : (hybrid.semanticScore >= relevanceThreshold ? Math.max(combined, hybrid.semanticScore) : combined)
    }
    return score >= relevanceThreshold ? [{ record, relevanceScore: Number(score.toFixed(6)), index }] : []
  }).sort((left, right) => right.relevanceScore - left.relevanceScore || left.index - right.index)
  return ranked.slice(0, Math.min(50, Math.max(1, maxCandidates))).map(({ record }) => record)
}
