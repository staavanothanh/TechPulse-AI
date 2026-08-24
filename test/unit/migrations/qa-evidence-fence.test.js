import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from '../../../scripts/migrations/provider-routing-v2.js'
import { SOURCE_COLLECTIONS } from '../../../scripts/migrations/sources.js'
import {
  QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
  QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
  buildQaEvidenceFenceMigration,
  runQaEvidenceFenceMigration,
} from '../../../scripts/migrations/qa-evidence-fence.js'
import { RUNTIME_SCHEMA_GENERATIONS } from '../../../server/bootstrap/schema-readiness.js'

function withoutArticleFenceToken(validator) {
  const copy = structuredClone(validator)
  delete copy.$or[0].$and[0].$jsonSchema.properties.qnaFenceToken
  return copy
}

function withoutSourceFenceToken(validator) {
  const copy = structuredClone(validator)
  delete copy.$and[0].$jsonSchema.properties.qnaFenceToken
  return copy
}

describe('QA evidence fence migration contract', () => {
  function createMigrationDb({
    articleValidator = PROVIDER_ROUTING_ARTICLE_VALIDATOR,
    sourceValidator = SOURCE_COLLECTIONS.sources.validator,
  } = {}) {
    return {
      listCollections: vi.fn(() => ({
        toArray: async () => [
          { name: 'articles', options: { validator: articleValidator } },
          { name: 'sources', options: { validator: sourceValidator } },
        ],
      })),
      command: vi.fn(async () => ({ ok: 1 })),
    }
  }

  it('derives the current article validator and preserves the tombstone branch', () => {
    const currentSchema = QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR.$or[0].$and[0].$jsonSchema

    expect(currentSchema.additionalProperties).toBe(false)
    expect(currentSchema.required).not.toContain('qnaFenceToken')
    expect(currentSchema.properties.qnaFenceToken).toEqual({ bsonType: 'objectId' })
    expect(QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR.$or).toHaveLength(PROVIDER_ROUTING_ARTICLE_VALIDATOR.$or.length)
    expect(QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR.$or[1]).toEqual(PROVIDER_ROUTING_ARTICLE_VALIDATOR.$or[1])
    expect(withoutArticleFenceToken(QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR)).toEqual(PROVIDER_ROUTING_ARTICLE_VALIDATOR)
  })

  it('derives the current source validator without weakening its closed schema or rules', () => {
    const currentSchema = QA_EVIDENCE_FENCE_SOURCE_VALIDATOR.$and[0].$jsonSchema

    expect(currentSchema.additionalProperties).toBe(false)
    expect(currentSchema.required).not.toContain('qnaFenceToken')
    expect(currentSchema.properties.qnaFenceToken).toEqual({ bsonType: 'objectId' })
    expect(QA_EVIDENCE_FENCE_SOURCE_VALIDATOR.$and).toHaveLength(SOURCE_COLLECTIONS.sources.validator.$and.length)
    expect(withoutSourceFenceToken(QA_EVIDENCE_FENCE_SOURCE_VALIDATOR)).toEqual(SOURCE_COLLECTIONS.sources.validator)
  })

  it('builds a forward-only idempotent collMod plan for both fenced collections', () => {
    const plan = buildQaEvidenceFenceMigration()
    const dryRunPlan = buildQaEvidenceFenceMigration({ dryRun: true })

    expect(plan).toHaveLength(2)
    expect(plan.every(({ type }) => type === 'collMod')).toBe(true)
    expect(plan.some(({ type }) => type.startsWith('drop'))).toBe(false)
    expect(plan).toEqual(expect.arrayContaining([
      {
        type: 'collMod',
        collection: 'articles',
        options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
      },
      {
        type: 'collMod',
        collection: 'sources',
        options: { validator: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR, validationLevel: 'strict', validationAction: 'error' },
      },
    ]))
    expect(dryRunPlan).toEqual(plan.map((operation) => ({ ...operation, dryRun: true })))
  })

  it('runs every collMod operation and applies the exact fenced validators', async () => {
    const db = createMigrationDb()

    const plan = await runQaEvidenceFenceMigration({ db })

    expect(db.command).toHaveBeenCalledTimes(2)
    expect(db.command).toHaveBeenNthCalledWith(1, {
      collMod: 'articles',
      validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
    })
    expect(db.command).toHaveBeenNthCalledWith(2, {
      collMod: 'sources',
      validator: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
    })
    expect(plan).toEqual(buildQaEvidenceFenceMigration())
  })

  it('fails closed before writes when provider-routing-v2 predecessors are absent', async () => {
    const db = createMigrationDb({ articleValidator: { $jsonSchema: { bsonType: 'object' } } })

    await expect(runQaEvidenceFenceMigration({ db })).rejects.toThrow(/provider-routing-v2/i)
    expect(db.command).not.toHaveBeenCalled()
  })

  it('is idempotent when the exact fenced validators are already installed', async () => {
    const db = createMigrationDb({
      articleValidator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR,
      sourceValidator: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR,
    })

    await expect(runQaEvidenceFenceMigration({ db })).resolves.toHaveLength(2)
    expect(db.command).toHaveBeenCalledTimes(2)
  })

  it('wires the standalone target through verification and Q&A release readiness', () => {
    const migrate = readFileSync(new URL('../../../scripts/db-migrate.js', import.meta.url), 'utf8')
    const verify = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    const runtime = readFileSync(new URL('../../../server/bootstrap/lazy-runtime.js', import.meta.url), 'utf8')

    expect(migrate).toContain("./migrations/qa-evidence-fence.js")
    expect(migrate).toContain("'qa-evidence-fence'")
    expect(migrate).toContain('runQaEvidenceFenceMigration')
    expect(verify).toContain("./migrations/qa-evidence-fence.js")
    expect(verify).toContain("'qa-evidence-fence'")
    expect(verify).toContain('QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR')
    expect(verify).toContain('QA_EVIDENCE_FENCE_SOURCE_VALIDATOR')
    expect(verify).toMatch(/governance-tombstone[\s\S]*QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR/)
    expect(RUNTIME_SCHEMA_GENERATIONS['qa-evidence-fence']).toBe('qa-evidence-fence-v1')
    expect(runtime).toContain("createReleaseVerifiedSchemaVerifier('qa-evidence-fence', environment)")
    expect(runtime).toMatch(/verifyEvidenceSchema[\s\S]*createConfiguredQaService/)
  })

  it('keeps successor verification and role attestation compatible with the fenced validators', () => {
    const verify = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')

    expect(verify).toMatch(/target === 'provider-routing-v2' && name === 'articles'[\s\S]*QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR/)
    expect(verify).toMatch(/target === 'qa-evidence-fence'\s*\?\s*\[\]/)
    expect(verify).toMatch(/Q&A evidence article path.*required: \['find', 'update', 'listIndexes', 'listCollections'\]/)
    expect(verify).toMatch(/Q&A evidence source path.*required: \['find', 'update', 'listIndexes', 'listCollections'\]/)
  })

  it('reapplies the QA fence after every migration target that can downgrade its validators', () => {
    const migrate = readFileSync(new URL('../../../scripts/db-migrate.js', import.meta.url), 'utf8')

    expect(migrate).toMatch(/target === 'provider-routing-v2'[\s\S]*buildMigration\(\{ dryRun: true \}\)[\s\S]*buildQaEvidenceFenceMigration\(\{ dryRun: true \}\)/)
    expect(migrate).toMatch(/runProviderRoutingV2Migration\(\{ db: context\.db \}\)[\s\S]*runQaEvidenceFenceMigration\(\{ db: context\.db \}\)/)
    expect(migrate).toMatch(/target === 'provider-routing-v2'[\s\S]*runQaEvidenceFenceMigration\(\{ db: context\.db \}\)/)
  })
})
