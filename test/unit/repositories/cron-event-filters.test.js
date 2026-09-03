import { describe, expect, it, vi } from 'vitest'
import { MongoCronEventRepository } from '../../../server/repositories/mongo/cron-event-repository.js'

describe('MongoCronEventRepository pagination and time filtering', () => {
  it('filters by from and to ISO dates and respects limit and cursor', async () => {
    let capturedFilter = null
    const mockFind = vi.fn((filter) => {
      capturedFilter = filter
      return {
        sort: () => ({
          project: () => ({
            limit: () => ({
              toArray: async () => [
                {
                  _id: { toHexString: () => '507f1f77bcf86cd799439011' },
                  eventId: '1'.repeat(64),
                  stage: 'cron',
                  status: 'succeeded',
                  occurredAt: new Date('2026-09-03T10:00:00.000Z'),
                },
              ],
            }),
          }),
        }),
      }
    })

    const repo = new MongoCronEventRepository({
      db: { collection: () => ({ find: mockFind }) },
    })

    const result = await repo.listLifecycleEvents({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-03T23:59:59.000Z',
      queueName: 'indexing',
      task: 'summary',
      articleId: 'article-1',
      limit: 10,
    })

    expect(capturedFilter.queueName).toBe('indexing')
    expect(capturedFilter.task).toBe('summary')
    expect(capturedFilter.articleId).toBe('article-1')
    expect(capturedFilter.occurredAt.$gte).toEqual(new Date('2026-09-01T00:00:00.000Z'))
    expect(capturedFilter.occurredAt.$lte).toEqual(new Date('2026-09-03T23:59:59.000Z'))
    expect(result.events).toHaveLength(1)
  })

  it('rejects offsetless date filters to keep pagination windows unambiguous', async () => {
    const repo = new MongoCronEventRepository({ db: { collection: () => ({ find: vi.fn() }) } })

    await expect(repo.listLifecycleEvents({ from: '2026-09-03T10:00' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(repo.listLifecycleEvents({ to: '2026-09-03T10:00' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })
  it('rejects inverted RFC3339 date boundaries where from is after to', async () => {
    const repo = new MongoCronEventRepository({ db: { collection: () => ({ find: vi.fn() }) } })

    await expect(repo.listLifecycleEvents({
      from: '2026-09-03T23:59:59.000Z',
      to: '2026-09-01T00:00:00.000Z',
    })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })

  it('accepts explicit timezone offset RFC3339 boundary filters', async () => {
    let capturedFilter = null
    const repo = new MongoCronEventRepository({
      db: { collection: () => ({ find: (filter) => { capturedFilter = filter; return { sort: () => ({ project: () => ({ limit: () => ({ toArray: async () => [] }) }) }) } } }) },
    })

    await repo.listLifecycleEvents({
      from: '2026-09-01T07:00:00+07:00',
      to: '2026-09-03T07:00:00+07:00',
    })

    expect(capturedFilter.occurredAt.$gte).toEqual(new Date('2026-09-01T00:00:00.000Z'))
    expect(capturedFilter.occurredAt.$lte).toEqual(new Date('2026-09-03T00:00:00.000Z'))
  })
  it('rejects non-RFC3339 date-time precision or timezone forms', async () => {
    const repo = new MongoCronEventRepository({ db: { collection: () => ({ find: vi.fn() }) } })

    await expect(repo.listLifecycleEvents({ from: '2026-09-03T10:00Z' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    await expect(repo.listLifecycleEvents({ from: '2026-09-03T10:00:00' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })
})
