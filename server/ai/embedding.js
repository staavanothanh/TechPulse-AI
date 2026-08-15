export const DEFAULT_EMBEDDING_DIMENSIONS = 1024
export const DEFAULT_EMBEDDING_VERSION = 1

export function validateEmbeddingVector(value, { dimensions = DEFAULT_EMBEDDING_DIMENSIONS } = {}) {
  if (!Number.isInteger(dimensions) || dimensions < 1) throw new Error('Embedding dimensions are invalid')
  if (!Array.isArray(value) || value.length !== dimensions) throw new Error(`Embedding must contain exactly ${dimensions} dimensions`)
  if (value.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Embedding values must be finite numbers')
  return Object.freeze([...value])
}
