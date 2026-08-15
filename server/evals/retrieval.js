import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { rankHybridCandidates } from '../ai/retrieval.js'

// This path points at the checked-in benchmark artifact. The evaluator itself
// does not assume the provider, endpoint, model or vector space used to create
// that artifact; those identities are validated from its signed provenance.
export const DEFAULT_RETRIEVAL_FIXTURE_PATH = fileURLToPath(new URL('../../test/fixtures/ai/bge-m3-vi-real-v1.json', import.meta.url))

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

function validVector(value, dimensions) {
  return Array.isArray(value) && value.length === dimensions && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

function validIdentifier(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{1,127}$/.test(value)
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function validSpecIdentifier(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(value)
}

function loadFixture(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function normalizeSpec(provenance) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('retrieval_fixture_invalid')
  const spec = {
    providerId: provenance.providerId,
    endpointId: provenance.endpointId,
    model: provenance.model,
    dimensions: provenance.dimensions,
    version: provenance.embeddingVersion,
    ...(provenance.artifactCompatibilityId !== undefined ? { artifactCompatibilityId: provenance.artifactCompatibilityId } : {}),
  }
  if (!validSpecIdentifier(spec.providerId) || !validSpecIdentifier(spec.endpointId) || !validSpecIdentifier(spec.model)
    || !Number.isSafeInteger(spec.dimensions) || spec.dimensions < 1 || spec.dimensions > 4096
    || !Number.isSafeInteger(spec.version) || spec.version < 1
    || spec.artifactCompatibilityId !== undefined && !validSpecIdentifier(spec.artifactCompatibilityId)) throw new Error('retrieval_fixture_invalid')
  return Object.freeze(spec)
}

function matchesExpectedSpec(actual, expected) {
  if (expected === undefined) return true
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false
  const fields = ['providerId', 'endpointId', 'model', 'dimensions', 'version', 'artifactCompatibilityId']
  return fields.every((field) => expected[field] === undefined || expected[field] === actual[field])
}

function validateFixture(fixture, embeddingSpec) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)
    || typeof fixture.fixtureVersion !== 'string' || fixture.fixtureVersion.length < 1
    || fixture.fixtureDigest !== retrievalFixtureDigest(fixture)) throw new Error('retrieval_fixture_invalid')
  const provenance = fixture.provenance
  const spec = normalizeSpec(provenance)
  if (!matchesExpectedSpec(spec, embeddingSpec)
    || Number.isNaN(new Date(provenance.generatedAt).getTime())
    || !Array.isArray(provenance.inputIds)
    || provenance.inputIds.some(({ id, hash }) => !validIdentifier(id) || !validHash(hash))) throw new Error('retrieval_fixture_invalid')
  if (!Array.isArray(fixture.queries) || !Array.isArray(fixture.documents) || !Array.isArray(fixture.cases) || fixture.cases.length < 1) throw new Error('retrieval_fixture_invalid')
  const queries = new Map(fixture.queries.map((item) => [item?.id, item]))
  const documents = new Map(fixture.documents.map((item) => [item?.id, item]))
  if (queries.size !== fixture.queries.length || documents.size !== fixture.documents.length) throw new Error('retrieval_fixture_invalid')
  for (const item of [...fixture.queries, ...fixture.documents]) if (!validIdentifier(item?.id) || !validHash(item?.inputHash) || !validVector(item?.embedding, spec.dimensions)) throw new Error('retrieval_fixture_invalid')
  for (const item of fixture.cases) if (!validIdentifier(item?.queryId) || !validIdentifier(item?.targetId) || !queries.has(item.queryId) || !documents.has(item.targetId)) throw new Error('retrieval_fixture_invalid')
  return Object.freeze({ fixture, spec, queries, documents })
}

function unavailableReport() {
  return Object.freeze({ queries: 0, top5Rate: 0, passed: false, reason: 'fixture_unavailable', details: Object.freeze([]) })
}

export function runRetrievalEvaluation({ fixture, fixturePath = DEFAULT_RETRIEVAL_FIXTURE_PATH, embeddingSpec } = {}) {
  let verified
  try {
    verified = validateFixture(fixture ?? loadFixture(fixturePath), embeddingSpec)
  } catch {
    return unavailableReport()
  }
  const { spec, queries, documents } = verified
  const candidates = [...documents.values()].map((item) => ({
    id: item.id,
    embedding: item.embedding,
    embeddingStatus: 'ready',
    embeddingModel: spec.model,
    embeddingDimensions: spec.dimensions,
    embeddingVersion: spec.version,
    ...(spec.artifactCompatibilityId !== undefined ? { embeddingArtifactCompatibilityId: spec.artifactCompatibilityId } : {}),
    textScore: 0,
  }))
  let top5Hits = 0
  const details = verified.fixture.cases.map(({ queryId, targetId }) => {
    const query = queries.get(queryId)
    const top5 = rankHybridCandidates({
      queryVector: query.embedding,
      queryModel: spec.model,
      queryDimensions: spec.dimensions,
      queryVersion: spec.version,
      ...(spec.artifactCompatibilityId !== undefined ? { queryArtifactCompatibilityId: spec.artifactCompatibilityId } : {}),
      candidates,
    }).slice(0, 5).map(({ id }) => id)
    const hit = top5.includes(targetId)
    if (hit) top5Hits += 1
    return Object.freeze({ queryId, targetId, hit, rank: top5.indexOf(targetId) + 1 })
  })
  const top5Rate = top5Hits / verified.fixture.cases.length
  return Object.freeze({
    providerId: spec.providerId,
    endpointId: spec.endpointId,
    model: spec.model,
    dimensions: spec.dimensions,
    version: spec.version,
    ...(spec.artifactCompatibilityId !== undefined ? { artifactCompatibilityId: spec.artifactCompatibilityId } : {}),
    datasetVersion: verified.fixture.fixtureVersion,
    queries: verified.fixture.cases.length,
    top5Rate,
    passed: top5Rate === 1,
    details: Object.freeze(details),
  })
}
