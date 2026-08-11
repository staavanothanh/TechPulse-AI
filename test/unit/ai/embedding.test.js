import { describe, expect, it } from 'vitest'
import { BGE_M3, validateBgeM3Embedding } from '../../../server/ai/embedding.js'

describe('Step 9 BGE-M3 embedding boundary', () => {
  it('pins the exact model, dimensions and version', () => {
    expect(BGE_M3).toEqual({ model: 'baai/bge-m3', dimensions: 1024, version: 1 })
    const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0)
    expect(validateBgeM3Embedding({ model: 'baai/bge-m3', embedding: vector })).toEqual(vector)
  })

  it('rejects alternate models, wrong dimensions and non-finite values without fallback', () => {
    const vector = Array(1024).fill(0)
    expect(() => validateBgeM3Embedding({ model: 'nvidia/alternate', embedding: vector })).toThrow(/model/i)
    expect(() => validateBgeM3Embedding({ model: 'baai/bge-m3', embedding: vector.slice(1) })).toThrow(/1024/)
    vector[7] = Number.NaN
    expect(() => validateBgeM3Embedding({ model: 'baai/bge-m3', embedding: vector })).toThrow(/finite/i)
  })
})
