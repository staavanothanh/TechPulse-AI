import { ObjectId } from 'mongodb'

function id(value) {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  const error = new Error('Takedown identifier is invalid'); error.status = 400; error.code = 'bad_request'; throw error
}
function date(value) { const result = value instanceof Date ? value : new Date(value); if (Number.isNaN(result.getTime())) throw new Error('date is invalid'); return result }

function encodeCursor(value) {
  return `v1.${Buffer.from(JSON.stringify({ createdAt: date(value.createdAt).toISOString(), id: id(value.id).toHexString() }), 'utf8').toString('base64url')}`
}

function decodeCursor(value) {
  if (typeof value !== 'string' || !value.startsWith('v1.')) {
    const error = new Error('Takedown cursor is invalid'); error.status = 422; error.code = 'validation_error'; throw error
  }
  try {
    const parsed = JSON.parse(Buffer.from(value.slice(3), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length !== 2 || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') throw new Error('shape')
    return { createdAt: date(parsed.createdAt), id: id(parsed.id) }
  } catch {
    const error = new Error('Takedown cursor is invalid'); error.status = 422; error.code = 'validation_error'; throw error
  }
}

export function serializeTakedownSummary(document) {
  return { id: String(document._id ?? document.id), status: document.status, targetType: document.targetType, targetIds: (document.targetIds ?? []).map(String), requestedScope: [...(document.requestedScope ?? [])], createdAt: date(document.createdAt).toISOString(), updatedAt: date(document.updatedAt).toISOString() }
}

export function serializeTakedownDetail(document) {
  if (!document) return null
  return { id: String(document._id ?? document.id), status: document.status, requesterName: document.requesterName, requesterContact: document.requesterContact, targetType: document.targetType, targetIds: (document.targetIds ?? []).map(String), reason: document.reason, evidenceNote: document.evidenceNote ?? null, requestedScope: [...(document.requestedScope ?? [])], decisionReasonCode: document.decisionReasonCode ?? null, completion: { ...(document.completion ?? {}) }, completedAt: document.completedAt ? date(document.completedAt).toISOString() : null, createdAt: date(document.createdAt).toISOString(), updatedAt: date(document.updatedAt).toISOString() }
}

export function redactCitationsForTarget(citations = [], { targetType, targetIds = [] } = {}) {
  const targets = new Set(targetIds.map((value) => String(value)))
  return citations.map((citation) => {
    if (citation.status !== 'available') return citation
    const matches = targetType === 'article' ? targets.has(String(citation.articleId)) : targets.has(String(citation.sourceId))
    if (!matches) return citation
    return { id: citation.id, status: 'unavailable', ...(citation.articleId ? { articleId: citation.articleId } : {}), ...(citation.sourceId ? { sourceId: citation.sourceId } : {}), unavailableReason: 'takedown' }
  })
}

export function createTakedownRepository({ collection, now = () => new Date() } = {}) {
  if (!collection) throw new Error('Takedown collection is required')
  const clock = now
  return Object.freeze({
    async list(query = {}) {
      const limit = Number(query.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) { const error = new Error('Takedown limit is invalid'); error.status = 422; error.code = 'validation_error'; throw error }
      if (query.status && !['received', 'reviewing', 'approved', 'rejected', 'completed'].includes(query.status)) { const error = new Error('Takedown status is invalid'); error.status = 422; error.code = 'validation_error'; throw error }
      const filter = query.status ? { status: query.status } : {}
      if (Object.hasOwn(query, 'cursor')) {
        const cursor = decodeCursor(query.cursor)
        filter.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor.id } }]
      }
      const rows = await collection.find(filter, { projection: { _id: 1, status: 1, targetType: 1, targetIds: 1, requestedScope: 1, createdAt: 1, updatedAt: 1 } }).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).toArray()
      const selected = rows.slice(0, limit)
      return { data: selected.map(serializeTakedownSummary), hasNext: rows.length > limit, nextCursor: rows.length > limit ? encodeCursor({ createdAt: selected.at(-1).createdAt, id: selected.at(-1)._id }) : null }
    },
    async getDetail(requestId) { const document = await collection.findOne({ _id: id(requestId) }); return serializeTakedownDetail(document) },
    async redactBatch({ targetType, targetIds, chatCollection, limit = 100, cursor, session } = {}) {
      if (!chatCollection) throw new Error('Chat collection is required')
      const field = targetType === 'article' ? 'messages.citations.articleId' : 'messages.citations.sourceId'
      const citationIds = targetIds.map(id)
      const filter = { [field]: { $in: citationIds } }
      if (cursor) filter._id = { $gt: id(cursor) }
      const directIndex = targetType === 'article' ? 'chat_sessions_citation_article' : 'chat_sessions_citation_source'
      let query = chatCollection.find(filter, { session, projection: { _id: 1, updatedAt: 1, messageCount: 1, messages: 1 } })
      if (typeof query.hint === 'function') query = query.hint(directIndex)
      const rows = await query.sort({ _id: 1 }).limit(Math.min(100, Math.max(1, Number(limit))) + 1).toArray()
      const selected = rows.slice(0, limit); let affected = 0
      for (const row of selected) {
        const messages = (row.messages ?? []).map((message) => message.status === 'answered' ? { ...message, citations: redactCitationsForTarget(message.citations, { targetType, targetIds }) } : message)
        const result = await chatCollection.updateOne({ _id: row._id, updatedAt: row.updatedAt, messageCount: row.messageCount }, { $set: { messages, updatedAt: clock() } }, { session })
        if (result.matchedCount !== 1) { const error = new Error('Citation cleanup fence changed'); error.status = 409; error.code = 'conflict'; throw error }
        affected += result.modifiedCount ?? 0
      }
      const last = selected.at(-1)
      return { inspected: selected.length, affected, hasMore: rows.length > limit, nextCursor: last ? last._id.toHexString() : null }
    },
  })
}

export { id }
