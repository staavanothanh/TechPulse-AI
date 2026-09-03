import { describe, expect, it, vi } from 'vitest'
import { MongoCronEventRepository } from '../../../server/repositories/mongo/cron-event-repository.js'

describe('MongoCronEventRepository', () => {
  it('records lifecycle event with upsert idempotency on eventId', async () => {
    const updateOne = vi.fn().mockResolvedValue({ upsertedCount: 1 })
    const collection = vi.fn(() => ({ updateOne }))
    const repo = new MongoCronEventRepository({ db: { collection } })

    const event = {
      eventId: 'a'.repeat(64),
      runId: 'cron-run-1',
      stage: 'cron.coordinator',
      status: 'started',
      at: '2026-09-03T10:00:00.000Z',
    }

    const recorded = await repo.recordLifecycleEvent(event)
    expect(recorded).toBe(true)
    expect(collection).toHaveBeenCalledWith('cronLifecycleEvents')
    expect(updateOne).toHaveBeenCalledWith(
      { eventId: 'a'.repeat(64) },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          eventId: 'a'.repeat(64),
          runId: 'cron-run-1',
          stage: 'cron.coordinator',
          status: 'started',
        }),
      }),
      { upsert: true },
    )
  })

  it('fails open when write fails, returning false without throwing', async () => {
    const updateOne = vi.fn().mockRejectedValue(new Error('Mongo network timeout'))
    const collection = vi.fn(() => ({ updateOne }))
    const repo = new MongoCronEventRepository({ db: { collection } })

    const recorded = await repo.recordLifecycleEvent({
      eventId: 'b'.repeat(64),
      stage: 'cron',
      status: 'failed',
    })
    expect(recorded).toBe(false)
  })

  it('lists events with filter, cursor pagination, and ordering', async () => {
    const docs = [
      {
        _id: '507f1f77bcf86cd799439011',
        eventId: 'c'.repeat(64),
        runId: 'run-1',
        queueName: 'ingestion',
        occurredAt: new Date('2026-09-03T10:00:00.000Z'),
        stage: 'ingestion.claim',
        status: 'succeeded',
      },
    ]
    const toArray = vi.fn().mockResolvedValue(docs)
    const limit = vi.fn(() => ({ toArray }))
    const project = vi.fn(() => ({ limit }))
    const sort = vi.fn(() => ({ project }))
    const find = vi.fn(() => ({ sort }))
    const collection = vi.fn(() => ({ find }))
    const repo = new MongoCronEventRepository({ db: { collection } })

    const result = await repo.listLifecycleEvents({
      runId: 'run-1',
      queueName: 'ingestion',
      limit: 20,
    })

    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        queueName: 'ingestion',
      }),
    )
    expect(result.events).toHaveLength(1)
    expect(result.events[0].eventId).toBe('c'.repeat(64))
  })
  it('passes bounded signal and maxTimeMS options to retention reads and deletes', async () => {
    const rows = [{ _id: 'event-1' }]
    const toArray = vi.fn().mockResolvedValue(rows)
    const project = vi.fn(() => ({ toArray }))
    const limit = vi.fn(() => ({ project }))
    const sort = vi.fn(() => ({ limit }))
    const find = vi.fn(() => ({ sort }))
    const deleteMany = vi.fn().mockResolvedValue({ deletedCount: 1 })
    const collection = vi.fn(() => ({ find, deleteMany }))
    const repo = new MongoCronEventRepository({ db: { collection } })
    const signal = new AbortController().signal
    const deadline = new Date(Date.now() + 5_000)

    await expect(repo.purgeExpiredEvents({ cutoff: new Date(), limit: 1, signal, deadline })).resolves.toEqual({ inspected: 1, affected: 1, hasMore: false })
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ purgeAfter: expect.any(Object) }), expect.objectContaining({ signal, maxTimeMS: expect.any(Number) }))
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({ _id: { $in: ['event-1'] } }), expect.objectContaining({ signal, maxTimeMS: expect.any(Number) }))
  })
})
