import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { canUseQnaEvidence } from '../../domain/article/visibility.js'
import { admittedEvidenceText, evidenceCitationMetadataHash } from '../../domain/qa/evidence.js'

const DAY_MS = 24 * 60 * 60 * 1000
const CHAT_RETENTION_MS = 30 * DAY_MS
const ATTEMPT_RETENTION_MS = DAY_MS

function objectId(value, label = 'identifier') {
  if (value instanceof ObjectId) return value
  if (typeof value === 'string' && ObjectId.isValid(value) && new ObjectId(value).toHexString() === value.toLowerCase()) return new ObjectId(value)
  const error = new Error(`${label} is invalid`)
  error.code = 'validation_error'
  error.status = 422
  throw error
}

function dateValue(value, label = 'date') {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`)
  return date
}

function idString(value) {
  return value?.toHexString?.() ?? String(value)
}

function unwrap(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'value') ? value.value : value
}

function conflictError(message) {
  const error = new Error(message)
  error.code = 'conflict'
  error.status = 409
  return error
}

function articleFenceFilter(expected) {
  return expected.articleVersion === null || expected.articleVersion === undefined
    ? { version: { $exists: false } }
    : { version: expected.articleVersion }
}

function articleMatchesFence(article, expected) {
  if (expected.articleVersion !== null && expected.articleVersion !== undefined && article?.version !== expected.articleVersion) return false
  if ((expected.articleVersion === null || expected.articleVersion === undefined) && article?.version !== undefined) return false
  return article?.status === 'published' && article?.evidenceEligible === true && article?.rightsSnapshot?.sourcePolicyVersion === expected.sourcePolicyVersion
}

function citedEvidenceTargets({ answer, citations, expectedEvidenceFence }) {
  if (answer?.status !== 'answered') return []
  const citationIds = new Set((answer.paragraphs ?? []).flatMap(({ citationIds }) => Array.isArray(citationIds) ? citationIds : []))
  const expectedByArticle = new Map()
  for (const expected of expectedEvidenceFence?.articles ?? []) {
    const articleId = idString(objectId(expected.articleId, 'article'))
    const sourceId = idString(objectId(expected.sourceId, 'source'))
    const previous = expectedByArticle.get(articleId)
    if (previous && previous.sourceId !== sourceId) throw conflictError('Answer evidence changed')
    expectedByArticle.set(articleId, { ...expected, articleId, sourceId })
  }
  const citationTargets = new Map()
  const targets = new Map()
  for (const citation of [...(citations ?? []), ...(answer.citations ?? [])]) {
    if (!citationIds.has(citation?.id)) continue
    const articleId = idString(objectId(citation.articleId, 'citation article'))
    const sourceId = idString(objectId(citation.sourceId, 'citation source'))
    const citationTarget = citationTargets.get(citation.id)
    if (citationTarget && (citationTarget.articleId !== articleId || citationTarget.sourceId !== sourceId)) throw conflictError('Answer evidence changed')
    citationTargets.set(citation.id, { articleId, sourceId })
    const expected = expectedByArticle.get(articleId)
    if (!expected || expected.sourceId !== sourceId) throw conflictError('Answer evidence changed')
    const previous = targets.get(articleId)
    if (previous && previous.sourceId !== sourceId) throw conflictError('Answer evidence changed')
    targets.set(articleId, { articleId, sourceId, expected })
  }
  if ([...citationIds].some((citationId) => !citationTargets.has(citationId))) throw conflictError('Answer evidence changed')
  return [...targets.values()].sort((left, right) => left.articleId.localeCompare(right.articleId))
}

function encodeCursor(document) {
  return Buffer.from(JSON.stringify({ updatedAt: dateValue(document.updatedAt).toISOString(), id: idString(document._id) })).toString('base64url')
}
function summaryMessageCount(document) {
  const messages = Array.isArray(document?.messages) ? document.messages : null
  if (!messages || messages.length > 30 || !Number.isInteger(document.messageCount) || document.messageCount !== messages.length) {
    throw conflictError('Chat session message count is invalid')
  }
  return messages.length
}

function decodeCursor(value) {
  if (value === undefined || value === null || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'))
    if (!parsed || typeof parsed.updatedAt !== 'string' || !ObjectId.isValid(parsed.id)) throw new Error('invalid cursor')
    return { updatedAt: dateValue(parsed.updatedAt), id: objectId(parsed.id, 'cursor') }
  } catch {
    const error = new Error('Cursor is invalid')
    error.code = 'validation_error'
    error.status = 422
    throw error
  }
}

function publicScope(scope = {}) {
  const result = {}
  if (scope.articleId !== undefined && scope.articleId !== null) result.articleId = idString(scope.articleId)
  if (Array.isArray(scope.topics)) result.topics = [...scope.topics]
  if (scope.publishedAfter !== undefined) result.publishedAfter = dateValue(scope.publishedAfter).toISOString()
  if (scope.publishedBefore !== undefined) result.publishedBefore = dateValue(scope.publishedBefore).toISOString()
  return result
}

function historicalCitation(citation) {
  if (!citation || typeof citation.id !== 'string') throw new Error('Historical citation is invalid')
  if (citation.status === 'unavailable') {
    const result = { id: citation.id, status: 'unavailable', unavailableReason: citation.unavailableReason }
    if (citation.articleId) result.articleId = idString(citation.articleId)
    if (citation.sourceId) result.sourceId = idString(citation.sourceId)
    return result
  }
  if (citation.status !== 'available') throw new Error('Historical citation status is invalid')
  const parsedUrl = new URL(citation.originalUrl)
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('Historical citation URL is invalid')
  return {
    id: citation.id,
    status: 'available',
    articleId: idString(citation.articleId),
    sourceId: idString(citation.sourceId),
    originalUrl: parsedUrl.toString(),
    titleOriginal: String(citation.titleOriginal),
    publishedAt: dateValue(citation.publishedAt).toISOString(),
  }
}

function historicalCitationDocument(citation) {
  if (!citation || typeof citation.id !== 'string') throw new Error('Historical citation is invalid')
  const parsedUrl = new URL(citation.originalUrl)
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password || !citation.articleId || !citation.sourceId || typeof citation.titleOriginal !== 'string' || !citation.titleOriginal) throw new Error('Historical citation is invalid')
  return {
    id: citation.id,
    status: 'available',
    articleId: objectId(citation.articleId, 'citation article'),
    sourceId: objectId(citation.sourceId, 'citation source'),
    originalUrl: parsedUrl.toString(),
    titleOriginal: citation.titleOriginal.slice(0, 500),
    publishedAt: dateValue(citation.publishedAt),
  }
}

function redactHistoricalCitation(citation, { article, source } = {}) {
  if (citation?.status !== 'available') return historicalCitation(citation)
  if (canUseQnaEvidence(article, source)) return historicalCitation(citation)
  const reason = article?.status === 'hidden' || article?.status === 'removed' ? 'takedown' : source ? 'source-policy' : 'article-removed'
  return { id: citation.id, status: 'unavailable', articleId: citation.articleId, sourceId: citation.sourceId, unavailableReason: reason }
}

function publicAnswerCitation(citation, article, source) {
  if (!canUseQnaEvidence(article, source)) return null
  let originalUrl
  try {
    const parsed = new URL(article.originalUrl ?? citation.originalUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    originalUrl = parsed.toString()
  } catch { return null }
  return {
    id: citation.id,
    articleId: idString(article._id ?? article.id ?? citation.articleId),
    sourceId: idString(source._id ?? source.id ?? citation.sourceId),
    sourceName: typeof source.name === 'string' ? source.name : '',
    titleOriginal: String(article.titleOriginal ?? citation.titleOriginal ?? ''),
    originalUrl,
    author: typeof article.author === 'string' ? article.author : null,
    publishedAt: dateValue(article.publishedAt ?? citation.publishedAt).toISOString(),
    sourceLanguage: typeof article.sourceLanguage === 'string' ? article.sourceLanguage : 'unknown',
  }
}

function publicMessage(message) {
  if (!message || typeof message.id !== 'string' || !['user', 'assistant'].includes(message.role)) throw new Error('Chat message is invalid')
  if (message.role === 'user') return { id: message.id, role: 'user', text: String(message.text), createdAt: dateValue(message.createdAt).toISOString() }
  if (message.status === 'answered') return {
    id: message.id, role: 'assistant', status: 'answered',
    paragraphs: (message.paragraphs ?? []).map((paragraph) => ({ text: paragraph.text, citationIds: [...paragraph.citationIds] })),
    citations: (message.citations ?? []).map(historicalCitation), refusalReason: null,
    createdAt: dateValue(message.createdAt).toISOString(),
  }
  if (message.status === 'refused') return {
    id: message.id, role: 'assistant', status: 'refused', paragraphs: [], citations: [],
    refusalReason: message.refusalReason, createdAt: dateValue(message.createdAt).toISOString(),
  }
  throw new Error('Chat assistant message status is invalid')
}

export function serializeChatSession(document, { now = new Date() } = {}) {
  if (!document) return null
  const updatedAt = dateValue(document.updatedAt)
  if (updatedAt.getTime() + CHAT_RETENTION_MS <= dateValue(now).getTime()) return null
  const messages = Array.isArray(document.messages) ? document.messages : []
  if (messages.length > 30 || document.messageCount !== messages.length) throw new Error('Chat session message count is invalid')
  return {
    id: idString(document._id ?? document.id), title: document.title ?? null, scope: publicScope(document.scope),
    messageCount: messages.length, messages: messages.map(publicMessage),
    createdAt: dateValue(document.createdAt).toISOString(), updatedAt: updatedAt.toISOString(),
  }
}

function actorValues(actor = {}) {
  const userId = actor.userId ?? actor.user?._id ?? actor.user?.id
  const fence = actor.actorFence ?? {}
  const sessionId = actor.sessionId ?? fence.sessionId ?? actor.session?._id ?? actor.session?.id
  const sessionVersion = actor.sessionVersion ?? fence.sessionVersion ?? actor.expectedSessionVersion ?? actor.session?.userSessionVersion ?? actor.session?.version
  if (!userId || !sessionId || !Number.isInteger(sessionVersion) || sessionVersion < 0) {
    const error = new Error('Active user session fence is required')
    error.code = 'unauthorized'
    error.status = 401
    throw error
  }
  return { userId: objectId(userId, 'user'), sessionId: objectId(sessionId, 'session'), sessionVersion }
}

export class MongoChatRepository {
  constructor(context) {
    if (!context?.db || !context?.client) throw new Error('Mongo context is required')
    this.db = context.db
    this.client = context.client
    this.clock = typeof context.now === 'function' ? context.now : () => new Date()
  }

  collection(name) { return this.db.collection(name) }
  chatSessions() { return this.collection('chatSessions') }
  answerAttempts() { return this.collection('answerAttempts') }
  users() { return this.collection('users') }
  sessions() { return this.collection('sessions') }

  async withTransaction(work) {
    const session = this.client.startSession()
    try {
      let result
      await session.withTransaction(async () => { result = await work(session) }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } })
      return result
    } finally { await session.endSession() }
  }

  async assertActorFence(actor, options = {}) {
    const values = actorValues(actor)
    const now = this.clock()
    const user = await this.users().findOne({ _id: values.userId, status: 'active', sessionVersion: values.sessionVersion }, { ...options, projection: { _id: 1 } })
    const session = await this.sessions().findOne({ _id: values.sessionId, userId: values.userId, userSessionVersion: values.sessionVersion, status: 'active', expiresAt: { $gt: now }, absoluteExpiresAt: { $gt: now } }, { ...options, projection: { _id: 1 } })
    return Boolean(user && session)
  }

  async listChatSessions({ actor, userId, cursor, limit = 20, now = this.clock() } = {}) {
    const values = actor ? actorValues(actor) : { userId: objectId(userId, 'user') }
    if (actor && !await this.assertActorFence(actor)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { const error = new Error('Limit is invalid'); error.code = 'validation_error'; error.status = 422; throw error }
    const position = decodeCursor(cursor)
    const filter = { userId: values.userId, expiresAt: { $gt: dateValue(now) } }
    if (position) filter.$or = [{ updatedAt: { $lt: position.updatedAt } }, { updatedAt: position.updatedAt, _id: { $lt: position.id } }]
    const rows = await this.chatSessions().find(filter).sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).toArray()
    const hasNext = rows.length > limit
    const page = hasNext ? rows.slice(0, limit) : rows
    return { sessions: page.map((row) => ({ id: idString(row._id), title: row.title ?? null, messageCount: summaryMessageCount(row), updatedAt: dateValue(row.updatedAt).toISOString() })), hasNext, nextCursor: hasNext ? encodeCursor(page.at(-1)) : null }
  }

  async getChatSession({ actor, userId, chatSessionId, now = this.clock() } = {}) {
    const values = actor ? actorValues(actor) : { userId: objectId(userId, 'user') }
    if (actor && !await this.assertActorFence(actor)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
    const document = await this.chatSessions().findOne({ _id: objectId(chatSessionId, 'chat session'), userId: values.userId, expiresAt: { $gt: dateValue(now) } })
    if (!document) return null
    const citationIds = [...new Set((document.messages ?? []).flatMap((message) => (message.citations ?? []).filter(({ status }) => status === 'available').map(({ articleId, sourceId }) => `${idString(articleId)}:${idString(sourceId)}`)))]
    const visibility = new Map()
    for (const key of citationIds) {
      const [articleId, sourceId] = key.split(':')
      const article = await this.collection('articles').findOne({ _id: objectId(articleId, 'citation article'), sourceId: objectId(sourceId, 'citation source') })
      const source = article ? await this.collection('sources').findOne({ _id: article.sourceId }) : null
      visibility.set(key, { article, source })
    }
    const messages = (document.messages ?? []).map((message) => message.status === 'answered'
      ? { ...message, citations: (message.citations ?? []).map((citation) => redactHistoricalCitation(citation, visibility.get(`${idString(citation.articleId)}:${idString(citation.sourceId)}`))) }
      : message)
    return serializeChatSession({ ...document, messages }, { now })
  }

  async deleteChatSession({ actor, userId, chatSessionId } = {}) {
    const values = actor ? actorValues(actor) : { userId: objectId(userId, 'user') }
    if (actor && !await this.assertActorFence(actor)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
    await this.chatSessions().deleteOne({ _id: objectId(chatSessionId, 'chat session'), userId: values.userId })
  }

  async clearChatSessions({ actor, userId } = {}) {
    const values = actor ? actorValues(actor) : { userId: objectId(userId, 'user') }
    if (actor && !await this.assertActorFence(actor)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
    await this.chatSessions().deleteMany({ userId: values.userId })
  }

  async findAnswerAttempt({ actor, idempotencyKeyHash, options = {} } = {}) {
    const values = actorValues(actor)
    return this.answerAttempts().findOne({ userId: values.userId, sessionId: values.sessionId, expectedSessionVersion: values.sessionVersion, idempotencyKeyHash }, options)
  }

  async reserveAnswerAttempt({ actor, idempotencyKeyHash, requestHash, chatSessionId, quotaReservationKey, rateLimitAdmission, quotaScopes = ['answer-minute', 'answer-daily'], now = this.clock() } = {}) {
    const values = actorValues(actor)
    if (!/^[a-f0-9]{64}$/.test(idempotencyKeyHash) || !/^[a-f0-9]{64}$/.test(requestHash)) throw new Error('Answer attempt hashes are invalid')
    const current = dateValue(now)
    const document = {
      _id: new ObjectId(), userId: values.userId, sessionId: values.sessionId, expectedSessionVersion: values.sessionVersion,
      idempotencyKeyHash, requestHash, status: 'reserved', ...(chatSessionId ? { chatSessionId: objectId(chatSessionId, 'chat session') } : {}), quotaReservationKey: String(quotaReservationKey ?? 'answer:user'),
      expiresAt: new Date(current.getTime() + ATTEMPT_RETENTION_MS), createdAt: current, updatedAt: current,
    }
    const resolveExisting = async (options = {}) => {
      const existing = await this.findAnswerAttempt({ actor, idempotencyKeyHash, options })
      if (!existing) return null
      if (existing.requestHash !== requestHash) { const error = new Error('Idempotency key is bound to another request'); error.code = 'idempotency_mismatch'; error.status = 409; throw error }
      if (existing.status === 'provider-running' && dateValue(existing.providerReservationExpiresAt ?? existing.updatedAt) <= current) {
        const transition = await this.answerAttempts().updateOne({ _id: existing._id, status: 'provider-running', providerReservationExpiresAt: existing.providerReservationExpiresAt }, { $set: { status: 'failed', error: { code: 'ambiguous_provider_outcome', message: 'Provider outcome is unavailable', retryable: false, occurredAt: current }, updatedAt: current } }, options)
        if (transition.matchedCount === 1) return { ...existing, status: 'failed', error: { code: 'ambiguous_provider_outcome', message: 'Provider outcome is unavailable', retryable: false, occurredAt: current } }
        return this.findAnswerAttempt({ actor, idempotencyKeyHash, options })
      }
      return { ...existing, reused: true }
    }
    const work = async (session) => {
      const options = session ? { session } : {}
      if (!await this.assertActorFence(actor, options)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
      const existing = await resolveExisting(options)
      if (existing) return existing
      if (rateLimitAdmission?.reserve) {
        for (const scope of quotaScopes) {
          const admission = await rateLimitAdmission.reserve({ scope, subject: values.userId.toHexString(), session })
          if (!admission || admission.allowed !== true) {
            const error = new Error('Answer quota is temporarily unavailable')
            error.code = 'rate_limit_exceeded'; error.status = 429; error.retryAfter = admission?.retryAfterSeconds
            throw error
          }
        }
      }
      await this.answerAttempts().insertOne(document, options)
      return { ...document, reused: false }
    }
    try {
      return await this.withTransaction(work)
    } catch (error) {
      if (error?.code !== 11000) throw error
      const replay = await resolveExisting()
      if (!replay) throw error
      return replay
    }
  }

  async updateAnswerAttempt(id, update, options = {}) {
    const expectedStatuses = Array.isArray(options.expectedStatuses) ? options.expectedStatuses : options.expectedStatus ? [options.expectedStatus] : null
    const filter = { _id: objectId(id, 'answer attempt'), ...(expectedStatuses ? { status: { $in: expectedStatuses } } : {}) }
    const mongoOptions = { ...options, returnDocument: 'after' }
    delete mongoOptions.expectedStatus
    delete mongoOptions.expectedStatuses
    const result = await this.answerAttempts().findOneAndUpdate(filter, { $set: { ...update, updatedAt: this.clock() } }, mongoOptions)
    if (!unwrap(result) && expectedStatuses) { const error = new Error('Answer attempt state changed concurrently'); error.code = 'conflict'; error.status = 409; throw error }
    return unwrap(result)
  }

  async purgeDueAnswerAttempts({ cutoff = this.clock(), limit = 100 } = {}) {
    const current = dateValue(cutoff, 'Retention cutoff')
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Retention batch limit is invalid')
    const filter = { expiresAt: { $lte: current } }
    const candidates = await this.answerAttempts().find(filter).sort({ expiresAt: 1, _id: 1 }).hint('answer_attempts_expiry_deadline').project({ _id: 1 }).limit(limit + 1).toArray()
    const selected = candidates.slice(0, limit)
    if (selected.length === 0) return { inspected: 0, affected: 0, hasMore: false }
    const result = await this.answerAttempts().deleteMany({ _id: { $in: selected.map(({ _id }) => _id) }, ...filter })
    return { inspected: selected.length, affected: result.deletedCount, hasMore: candidates.length > limit }
  }

  async appendAnswer({ actor, chatSessionId, scope, question, answer, citations = [], attempt, now = this.clock(), expectedEvidenceFence } = {}) {
    const values = actorValues(actor)
    const current = dateValue(now)
    if (typeof question !== 'string' || question.length < 1 || question.length > 1000) throw new Error('Question is invalid')
    const assistant = answer?.status === 'answered'
      ? { id: answer.id ?? new ObjectId().toHexString(), role: 'assistant', status: 'answered', paragraphs: answer.paragraphs, citations: citations.map(historicalCitationDocument), refusalReason: null, createdAt: current }
      : { id: answer?.id ?? new ObjectId().toHexString(), role: 'assistant', status: 'refused', paragraphs: [], citations: [], refusalReason: answer?.refusalReason ?? 'insufficient-evidence', createdAt: current }
    const userMessage = { id: new ObjectId().toHexString(), role: 'user', text: question, createdAt: current }
    return this.withTransaction(async (session) => {
      const tx = { session }
      if (!await this.assertActorFence(actor, tx)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
      const userCollection = this.users()
      const sessionCollection = this.sessions()
      if (typeof userCollection.updateOne === 'function') {
        const userFence = await userCollection.updateOne({ _id: values.userId, status: 'active', sessionVersion: values.sessionVersion }, { $set: { updatedAt: current } }, tx)
        if (userFence.matchedCount !== 1) { const error = new Error('Active user lifecycle changed'); error.code = 'conflict'; error.status = 409; throw error }
      }
      if (typeof sessionCollection.updateOne === 'function') {
        const sessionFence = await sessionCollection.updateOne({ _id: values.sessionId, userId: values.userId, userSessionVersion: values.sessionVersion, status: 'active', expiresAt: { $gt: current }, absoluteExpiresAt: { $gt: current } }, { $set: { lastSeenAt: current } }, tx)
        if (sessionFence.matchedCount !== 1) { const error = new Error('Active session lifecycle changed'); error.code = 'conflict'; error.status = 409; throw error }
      }
      if (assistant.status === 'answered' && expectedEvidenceFence?.articles) {
        const qnaFenceToken = new ObjectId()
        const targets = citedEvidenceTargets({ answer, citations, expectedEvidenceFence })
        const sourceTargets = new Map()
        for (const target of targets) {
          const previous = sourceTargets.get(target.sourceId)
          if (previous && (previous.sourcePolicyVersion !== target.expected.sourcePolicyVersion || (previous.sourceKey ?? null) !== (target.expected.sourceKey ?? null))) throw conflictError('Answer evidence changed')
          sourceTargets.set(target.sourceId, { sourceId: target.sourceId, sourcePolicyVersion: target.expected.sourcePolicyVersion, sourceKey: target.expected.sourceKey ?? null })
        }
        const articleCollection = this.collection('articles')
        const sourceCollection = this.collection('sources')
        const lockedArticles = new Map()
        for (const target of targets) {
          const article = unwrap(await articleCollection.findOneAndUpdate({
            _id: objectId(target.articleId, 'article'), sourceId: objectId(target.sourceId, 'source'),
            status: 'published', evidenceEligible: true, 'rightsSnapshot.sourcePolicyVersion': target.expected.sourcePolicyVersion,
            ...articleFenceFilter(target.expected),
          }, { $set: { qnaFenceToken } }, { ...tx, returnDocument: 'after' }))
          if (!article) throw conflictError('Article visibility changed')
          lockedArticles.set(target.articleId, { ...target, article })
        }
        const lockedSources = new Map()
        for (const target of [...sourceTargets.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId))) {
          const source = unwrap(await sourceCollection.findOneAndUpdate({
            _id: objectId(target.sourceId, 'source'), policyVersion: target.sourcePolicyVersion,
            operationalStatus: 'active', licenseStatus: { $in: ['permitted', 'metadata-only'] },
            'technicalCheck.status': 'passed', authorityTier: { $in: ['primary', 'editorial'] },
          }, { $set: { qnaFenceToken } }, { ...tx, returnDocument: 'after' }))
          if (!source) throw conflictError('Source visibility changed')
          lockedSources.set(target.sourceId, source)
        }
        for (const target of lockedArticles.values()) {
          const source = lockedSources.get(target.sourceId)
          let textHash
          let citationMetadataHash
          try {
            textHash = createHash('sha256').update(admittedEvidenceText(target.article, source)).digest('hex')
            citationMetadataHash = evidenceCitationMetadataHash(target.article, source)
          } catch { throw conflictError('Source visibility changed') }
          if (idString(target.article._id) !== target.articleId || idString(target.article.sourceId) !== target.sourceId || idString(source?._id) !== target.sourceId || source?.policyVersion !== target.expected.sourcePolicyVersion || (source?.sourceKey ?? null) !== (target.expected.sourceKey ?? null) || !articleMatchesFence(target.article, target.expected) || !canUseQnaEvidence(target.article, source) || textHash !== target.expected.evidenceTextHash || citationMetadataHash !== target.expected.citationMetadataHash) throw conflictError('Source visibility changed')
        }
      }
      let sessionId = chatSessionId ? objectId(chatSessionId, 'chat session') : new ObjectId()
      let document = await this.chatSessions().findOne({ _id: sessionId, userId: values.userId, expiresAt: { $gt: current } }, tx)
      if (!document) {
        if (chatSessionId) { const error = new Error('Chat session is unavailable'); error.code = 'not_found'; error.status = 404; throw error }
        document = { _id: sessionId, userId: values.userId, title: null, scope: { ...scope, ...(scope?.articleId ? { articleId: objectId(scope.articleId, 'article') } : {}) }, messages: [], messageCount: 0, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS), createdAt: current, updatedAt: current }
        await this.chatSessions().insertOne(document, tx)
      }
      if (document.messageCount + 2 > 30) {
        sessionId = new ObjectId()
        document = { _id: sessionId, userId: values.userId, title: null, scope: { ...document.scope }, messages: [], messageCount: 0, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS), createdAt: current, updatedAt: current }
        await this.chatSessions().insertOne(document, tx)
      }
      const result = await this.chatSessions().findOneAndUpdate({ _id: sessionId, userId: values.userId, messageCount: document.messageCount, expiresAt: { $gt: current } }, { $push: { messages: { $each: [userMessage, assistant] } }, $inc: { messageCount: 2 }, $set: { updatedAt: current, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS) } }, { ...tx, returnDocument: 'after' })
      const after = unwrap(result)
      if (!after) { const error = new Error('Chat session changed concurrently'); error.code = 'conflict'; error.status = 409; throw error }
      if (attempt?.id) {
        const outcome = attempt.outcome === 'completed' ? { status: 'completed', resultStatus: 'answered' } : attempt.outcome === 'refused' ? { status: 'refused', resultStatus: 'refused' } : null
        if (!outcome) throw new Error('Answer attempt outcome is invalid')
        const receipt = await this.answerAttempts().findOneAndUpdate({ _id: objectId(attempt.id, 'answer attempt'), userId: values.userId, sessionId: values.sessionId, expectedSessionVersion: values.sessionVersion, status: { $in: ['reserved', 'provider-running'] } }, { $set: { ...outcome, chatSessionId: after._id, messageId: assistant.id, updatedAt: current } }, { ...tx, returnDocument: 'after' })
        if (!unwrap(receipt)) { const error = new Error('Answer attempt state changed concurrently'); error.code = 'conflict'; error.status = 409; throw error }
      }
      const publicAnswer = assistant.status === 'answered'
        ? { id: answer.id ?? assistant.id, status: 'answered', paragraphs: (answer.paragraphs ?? []).map(({ text, citationIds }) => ({ text, citationIds: [...citationIds] })), citations: Array.isArray(answer.citations) ? answer.citations : [], refusalReason: null, chatSessionId: idString(after._id), createdAt: dateValue(answer.createdAt ?? current).toISOString() }
        : { id: assistant.id, status: 'refused', paragraphs: [], citations: [], refusalReason: assistant.refusalReason, chatSessionId: idString(after._id), createdAt: dateValue(assistant.createdAt).toISOString() }
      return { chatSessionId: idString(after._id), messageId: assistant.id, answer: publicAnswer, session: serializeChatSession(after, { now: current }), ...(attempt?.id ? { attemptCommitted: true } : {}) }
    })
  }

  async appendRefusalWithoutQuestion({ actor, chatSessionId, scope, answer, attempt, now = this.clock() } = {}) {
    const values = actorValues(actor)
    const current = dateValue(now)
    const assistant = {
      id: answer?.id ?? new ObjectId().toHexString(), role: 'assistant', status: 'refused', paragraphs: [], citations: [],
      refusalReason: 'sensitive-input', createdAt: current,
    }
    return this.withTransaction(async (session) => {
      const tx = { session }
      if (!await this.assertActorFence(actor, tx)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
      if (typeof this.users().updateOne === 'function') {
        const userFence = await this.users().updateOne({ _id: values.userId, status: 'active', sessionVersion: values.sessionVersion }, { $set: { updatedAt: current } }, tx)
        if (userFence.matchedCount !== 1) { const error = new Error('Active user lifecycle changed'); error.code = 'conflict'; error.status = 409; throw error }
      }
      if (typeof this.sessions().updateOne === 'function') {
        const sessionFence = await this.sessions().updateOne({ _id: values.sessionId, userId: values.userId, userSessionVersion: values.sessionVersion, status: 'active', expiresAt: { $gt: current }, absoluteExpiresAt: { $gt: current } }, { $set: { lastSeenAt: current } }, tx)
        if (sessionFence.matchedCount !== 1) { const error = new Error('Active session lifecycle changed'); error.code = 'conflict'; error.status = 409; throw error }
      }
      let sessionId = chatSessionId ? objectId(chatSessionId, 'chat session') : new ObjectId()
      let document = await this.chatSessions().findOne({ _id: sessionId, userId: values.userId, expiresAt: { $gt: current } }, tx)
      if (!document) {
        if (chatSessionId) { const error = new Error('Chat session is unavailable'); error.code = 'not_found'; error.status = 404; throw error }
        document = { _id: sessionId, userId: values.userId, title: null, scope: { ...scope, ...(scope?.articleId ? { articleId: objectId(scope.articleId, 'article') } : {}) }, messages: [], messageCount: 0, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS), createdAt: current, updatedAt: current }
        await this.chatSessions().insertOne(document, tx)
      }
      if (document.messageCount + 1 > 30) {
        sessionId = new ObjectId()
        document = { _id: sessionId, userId: values.userId, title: null, scope: { ...document.scope }, messages: [], messageCount: 0, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS), createdAt: current, updatedAt: current }
        await this.chatSessions().insertOne(document, tx)
      }
      const result = await this.chatSessions().findOneAndUpdate({ _id: sessionId, userId: values.userId, messageCount: document.messageCount, expiresAt: { $gt: current } }, { $push: { messages: assistant }, $inc: { messageCount: 1 }, $set: { updatedAt: current, expiresAt: new Date(current.getTime() + CHAT_RETENTION_MS) } }, { ...tx, returnDocument: 'after' })
      const after = unwrap(result)
      if (!after) { const error = new Error('Chat session changed concurrently'); error.code = 'conflict'; error.status = 409; throw error }
      if (attempt?.id) {
        const receipt = await this.answerAttempts().findOneAndUpdate({ _id: objectId(attempt.id, 'answer attempt'), userId: values.userId, sessionId: values.sessionId, expectedSessionVersion: values.sessionVersion, status: 'reserved' }, { $set: { status: 'refused', resultStatus: 'refused', chatSessionId: after._id, messageId: assistant.id, updatedAt: current } }, { ...tx, returnDocument: 'after' })
        if (!unwrap(receipt)) { const error = new Error('Answer attempt state changed concurrently'); error.code = 'conflict'; error.status = 409; throw error }
      }
      return { chatSessionId: idString(after._id), messageId: assistant.id, answer: { id: assistant.id, status: 'refused', paragraphs: [], citations: [], refusalReason: assistant.refusalReason, chatSessionId: idString(after._id), createdAt: dateValue(assistant.createdAt).toISOString() }, session: serializeChatSession(after, { now: current }), ...(attempt?.id ? { attemptCommitted: true } : {}) }
    })
  }

  async getAnswerResult({ actor, chatSessionId, messageId, now = this.clock() } = {}) {
    const values = actorValues(actor)
    if (!await this.assertActorFence(actor)) { const error = new Error('Authentication is required'); error.code = 'unauthorized'; error.status = 401; throw error }
    const document = await this.chatSessions().findOne({ _id: objectId(chatSessionId, 'chat session'), userId: values.userId, expiresAt: { $gt: dateValue(now) } })
    if (!document) return null
    const message = (document.messages ?? []).find((item) => item.id === messageId && item.role === 'assistant')
    if (!message) return null
    if (message.status !== 'answered') return { id: message.id, status: 'refused', paragraphs: [], citations: [], refusalReason: message.refusalReason, chatSessionId: idString(document._id), createdAt: dateValue(message.createdAt).toISOString() }
    const citations = []
    let revoked = false
    for (const citation of message.citations ?? []) {
      const article = citation.status === 'available' ? await this.collection('articles').findOne({ _id: citation.articleId, sourceId: citation.sourceId }) : null
      const source = article ? await this.collection('sources').findOne({ _id: article.sourceId }) : null
      const projected = publicAnswerCitation(citation, article, source)
      if (!projected) revoked = true
      else citations.push(projected)
    }
    if (revoked || citations.length !== (message.citations ?? []).length) return { id: message.id, status: 'refused', paragraphs: [], citations: [], refusalReason: 'policy-blocked', chatSessionId: idString(document._id), createdAt: dateValue(message.createdAt).toISOString() }
    return { id: message.id, status: 'answered', paragraphs: (message.paragraphs ?? []).map((paragraph) => ({ text: paragraph.text, citationIds: [...paragraph.citationIds] })), citations, refusalReason: null, chatSessionId: idString(document._id), createdAt: dateValue(message.createdAt).toISOString() }
  }
}

export { actorValues, decodeCursor, encodeCursor, historicalCitation, historicalCitationDocument, redactHistoricalCitation, publicAnswerCitation, publicMessage }
