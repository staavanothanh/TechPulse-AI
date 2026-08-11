export const BGE_M3 = Object.freeze({ model: 'baai/bge-m3', dimensions: 1024, version: 1 })

export function validateBgeM3Embedding(value) {
  if (!value || value.model !== BGE_M3.model) throw new Error('Embedding model must be baai/bge-m3')
  if (!Array.isArray(value.embedding) || value.embedding.length !== BGE_M3.dimensions) throw new Error('BGE-M3 embedding must contain exactly 1024 dimensions')
  if (value.embedding.some((item) => typeof item !== 'number' || !Number.isFinite(item))) throw new Error('Embedding values must be finite numbers')
  return Object.freeze([...value.embedding])
}
