import { describe, expect, it } from 'vitest'
import { assertSourcesReady, createConfiguredSourceService } from '../../../server/bootstrap/sources.js'
import { SOURCE_AUDIT_VALIDATOR, SOURCE_COLLECTIONS, SOURCE_INDEXES } from '../../../scripts/migrations/sources.js'
import { DURABLE_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/durable-jobs.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/indexing-jobs.js'
import { QA_EVIDENCE_FENCE_SOURCE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'

function readyContext({ sourceValidator = SOURCE_COLLECTIONS.sources.validator, auditValidator = SOURCE_AUDIT_VALIDATOR, indexes } = {}) {
  const actualIndexes = indexes ?? SOURCE_INDEXES.sources.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) }))
  return {
    client: {},
    db: {
      listCollections: () => ({ toArray: async () => [
        { name: 'sources', options: { validator: sourceValidator, validationLevel: 'strict', validationAction: 'error' } },
        { name: 'adminAuditLogs', options: { validator: auditValidator, validationLevel: 'strict', validationAction: 'error' } },
      ] }),
      collection: () => ({ indexes: async () => actualIndexes }),
    },
  }
}

describe('Source Registry bootstrap readiness', () => {
  it('constructs the service and current-policy boundary only for exact validators and indexes', async () => {
    const context = readyContext()
    await expect(assertSourcesReady(context)).resolves.toBeUndefined()
    const configured = await createConfiguredSourceService({ context, technicalCheckAdapter: { run() {} }, rateLimitAdmission: { reserve: async () => ({ allowed: true }) } })
    expect(configured.sourceService).toEqual(expect.objectContaining({ list: expect.any(Function), runTechnicalCheck: expect.any(Function) }))
    expect(configured.currentSourcePolicy).toEqual(expect.objectContaining({ content: expect.any(Function), media: expect.any(Function) }))
  })

  it('accepts the exact forward-compatible durable-job audit validator', async () => {
    await expect(assertSourcesReady(readyContext({ auditValidator: DURABLE_JOB_AUDIT_VALIDATOR }))).resolves.toBeUndefined()
  })

  it('accepts the exact forward-compatible indexing-job audit validator', async () => {
    await expect(assertSourcesReady(readyContext({ auditValidator: INDEXING_JOB_AUDIT_VALIDATOR }))).resolves.toBeUndefined()
  })

  it('accepts the exact Q&A evidence-fence source validator', async () => {
    await expect(assertSourcesReady(readyContext({ sourceValidator: QA_EVIDENCE_FENCE_SOURCE_VALIDATOR }))).resolves.toBeUndefined()
  })

  it('fails closed for missing context, stale validators, missing indexes, key drift and option drift', async () => {
    await expect(createConfiguredSourceService()).rejects.toThrow(/context/i)
    await expect(createConfiguredSourceService({ context: readyContext(), technicalCheckAdapter: { run() {} } })).rejects.toThrow(/rate-limit/i)
    await expect(assertSourcesReady(readyContext({ sourceValidator: {} }))).rejects.toThrow(/sources validator/i)
    await expect(assertSourcesReady(readyContext({ auditValidator: {} }))).rejects.toThrow(/audit validator/i)
    await expect(assertSourcesReady(readyContext({ indexes: [] }))).rejects.toThrow(/indexes/i)
    const wrongKey = SOURCE_INDEXES.sources.map((index) => ({ name: index.name, key: index.name === 'sources_key_unique' ? { wrong: 1 } : index.key, ...(index.options ?? {}) }))
    await expect(assertSourcesReady(readyContext({ indexes: wrongKey }))).rejects.toThrow(/indexes/i)
    const wrongUnique = SOURCE_INDEXES.sources.map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}), ...(index.name === 'sources_key_unique' ? { unique: false } : {}) }))
    await expect(assertSourcesReady(readyContext({ indexes: wrongUnique }))).rejects.toThrow(/indexes/i)
  })
})
