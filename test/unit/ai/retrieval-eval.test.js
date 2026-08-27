import { describe, expect, it } from 'vitest'
import { retrievalFixtureDigest, runRetrievalEvaluation } from '../../../server/evals/retrieval.js'

function vector(index) {
  return Array.from({ length: 1024 }, (_value, position) => position === index ? 1 : 0)
}

function fixture() {
  const queryIds = ['q-chip-ai', 'q-ai-safety', 'q-vietnamese-model', 'q-cloud', 'q-robot', 'q-security']
  const queries = queryIds.map((id, index) => ({ id, inputHash: `${index + 1}`.padStart(64, '0'), embedding: vector(index) }))
  const documents = queryIds.map((id, index) => ({ id: `doc-${id.slice(2)}`, inputHash: `${index + 11}`.padStart(64, '0'), embedding: vector(index) }))
  const value = {
    fixtureVersion: 'bge-m3-vi-real-v1',
    provenance: { providerId: 'openrouter', endpointId: 'openrouter-embeddings', model: 'baai/bge-m3', dimensions: 1024, embeddingVersion: 1, artifactCompatibilityId: 'bge-m3-v1-1024', generatedAt: '2026-08-11T00:00:00.000Z', inputIds: [...queries, ...documents].map(({ id, inputHash: hash }) => ({ id, hash })) },
    queries,
    documents,
    cases: queryIds.map((id) => ({ queryId: id, targetId: `doc-${id.slice(2)}` })),
  }
  return { ...value, fixtureDigest: retrievalFixtureDigest(value) }
}

describe('Step 9 retrieval top-five eval harness', () => {
  it('requires each versioned BGE-M3 fixture target in top five', () => {
    const report = runRetrievalEvaluation({ fixture: fixture() })
    expect(report).toEqual(expect.objectContaining({ model: 'baai/bge-m3', dimensions: 1024, version: 1, datasetVersion: 'bge-m3-vi-real-v1', queries: expect.any(Number), top5Rate: 1, passed: true }))
    expect(report.queries).toBeGreaterThanOrEqual(5)
    expect(report.details.every(({ queryId, targetId }) => typeof queryId === 'string' && typeof targetId === 'string')).toBe(true)
  })

  it('fails closed for a fixture whose provenance digest does not match', () => {
    const invalid = { ...fixture(), fixtureDigest: '0'.repeat(64) }
    expect(runRetrievalEvaluation({ fixture: invalid })).toMatchObject({ passed: false, reason: 'fixture_unavailable' })
  })

  it('uses fixture provenance instead of a vendor or model constant', () => {
    const value = fixture()
    const configured = {
      ...value,
      provenance: {
        ...value.provenance,
        providerId: 'configured-provider',
        endpointId: 'configured-embedding-endpoint',
        model: 'configured-embedding-model',
        artifactCompatibilityId: 'configured-embedding-v1',
      },
    }
    const report = runRetrievalEvaluation({ fixture: { ...configured, fixtureDigest: retrievalFixtureDigest(configured) } })
    expect(report).toEqual(expect.objectContaining({
      providerId: 'configured-provider',
      endpointId: 'configured-embedding-endpoint',
      model: 'configured-embedding-model',
      artifactCompatibilityId: 'configured-embedding-v1',
      passed: true,
    }))
  })

  it('rejects a fixture when an explicitly expected route identity differs', () => {
    const value = fixture()
    const configured = {
      ...value,
      provenance: {
        ...value.provenance,
        providerId: 'configured-provider',
        endpointId: 'configured-embedding-endpoint',
        model: 'configured-embedding-model',
        artifactCompatibilityId: 'configured-embedding-v1',
      },
    }
    const valid = { ...configured, fixtureDigest: retrievalFixtureDigest(configured) }
    expect(runRetrievalEvaluation({
      fixture: valid,
      embeddingSpec: { providerId: 'other-provider', endpointId: 'configured-embedding-endpoint', model: 'configured-embedding-model', dimensions: 1024, version: 1, artifactCompatibilityId: 'configured-embedding-v1' },
    })).toMatchObject({ passed: false, reason: 'fixture_unavailable' })
  })
})
