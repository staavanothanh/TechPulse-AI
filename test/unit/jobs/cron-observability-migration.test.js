import { describe, expect, it } from 'vitest'
import {
  CRON_OBSERVABILITY_COLLECTIONS,
  CRON_OBSERVABILITY_INDEXES,
  buildCronObservabilityMigration,
} from '../../../scripts/migrations/cron-observability.js'

describe('cron-observability migration definition', () => {
  it('defines cronLifecycleEvents with strict schema and indexes', () => {
    expect(CRON_OBSERVABILITY_COLLECTIONS.cronLifecycleEvents).toBeDefined()
    expect(CRON_OBSERVABILITY_COLLECTIONS.cronLifecycleEvents.validator).toBeDefined()

    const indexes = CRON_OBSERVABILITY_INDEXES.cronLifecycleEvents
    expect(indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cron_events_eventId_unique', key: { eventId: 1 }, options: { unique: true } }),
      expect.objectContaining({ name: 'cron_events_occurred_id', key: { occurredAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'cron_events_run_occurred_id', key: { runId: 1, occurredAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'cron_events_job_occurred_id', key: { jobId: 1, occurredAt: -1, _id: -1 } }),
      expect.objectContaining({ name: 'cron_events_purge_deadline', key: { purgeAfter: 1, _id: 1 } }),
      expect.objectContaining({ name: 'cron_events_article_occurred_id', key: { articleId: 1, occurredAt: -1, _id: -1 } }),
    ]))
    expect(CRON_OBSERVABILITY_COLLECTIONS.cronLifecycleEvents.validator.$jsonSchema.properties.sequence).toEqual({ bsonType: 'int', minimum: 0, maximum: 2147483647 })
  })

  it('generates non-destructive idempotent migration plan', () => {
    const plan = buildCronObservabilityMigration({ dryRun: true })
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every((op) => ['createCollection', 'collMod', 'createIndex'].includes(op.type))).toBe(true)
  })
})
