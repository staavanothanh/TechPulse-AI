import { describe, expect, it, vi } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  createTakedownRepository,
  serializeTakedownSummary,
  redactCitationsForTarget,
} from '../../../server/application/takedowns/repository.js'

const articleId = new ObjectId('507f1f77bcf86cd799439011')
const sourceId = new ObjectId('507f1f77bcf86cd799439012')

describe('Step 11 takedown persistence boundary', () => {
  it('projects list data without requester/case PII', () => {
    const summary = serializeTakedownSummary({ _id: new ObjectId(), status: 'reviewing', targetType: 'article', targetIds: [articleId], requestedScope: ['metadata'], requesterName: 'P', requesterContact: 'p@example.com', reason: 'private', createdAt: new Date(), updatedAt: new Date() })
    expect(summary).not.toHaveProperty('requesterName')
    expect(summary).not.toHaveProperty('requesterContact')
    expect(summary).not.toHaveProperty('reason')
  })

  it('requests only summary fields from Mongo for takedown lists', async () => {
    const find = vi.fn(() => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }))
    await createTakedownRepository({ collection: { find } }).list({})
    expect(find).toHaveBeenCalledWith({}, { projection: { _id: 1, status: 1, targetType: 1, targetIds: 1, requestedScope: 1, createdAt: 1, updatedAt: 1 } })
  })

  it('rejects a non-canonical takedown status before querying Mongo', async () => {
    const find = vi.fn()
    await expect(createTakedownRepository({ collection: { find } }).list({ status: 'private-status' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
    expect(find).not.toHaveBeenCalled()
  })

  it('redacts only matching available citations and never carries URL/title/date', () => {
    const result = redactCitationsForTarget([
      { id: 'A', status: 'available', articleId, sourceId, originalUrl: 'https://example.com/a', titleOriginal: 'A', publishedAt: new Date() },
      { id: 'B', status: 'available', articleId: new ObjectId(), sourceId, originalUrl: 'https://example.com/b', titleOriginal: 'B', publishedAt: new Date() },
    ], { targetType: 'source', targetIds: [sourceId] })
    expect(result).toEqual([
      { id: 'A', status: 'unavailable', articleId, sourceId, unavailableReason: 'takedown' },
      expect.objectContaining({ id: 'B', status: 'unavailable' }),
    ])
    expect(result[0]).not.toHaveProperty('originalUrl')
    expect(result[0]).not.toHaveProperty('titleOriginal')
    expect(result[0]).not.toHaveProperty('publishedAt')
  })

  it('uses a stable cursor and compare-and-set fields for bounded redaction', async () => {
    const first = { _id: new ObjectId('507f1f77bcf86cd799439021'), updatedAt: new Date('2026-08-13T00:00:00.000Z'), messageCount: 2, messages: [] }
    const chatCollection = {
      find: (filter) => {
        expect(filter).toEqual(expect.objectContaining({ 'messages.citations.sourceId': { $in: [sourceId] } }))
        return { sort: (sort) => { expect(sort).toEqual({ _id: 1 }); return { limit: () => ({ toArray: async () => [first] }) } } }
      },
      updateOne: async (filter) => { expect(filter).toEqual(expect.objectContaining({ _id: first._id, updatedAt: first.updatedAt, messageCount: first.messageCount })); return { matchedCount: 1, modifiedCount: 1 } },
    }
    const repository = createTakedownRepository({ collection: { findOne: async () => null }, now: () => new Date() })
    await expect(repository.redactBatch({ targetType: 'source', targetIds: [sourceId], chatCollection, limit: 1 })).resolves.toEqual(expect.objectContaining({ nextCursor: first._id.toHexString() }))
  })

  it('fails closed on a CAS miss so the cursor cannot skip a stale citation document', async () => {
    const first = { _id: new ObjectId(), updatedAt: new Date(), messageCount: 1, messages: [] }
    const chatCollection = { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [first] }) }) }), updateOne: async () => ({ matchedCount: 0, modifiedCount: 0 }) }
    const repository = createTakedownRepository({ collection: { findOne: async () => null } })
    await expect(repository.redactBatch({ targetType: 'source', targetIds: [sourceId], chatCollection })).rejects.toMatchObject({ status: 409, code: 'conflict' })
  })

  it('rejects malformed opaque takedown ids with canonical 400', async () => {
    const repository = createTakedownRepository({ collection: { findOne: async () => null } })
    await expect(repository.getDetail('not-an-object-id')).rejects.toMatchObject({ status: 400, code: 'bad_request' })
  })

  it('emits an opaque createdAt and id cursor and applies it to the next page', async () => {
    const first = { _id: new ObjectId('507f1f77bcf86cd799439031'), status: 'received', targetType: 'article', targetIds: [articleId], requestedScope: ['metadata'], createdAt: new Date('2026-08-13T00:00:00.000Z'), updatedAt: new Date('2026-08-13T00:00:01.000Z') }
    const second = { _id: new ObjectId('507f1f77bcf86cd799439032'), status: 'received', targetType: 'article', targetIds: [articleId], requestedScope: ['metadata'], createdAt: new Date('2026-08-12T00:00:00.000Z'), updatedAt: new Date('2026-08-12T00:00:01.000Z') }
    let seenFilter
    const collection = {
      find: (filter) => {
        seenFilter = filter
        return { sort: () => ({ limit: () => ({ toArray: async () => [first, second] }) }) }
      },
    }
    const repository = createTakedownRepository({ collection })
    const page = await repository.list({ limit: 1 })
    expect(page.hasNext).toBe(true)
    expect(page.nextCursor).toMatch(/^v1\./)
    expect(page.data).toHaveLength(1)
    await repository.list({ limit: 1, cursor: page.nextCursor })
    expect(seenFilter).toEqual(expect.objectContaining({ $or: expect.any(Array) }))
    expect(seenFilter.$or).toEqual(expect.arrayContaining([
      { createdAt: { $lt: new Date(first.createdAt) } },
      { createdAt: new Date(first.createdAt), _id: { $lt: first._id } },
    ]))
  })

  it('rejects malformed list cursors with canonical 422', async () => {
    const repository = createTakedownRepository({ collection: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) } })
    await expect(repository.list({ cursor: 'not-a-v1-cursor' })).rejects.toMatchObject({ status: 422, code: 'validation_error' })
  })
})
