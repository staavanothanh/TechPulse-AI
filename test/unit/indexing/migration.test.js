import { describe, expect, it } from 'vitest'
import {
  INDEXING_JOB_AUDIT_VALIDATOR,
  INDEXING_JOB_COLLECTIONS,
  INDEXING_JOB_INDEXES,
  INDEXING_ARTICLE_INDEXES,
  buildIndexingJobsMigration,
} from '../../../scripts/migrations/indexing-jobs.js'

describe('Step 9 indexing-jobs migration contract', () => {
  it('creates strict indexing/provider state and every required exact index', () => {
    const operations = buildIndexingJobsMigration({ dryRun: true })
    expect(Object.keys(INDEXING_JOB_COLLECTIONS)).toEqual(['indexingJobs', 'providerAdmissionStates'])
    expect(INDEXING_JOB_INDEXES.indexingJobs.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'indexing_actor_idempotency_unique',
      'indexing_article_created',
      'indexing_source_status_available',
      'indexing_due_normal',
      'indexing_due_aged',
      'indexing_purge_deadline',
    ]))
    expect(INDEXING_JOB_INDEXES.providerAdmissionStates.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'provider_admission_domain_unique',
      'provider_route_circuit',
    ]))
    expect(operations.filter(({ type }) => type === 'collMod').map(({ collection }) => collection)).toEqual(expect.arrayContaining(['indexingJobs', 'providerAdmissionStates', 'adminAuditLogs']))
    expect(INDEXING_JOB_AUDIT_VALIDATOR).toBeTruthy()
    expect(INDEXING_ARTICLE_INDEXES).toEqual([{ name: 'articles_source_reconciliation', key: { sourceId: 1, _id: 1 } }])
  })

  it('keeps aggregate admission capped and indexing retention/index semantics in validators', () => {
    const serialized = JSON.stringify(INDEXING_JOB_COLLECTIONS)
    expect(serialized).toContain('maxConcurrency')
    expect(serialized).toContain('activeReservations')
    expect(serialized).toContain('routeCircuits')
    expect(serialized).toContain('idempotencyExpiresAt')
    expect(INDEXING_JOB_INDEXES.indexingJobs.find(({ name }) => name === 'indexing_actor_idempotency_unique')?.options).toEqual({ unique: true })
    expect(INDEXING_JOB_INDEXES.indexingJobs.find(({ name }) => name === 'indexing_purge_deadline')?.options?.partialFilterExpression).toEqual({ purgeAfter: { $type: 'date' } })
  })
})
