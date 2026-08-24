import { describe, expect, it } from 'vitest'
import { assertGovernanceReady } from '../../../server/bootstrap/governance-readiness.js'
import {
  GOVERNANCE_COLLECTIONS,
  GOVERNANCE_DATABASE_COLLECTIONS,
  GOVERNANCE_DATABASE_INDEXES,
  GOVERNANCE_INDEXES,
} from '../../../scripts/migrations/governance.js'
import { GOVERNANCE_AUDIT_INDEXES, GOVERNANCE_AUDIT_VALIDATOR } from '../../../scripts/migrations/governance-audit.js'
import { GOVERNANCE_HARDENING_INDEXES } from '../../../scripts/migrations/governance-hardening.js'
import { GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR } from '../../../scripts/migrations/governance-retention-hardening.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../../scripts/migrations/article-governance-hardening.js'
import { PROVIDER_ROUTING_ARTICLE_VALIDATOR } from '../../../scripts/migrations/provider-routing-v2.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../../scripts/migrations/summary-detail-v1.js'

function materializedIndex(index) {
  return { name: index.name, key: index.key, ...(index.options ?? {}) }
}

function fakeDb(collections, indexes) {
  return {
    listCollections: () => ({ toArray: async () => collections.map(([name, validator]) => ({ name, options: { validator, validationLevel: 'strict', validationAction: 'error' } })) }),
    collection: (name) => ({ indexes: async () => (indexes[name] ?? []).map(materializedIndex) }),
  }
}

function readyContext({ articleValidator = ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } = {}) {
  const appCollections = [
    ...Object.entries(GOVERNANCE_COLLECTIONS).map(([name, definition]) => [name, name === 'takedownRequests' ? GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR : definition.validator]),
    ['articles', articleValidator],
    ['adminAuditLogs', GOVERNANCE_AUDIT_VALIDATOR],
  ]
  const appIndexes = {
    ...Object.fromEntries(Object.entries(GOVERNANCE_INDEXES).map(([name, definitions]) => [name, definitions])),
    takedownRequests: [...GOVERNANCE_INDEXES.takedownRequests, ...GOVERNANCE_HARDENING_INDEXES.takedownRequests],
    adminAuditLogs: GOVERNANCE_AUDIT_INDEXES,
  }
  const governanceCollections = Object.entries(GOVERNANCE_DATABASE_COLLECTIONS).map(([name, definition]) => [name, definition.validator])
  const governanceIndexes = Object.fromEntries(Object.entries(GOVERNANCE_DATABASE_INDEXES).map(([name, definitions]) => [name, definitions]))
  return {
    db: fakeDb(appCollections, appIndexes),
    client: { db: () => fakeDb(governanceCollections, governanceIndexes) },
  }
}

describe('Step 11 governance bootstrap readiness', () => {
  it('requires exact app and governance database validators and indexes', async () => {
    await expect(assertGovernanceReady(readyContext())).resolves.toEqual({ ready: true })
  })

  it('accepts the exact provider-routing-v2 article validator without weakening tombstones', async () => {
    await expect(assertGovernanceReady(readyContext({ articleValidator: PROVIDER_ROUTING_ARTICLE_VALIDATOR }))).resolves.toEqual({ ready: true })
  })

  it('accepts the exact Q&A fence article validator without weakening tombstones', async () => {
    await expect(assertGovernanceReady(readyContext({ articleValidator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR }))).resolves.toEqual({ ready: true })
  })

  it('accepts the summary detail validator without weakening tombstones', async () => {
    await expect(assertGovernanceReady(readyContext({ articleValidator: SUMMARY_DETAIL_ARTICLE_VALIDATOR }))).resolves.toEqual({ ready: true })
  })

  it('fails closed when governance suppression storage is only partially migrated', async () => {
    const context = readyContext()
    context.client = { db: () => fakeDb([], {}) }
    await expect(assertGovernanceReady(context)).rejects.toThrow(/governance.*validator|governance.*database/i)
  })

  it('fails closed when app takedown indexes drift', async () => {
    const context = readyContext()
    context.db = fakeDb(
      [...Object.entries(GOVERNANCE_COLLECTIONS).map(([name, definition]) => [name, name === 'takedownRequests' ? GOVERNANCE_RETENTION_TAKEDOWN_VALIDATOR : definition.validator]), ['articles', ARTICLE_GOVERNANCE_HARDENING_VALIDATOR], ['adminAuditLogs', GOVERNANCE_AUDIT_VALIDATOR]],
      { takedownRequests: [], accountDeletionRequests: GOVERNANCE_INDEXES.accountDeletionRequests, adminAuditLogs: GOVERNANCE_AUDIT_INDEXES },
    )
    await expect(assertGovernanceReady(context)).rejects.toThrow(/governance.*index/i)
  })
})
