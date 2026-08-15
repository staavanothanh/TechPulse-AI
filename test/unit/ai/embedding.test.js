import { describe, expect, it } from 'vitest'
import { DEFAULT_EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_VERSION, validateEmbeddingVector } from '../../../server/ai/embedding.js'

describe('Step 9 configured embedding boundary', () => {
  it('keeps dimensions and artifact version generic while validating the vector', () => {
    expect({ dimensions: DEFAULT_EMBEDDING_DIMENSIONS, version: DEFAULT_EMBEDDING_VERSION }).toEqual({ dimensions: 1024, version: 1 })
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    expect(validateEmbeddingVector(vector, { dimensions: 1024 })).toEqual(vector)
  })

  it('rejects invalid dimensions and non-finite values without choosing a model', () => {
    const vector = Array(1024).fill(0)
    expect(() => validateEmbeddingVector(vector.slice(1), { dimensions: 1024 })).toThrow(/1024/)
    expect(() => validateEmbeddingVector(vector, { dimensions: 0 })).toThrow(/dimensions/i)
    vector[7] = Number.NaN
    expect(() => validateEmbeddingVector(vector, { dimensions: 1024 })).toThrow(/finite/i)
  })
})
