import { ObjectId } from 'mongodb'
import { serializeTakedownDetail } from './repository.js'

const SCOPES = Object.freeze(['metadata', 'media-metadata', 'summary', 'embedding'])
const TRANSITIONS = Object.freeze({ received: ['reviewing'], reviewing: ['approved', 'rejected'], approved: ['completed'] })
const REASONS = Object.freeze({ reviewing: 'takedown_review_started', approved: 'takedown_approved', rejected: 'takedown_rejected', completed: 'takedown_completed' })
const COMPLETION_FIELD = Object.freeze({ metadata: 'metadataRemoved', 'media-metadata': 'mediaMetadataRemoved', summary: 'summaryRemoved', embedding: 'embeddingRemoved' })

export class TakedownError extends Error {
  constructor(status, code, message, options = {}) { super(message); this.name = 'TakedownError'; this.status = status; this.code = code; this.retryAfter = options.retryAfter }
}

function requireAdmin(auth) {
  if (!auth?.user) throw new TakedownError(401, 'unauthorized', 'Authentication is required')
  if (auth.user.role !== 'admin' || auth.user.status !== 'active') throw new TakedownError(403, 'forbidden', 'Administrator role is required')
  if (!auth.session?._id && !auth.session?.id) throw new TakedownError(401, 'unauthorized', 'Active administrator session is required')
  return auth.user
}

function objectId(value, label = 'Takedown identifier') {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  throw new TakedownError(400, 'bad_request', `${label} is invalid`)
}

function normalizeIds(values) { if (!Array.isArray(values) || values.length < 1 || values.length > 100) throw new TakedownError(422, 'validation_error', 'Takedown targets are invalid'); const ids = values.map((value) => objectId(value, 'Takedown target')); if (new Set(ids.map((value) => value.toHexString())).size !== ids.length) throw new TakedownError(422, 'validation_error', 'Takedown targets are duplicated'); return ids }
function normalizeScope(values) { if (!Array.isArray(values) || values.length < 1 || values.some((value) => !SCOPES.includes(value)) || new Set(values).size !== values.length) throw new TakedownError(422, 'validation_error', 'Takedown scope is invalid'); return [...values] }
function actorFence(auth, user) { return { userId: user._id ?? user.id, sessionId: auth.session?._id ?? auth.session?.id, sessionVersion: auth.session?.userSessionVersion } }
function safeError(error) { return error?.status ? error : Object.assign(new Error('Takedown workflow is unavailable'), { status: 503, code: 'service_unavailable' }) }

function serialize(document, now) {
  const result = serializeTakedownDetail(document, now)
  if (!result) throw new TakedownError(404, 'not_found', 'Takedown request not found')
  return result
}

export function createTakedownService({ repository, clock = () => new Date(), rateLimitAdmission } = {}) {
  if (!repository) throw new Error('Takedown repository is required')
  const withTransaction = (work) => typeof repository.withTransaction === 'function' ? repository.withTransaction(work) : work(undefined)
  async function fence(auth, user, session) {
    if (typeof repository.assertActorFence !== 'function' || !await repository.assertActorFence(actorFence(auth, user), session)) throw new TakedownError(401, 'unauthorized', 'Session is no longer active')
  }
  async function admit(user, session) {
    if (!rateLimitAdmission?.reserve) throw new TakedownError(503, 'service_unavailable', 'Admin admission is unavailable')
    let admission
    try { admission = await rateLimitAdmission.reserve({ scope: 'admin-trigger', subject: String(user._id ?? user.id), session }) } catch { throw new TakedownError(503, 'service_unavailable', 'Admin admission is unavailable') }
    if (admission?.allowed === false) throw new TakedownError(429, 'rate_limit_exceeded', 'Request rate limit exceeded', { retryAfter: admission.retryAfterSeconds })
  }
  return Object.freeze({
    async list({ auth, query } = {}) { requireAdmin(auth); const result = await repository.list(query); return { requests: result.data, hasNext: result.hasNext, nextCursor: result.nextCursor } },
    async get({ auth, takedownRequestId } = {}) { requireAdmin(auth); try { return serialize(await repository.getDetail(objectId(takedownRequestId)), clock()) } catch (error) { throw safeError(error) } },
    async create({ auth, input, request } = {}) {
      const user = requireAdmin(auth)
      if (!input || typeof input.requesterName !== 'string' || input.requesterName.length < 1 || input.requesterName.length > 160 || typeof input.requesterContact !== 'string' || input.requesterContact.length < 3 || input.requesterContact.length > 254 || typeof input.reason !== 'string' || input.reason.length < 3 || input.reason.length > 4000) throw new TakedownError(422, 'validation_error', 'Takedown request is invalid')
      const targetType = input.targetType === 'article' || input.targetType === 'source' ? input.targetType : null
      if (!targetType) throw new TakedownError(422, 'validation_error', 'Takedown target type is invalid')
      const targetIds = normalizeIds(input.targetIds); const requestedScope = normalizeScope(input.requestedScope); const now = clock()
      const created = await withTransaction(async (session) => {
        await fence(auth, user, session); await admit(user, session)
        if (typeof repository.assertTargetsCurrent !== 'function' || !await repository.assertTargetsCurrent({ targetType, targetIds, session, now })) throw new TakedownError(409, 'conflict', 'Takedown target lifecycle changed')
        const document = { _id: new ObjectId(), status: 'received', requesterName: input.requesterName, requesterContact: input.requesterContact, targetType, targetIds, reason: input.reason, evidenceNote: input.evidenceNote ?? null, requestedScope, decisionReasonCode: null, reviewedBy: null, reviewedAt: null, completedAt: null, piiPurgeAfter: null, workflowPurgeAfter: null, completion: { hidden: false, metadataRemoved: false, mediaMetadataRemoved: false, summaryRemoved: false, embeddingRemoved: false, historicalChatCitationsRedacted: false }, createdAt: now, updatedAt: now }
        await repository.insert(document, { session }); await repository.insertAudit({ action: 'takedown_received', targetId: document._id, actor: user, request, now, result: 'succeeded' }, session)
        return document
      })
      return serialize(created, now)
    },
    async update({ auth, takedownRequestId, input, request } = {}) {
      const user = requireAdmin(auth); const id = objectId(takedownRequestId); const status = input?.status; const reasonCode = input?.reasonCode
      if (!Object.hasOwn(REASONS, status) || REASONS[status] !== reasonCode) throw new TakedownError(422, 'validation_error', 'Takedown transition reason is invalid')
      const now = clock()
      const result = await withTransaction(async (session) => {
        await fence(auth, user, session); await admit(user, session)
        const current = await repository.findById(id, { session }); if (!current) throw new TakedownError(404, 'not_found', 'Takedown request not found')
        if (!(TRANSITIONS[current.status] ?? []).includes(status)) throw new TakedownError(409, 'conflict', 'Takedown transition is not allowed')
        if (typeof repository.assertTargetsCurrent !== 'function' || !await repository.assertTargetsCurrent({ targetType: current.targetType, targetIds: current.targetIds, requestedScope: current.requestedScope, desiredStatus: status, session, now })) throw new TakedownError(409, 'conflict', 'Takedown target lifecycle changed')
        const next = await repository.transition({ current, status, reasonCode, actor: user, actorFence: actorFence(auth, user), request, session, now })
        return next
      })
      return serialize(result, now)
    },
  })
}

export { COMPLETION_FIELD }
