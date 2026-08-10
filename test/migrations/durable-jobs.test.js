import { describe, expect, it, vi } from 'vitest'
import {
  DURABLE_JOB_AUDIT_VALIDATOR,
  DURABLE_JOB_COLLECTIONS,
  DURABLE_JOB_INDEXES,
  buildDurableJobsMigration,
  runDurableJobsMigration,
} from '../../scripts/migrations/durable-jobs.js'

describe('durable-jobs migration contract', () => {
  it('defines closed ingestionJobs, persistent jobLeases and daily schedule progress collections', () => {
    expect(Object.keys(DURABLE_JOB_COLLECTIONS)).toEqual(['ingestionJobs', 'jobLeases', 'ingestionScheduleProgress'])
    expect(DURABLE_JOB_COLLECTIONS.ingestionJobs.validator).toBeTruthy()
    expect(DURABLE_JOB_COLLECTIONS.jobLeases.validator).toBeTruthy()
    expect(DURABLE_JOB_COLLECTIONS.ingestionScheduleProgress.validator).toBeTruthy()
    expect(DURABLE_JOB_AUDIT_VALIDATOR).toBeTruthy()
  })

  it('defines exact due, aging, retention and lease indexes without lease TTL', () => {
    expect(DURABLE_JOB_INDEXES.ingestionJobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ingestion_actor_idempotency_unique', key: { actorScope: 1, idempotencyKey: 1 }, options: { unique: true } }),
      expect.objectContaining({ name: 'ingestion_due_normal', key: { status: 1, priority: -1, availableAt: 1, createdAt: 1, _id: 1 } }),
      expect.objectContaining({ name: 'ingestion_due_aged', key: { status: 1, agingEligibleAt: 1, availableAt: 1, createdAt: 1, _id: 1 } }),
      expect.objectContaining({ name: 'ingestion_purge_deadline', key: { purgeAfter: 1, _id: 1 } }),
    ]))
    expect(DURABLE_JOB_INDEXES.jobLeases).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'job_lease_key_unique', key: { key: 1 }, options: { unique: true } }),
      expect.objectContaining({ name: 'job_lease_expiry', key: { 'activeOwner.expiresAt': 1 } }),
    ]))
    expect(DURABLE_JOB_INDEXES.jobLeases.some((index) => index.options?.expireAfterSeconds !== undefined)).toBe(false)
    expect(DURABLE_JOB_INDEXES.ingestionScheduleProgress).toEqual([
      expect.objectContaining({ name: 'ingestion_schedule_period_unique', key: { period: 1 }, options: { unique: true } }),
    ])
  })

  it('builds only idempotent non-destructive operations', () => {
    const plan = buildDurableJobsMigration({ dryRun: true })
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every((operation) => ['createCollection', 'collMod', 'createIndex'].includes(operation.type))).toBe(true)
    expect(plan.some((operation) => operation.type.startsWith('drop'))).toBe(false)
  })

  it('fails before collection mutation when the predecessor audit revision is missing', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [] })),
      createCollection: vi.fn(), command: vi.fn(), collection: vi.fn(),
    }
    await expect(runDurableJobsMigration({ db })).rejects.toThrow(/sources migration/i)
    expect(db.createCollection).not.toHaveBeenCalled()
    expect(db.command).not.toHaveBeenCalled()
  })
})
