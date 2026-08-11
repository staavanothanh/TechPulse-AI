import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BGE_M3 } from '../ai/embedding.js'
import { rankHybridCandidates } from '../ai/retrieval.js'

export const BGE_M3_VI_EVAL_VERSION = 'bge-m3-vi-real-v1'
export const BGE_M3_VI_FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/ai/bge-m3-vi-real-v1.json', import.meta.url))

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export function retrievalFixtureDigest(value) {
  const copy = { ...value }
  delete copy.fixtureDigest
  return createHash('sha256').update(stableJson(copy)).digest('hex')
}

function validVector(value) {
  return Array.isArray(value) && value.length === BGE_M3.dimensions && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{1,127}$/.test(value)
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function loadFixture(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function validateFixture(fixture) {
  if (!fixture || typeof fixture !== 'object' || fixture.fixtureVersion !== BGE_M3_VI_EVAL_VERSION || fixture.fixtureDigest !== retrievalFixtureDigest(fixture)) throw new Error('retrieval_fixture_invalid')
  const provenance = fixture.provenance
  if (!provenance || provenance.model !== BGE_M3.model || provenance.dimensions !== BGE_M3.dimensions || provenance.embeddingVersion !== BGE_M3.version || provenance.providerId !== 'openrouter' || provenance.endpointId !== 'openrouter-embeddings' || Number.isNaN(new Date(provenance.generatedAt).getTime()) || !Array.isArray(provenance.inputIds) || provenance.inputIds.some(({ id, hash }) => !validIdentifier(id) || !validHash(hash))) throw new Error('retrieval_fixture_invalid')
  if (!Array.isArray(fixture.queries) || !Array.isArray(fixture.documents) || !Array.isArray(fixture.cases) || fixture.cases.length < 5) throw new Error('retrieval_fixture_invalid')
  const queries = new Map(fixture.queries.map((item) => [item?.id, item]))
  const documents = new Map(fixture.documents.map((item) => [item?.id, item]))
  if (queries.size !== fixture.queries.length || documents.size !== fixture.documents.length) throw new Error('retrieval_fixture_invalid')
  for (const item of [...fixture.queries, ...fixture.documents]) if (!validIdentifier(item?.id) || !validHash(item?.inputHash) || !validVector(item?.embedding)) throw new Error('retrieval_fixture_invalid')
  for (const item of fixture.cases) if (!validIdentifier(item?.queryId) || !validIdentifier(item?.targetId) || !queries.has(item.queryId) || !documents.has(item.targetId)) throw new Error('retrieval_fixture_invalid')
  return fixture
}

export function runRetrievalEvaluation({ fixture, fixturePath = BGE_M3_VI_FIXTURE_PATH } = {}) {
  let verified
  try { verified = validateFixture(fixture ?? loadFixture(fixturePath)) } catch {
    return Object.freeze({ model: BGE_M3.model, dimensions: BGE_M3.dimensions, version: BGE_M3.version, datasetVersion: BGE_M3_VI_EVAL_VERSION, queries: 0, top5Rate: 0, passed: false, reason: 'fixture_unavailable', details: Object.freeze([]) })
  }
  const candidates = verified.documents.map((item) => ({ id: item.id, embedding: item.embedding, embeddingStatus: 'ready', embeddingModel: BGE_M3.model, embeddingDimensions: BGE_M3.dimensions, embeddingVersion: BGE_M3.version, textScore: 0 }))
  let top5Hits = 0
  const details = verified.cases.map(({ queryId, targetId }) => {
    const query = verified.queries.find((item) => item.id === queryId)
    const top5 = rankHybridCandidates({ queryVector: query.embedding, queryModel: BGE_M3.model, queryDimensions: BGE_M3.dimensions, queryVersion: BGE_M3.version, candidates }).slice(0, 5).map(({ id }) => id)
    const hit = top5.includes(targetId)
    if (hit) top5Hits += 1
    return Object.freeze({ queryId, targetId, hit, rank: top5.indexOf(targetId) + 1 })
  })
  const top5Rate = top5Hits / verified.cases.length
  return Object.freeze({ model: BGE_M3.model, dimensions: BGE_M3.dimensions, version: BGE_M3.version, datasetVersion: verified.fixtureVersion, queries: verified.cases.length, top5Rate, passed: top5Rate === 1, details: Object.freeze(details) })
}
