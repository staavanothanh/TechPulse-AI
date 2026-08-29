import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { GOOGLE_OAUTH_AUDIT_VALIDATOR } from '../../scripts/migrations/google-oauth.js'
import { RUNTIME_SCHEMA_GENERATIONS } from '../../server/bootstrap/schema-readiness.js'
import {
  SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR,
  buildSourcePolicyReconciliationMigration,
  runSourcePolicyReconciliationMigration,
} from '../../scripts/migrations/source-policy-reconciliation.js'

function database(validator = GOOGLE_OAUTH_AUDIT_VALIDATOR) {
  const auditCollection = { createIndex: vi.fn(async () => 'source_reconciliation_idempotency_unique') }
  return {
    listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'adminAuditLogs', options: { validator } }] })),
    command: vi.fn(async () => ({})),
    collection: vi.fn(() => auditCollection),
    auditCollection,
  }
}

describe('source-policy-reconciliation migration', () => {
  it('adds one explicit non-destructive audit-validator revision', () => {
    const plan = buildSourcePolicyReconciliationMigration({ dryRun: true })
    expect(plan).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'collMod', collection: 'adminAuditLogs', dryRun: true }), expect.objectContaining({ type: 'createIndex', collection: 'adminAuditLogs', dryRun: true })]))
    expect(plan.some(({ type }) => type.startsWith('drop') || type === 'delete')).toBe(false)
    expect(JSON.stringify(SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR)).toContain('source_policy_reconciliation_requested')
  })

  it('requires a known predecessor and applies the validator idempotently', async () => {
    const db = database()
    await expect(runSourcePolicyReconciliationMigration({ db })).resolves.toHaveLength(2)
    expect(db.command).toHaveBeenCalledWith(expect.objectContaining({ collMod: 'adminAuditLogs', validator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR, validationLevel: 'strict', validationAction: 'error' }))
    expect(db.auditCollection.createIndex).toHaveBeenCalledWith({ action: 1, actorId: 1, requestId: 1 }, expect.objectContaining({ unique: true, name: 'source_reconciliation_idempotency_unique' }))
    await expect(runSourcePolicyReconciliationMigration({ db, dryRun: true })).resolves.toEqual(buildSourcePolicyReconciliationMigration({ dryRun: true }))

    await expect(runSourcePolicyReconciliationMigration({ db: database({}) })).rejects.toThrow(/precede/i)
  })

  it('requires the exact reconciliation validator and index when verifying the target', () => {
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(verify).toMatch(/target === 'source-policy-reconciliation' && name === 'adminAuditLogs'\s*\?\s*\[SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR\]/)
    expect(verify).toMatch(/target === 'source-policy-reconciliation'\s*\?\s*\[SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR\]/)
    expect(verify).toContain('SOURCE_POLICY_RECONCILIATION_INDEXES')
    expect(verify).toContain('adminAuditLogs: [...AUTH_CORE_INDEXES.adminAuditLogs, ...SOURCE_POLICY_RECONCILIATION_INDEXES]')
    expect(verify).toContain("'source-policy-reconciliation'")
  })

  it('verifies the complete indexing and source paths under the target', () => {
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const collectionsStart = verify.indexOf("target === 'source-policy-reconciliation'\n                ? {\n                    ...INDEXING_JOB_COLLECTIONS")
    const collectionsEnd = verify.indexOf("              : target === 'topic-taxonomy-v1'", collectionsStart)
    const collectionsBranch = verify.slice(collectionsStart, collectionsEnd)
    expect(collectionsStart).toBeGreaterThanOrEqual(0)
    expect(collectionsBranch).toContain('articles: { validator: TOPIC_TAXONOMY_ARTICLE_VALIDATOR }')
    expect(collectionsBranch).toContain('sources: SOURCE_COLLECTIONS.sources')
    expect(collectionsBranch).toContain('adminAuditLogs: { validator: SOURCE_POLICY_RECONCILIATION_AUDIT_VALIDATOR }')

    const indexesStart = verify.indexOf("target === 'source-policy-reconciliation'\n                ? {", collectionsEnd)
    const indexesEnd = verify.indexOf("              : target === 'summary-detail-v1'", indexesStart)
    const indexesBranch = verify.slice(indexesStart, indexesEnd)
    expect(indexesStart).toBeGreaterThan(collectionsStart)
    expect(indexesBranch).toContain('...Object.fromEntries(Object.entries(INDEXING_JOB_INDEXES)')
    expect(indexesBranch).toContain('...(INDEXING_DRAIN_PERFORMANCE_INDEXES[name] ?? [])')
    expect(indexesBranch).toContain('articles: [...INDEXING_ARTICLE_INDEXES, ...ARTICLE_INDEXES.articles, ...TOPIC_TAXONOMY_ARTICLE_INDEXES]')
    expect(indexesBranch).toContain('sources: SOURCE_INDEXES.sources')
    expect(indexesBranch).toContain('adminAuditLogs: [...AUTH_CORE_INDEXES.adminAuditLogs, ...SOURCE_POLICY_RECONCILIATION_INDEXES]')

    const validatorsStart = verify.indexOf("target === 'source-policy-reconciliation' && name === 'adminAuditLogs'")
    const validatorsEnd = verify.indexOf("            : (target === 'auth-core' || target === 'google-oauth')", validatorsStart)
    const validatorsBranch = verify.slice(validatorsStart, validatorsEnd)
    expect(validatorsBranch).toContain("target === 'source-policy-reconciliation' && name === 'providerAdmissionStates'")
    expect(validatorsBranch).toContain('PROVIDER_ADMISSION_STATE_VALIDATOR_V2')
    expect(validatorsBranch).toContain("target === 'source-policy-reconciliation' && name === 'indexingJobs'")
    expect(validatorsBranch).toContain('PROVIDER_ROUTING_INDEXING_JOB_VALIDATOR')
    expect(validatorsBranch).toContain("target === 'source-policy-reconciliation' && name === 'articles'")
    expect(validatorsBranch).toContain("target === 'source-policy-reconciliation' && name === 'sources'")
  })

  it('binds the reconciliation migration to the indexing runtime attestation scope', () => {
    const verify = readFileSync(new URL('../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(RUNTIME_SCHEMA_GENERATIONS['indexing-jobs']).toBe('indexing-jobs-drain-performance-v1')
    expect(verify).toContain("target === 'indexing-drain-performance' || target === 'source-policy-reconciliation' ? 'indexing-jobs' : target")
  })
})
