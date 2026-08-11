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
