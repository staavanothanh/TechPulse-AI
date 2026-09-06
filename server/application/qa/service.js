import { createHash, randomUUID } from 'node:crypto'
import { canonicalRequestHash } from '../../domain/jobs/idempotency.js'
import { ContentError, contentActorFence } from '../articles/query.js'
import { admitQuestion, detectSensitiveInput, PrivacyAdmissionError } from '../../domain/qa/privacy.js'
import { buildGroundedPrompt, evidenceAdmissionFence, filterQnaEvidence, EvidenceSelectionError } from '../../domain/qa/evidence.js'
import { planQaIntent, assertQaIntentProposal, QA_TIME_ZONE } from './intent-planner.js'
import { compileQaExecutionPlan } from './intent-compiler.js'
import { clarificationForCode, QA_CLARIFICATION_CODES } from '../../domain/qa/intent.js'
import { hydrateAnswerCitations, validateParagraphCitations } from '../../domain/qa/citations.js'
import { assertSupportedAnswer, deterministicRefusal } from '../../domain/qa/support.js'
import { ProviderAdapterError } from '../../ai/provider-error-taxonomy.js'

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const EXECUTION_BUDGET_MS = 30_000
const CLEANUP_GRACE_MS = 250
const MAX_SUPPORT_SERIALIZED_CHARS = 30_000
const MAX_SUPPORT_PARAGRAPH_CHARS = 10_000
const MAX_QUERY_VARIANTS = 3

function boundedQueryVariants(value) {
  if (!Array.isArray(value)) return Object.freeze([])
  const retained = []
  const seen = new Set()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    retained.push(normalized)
    if (retained.length >= MAX_QUERY_VARIANTS) break
  }
  return Object.freeze(retained)
}


class QaExecutionControlError extends Error {
  constructor() {
    super('Q&A execution was cancelled')
    this.name = 'QaExecutionControlError'
    this.code = 'execution_cancelled'
  }
}

function signalLike(value) {
  return Boolean(value && typeof value.aborted === 'boolean' && typeof value.addEventListener === 'function')
}

function deadlineDate(value) {
  if (value === undefined || value === null) return undefined
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value)
  if (Number.isNaN(date.getTime())) throw new ContentError(503, 'service_unavailable', 'Q&A service is temporarily unavailable')
  return date
}

function executionContext({ request, signal, deadline, referenceInstant } = {}) {
  const callerSignal = signalLike(signal) ? signal : signalLike(request?.signal) ? request.signal : undefined
  const requestedDeadline = deadline ?? request?.deadline
  const callerDeadline = deadlineDate(requestedDeadline)
  const boundedAt = referenceInstant.getTime() + EXECUTION_BUDGET_MS
  const deadlineAt = Math.min(boundedAt, callerDeadline?.getTime() ?? Number.POSITIVE_INFINITY)
  const finiteDeadlineAt = Number.isFinite(deadlineAt) ? deadlineAt : undefined
  const controller = new globalThis.AbortController()
  let timer
  let onAbort
  let onRequestAbort
  const cancel = () => controller.abort()
  if (callerSignal) {
    onAbort = cancel
    if (callerSignal.aborted) cancel()
    else callerSignal.addEventListener('abort', onAbort, { once: true })
  }
  if (request?.aborted === true) cancel()
  if (typeof request?.once === 'function') {
    onRequestAbort = cancel
    request.once('aborted', onRequestAbort)
  }
  if (finiteDeadlineAt !== undefined && finiteDeadlineAt <= referenceInstant.getTime()) cancel()
  else if (finiteDeadlineAt !== undefined) {
    timer = globalThis.setTimeout(cancel, Math.max(0, finiteDeadlineAt - referenceInstant.getTime()))
    timer.unref?.()
  }
  return {
    signal: controller.signal,
    deadline: finiteDeadlineAt === undefined ? undefined : new Date(finiteDeadlineAt),
    isUnavailable: () => controller.signal.aborted,
    cleanup() {
      if (timer) globalThis.clearTimeout(timer)
      if (callerSignal && onAbort) callerSignal.removeEventListener?.('abort', onAbort)
      if (request && onRequestAbort) {
        if (typeof request.off === 'function') request.off('aborted', onRequestAbort)
        else request.removeListener?.('aborted', onRequestAbort)
      }
    },
  }
}
function awaitExecution(operation, execution, now = () => new Date()) {
  return new Promise((resolve, reject) => {
    try { throwIfExecutionUnavailable(execution, now) } catch (error) { reject(error); return }
    let settled = false
    const onAbort = () => finish(reject, new QaExecutionControlError())
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      execution?.signal?.removeEventListener?.('abort', onAbort)
      callback(value)
    }
    execution?.signal?.addEventListener?.('abort', onAbort, { once: true })
    if (execution?.isUnavailable?.()) { onAbort(); return }
    Promise.resolve().then(operation).then((value) => finish(resolve, value), (error) => finish(reject, error))
  })
}

function deadlinePassed(deadline, now) {
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) return false
  const current = now()
  return current instanceof Date && !Number.isNaN(current.getTime()) && current.getTime() >= deadline.getTime()
}

function throwIfExecutionUnavailable(execution, now) {
  if (execution?.isUnavailable?.() || deadlinePassed(execution?.deadline, now)) throw new QaExecutionControlError()
}

function isExecutionUnavailable(error, execution, now) {
  return error instanceof QaExecutionControlError || execution?.isUnavailable?.() || deadlinePassed(execution?.deadline, now)
}

function boundedCleanup(operation) {
  return new Promise((resolve) => {
    let settled = false
    let timer
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) globalThis.clearTimeout(timer)
      resolve()
    }
    timer = globalThis.setTimeout(finish, CLEANUP_GRACE_MS)
    timer.unref?.()
    Promise.resolve().then(operation).then(finish, finish)
  })
}

async function markCancelledAttempt(answerAttemptRepository, attempt, now, expectedStatuses = ['reserved', 'provider-running']) {
  if (!attempt?._id || attempt.reused === true || typeof answerAttemptRepository?.updateAnswerAttempt !== 'function') return
  const occurredAt = now()
  await boundedCleanup(() => answerAttemptRepository.updateAnswerAttempt(attempt._id, {
    status: 'failed',
    providerReservationExpiresAt: occurredAt,
    error: { code: 'service_unavailable', message: 'Answer execution was cancelled', retryable: true, occurredAt },
  }, { expectedStatuses }))
}

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeDeep(nested)
  return Object.freeze(value)
}

function citedEvidenceBlocks({ paragraphs, blocks }) {
  const citedIds = new Set(paragraphs.flatMap(({ evidenceBlockIds }) => evidenceBlockIds))
  return blocks.filter(({ id }) => citedIds.has(id))
}

function boundedSupportInput({ question, paragraphs, blocks }) {
  const supportParagraphs = paragraphs.map(({ text, citationIds, evidenceBlockIds }) => ({ text, citationIds: [...citationIds], evidenceBlockIds: [...evidenceBlockIds] }))
  if (supportParagraphs.reduce((total, { text }) => total + text.length, 0) > MAX_SUPPORT_PARAGRAPH_CHARS) throw new ProviderAdapterError('support')
  const evidenceBlocks = citedEvidenceBlocks({ paragraphs: supportParagraphs, blocks }).map(({ id, citationId, text }) => ({ id, citationId, text }))
  const supportInput = freezeDeep({
    question,
    addressesQuestion: true,
    paragraphs: supportParagraphs,
    evidenceBlocks,
    evidenceMap: Object.fromEntries(evidenceBlocks.map(({ id, citationId }) => [id, citationId])),
  })
  if (JSON.stringify(supportInput).length >= MAX_SUPPORT_SERIALIZED_CHARS) throw new ProviderAdapterError('support')
  return supportInput
}

function providerMetadataUpdate(metadata) {
  if (!metadata?.routeId || !metadata?.providerFailureDomainId) return null
  const fallbackKind = metadata.fallback === 'model' || metadata.fallback === 'provider' ? metadata.fallback : 'none'
  return { providerRouteId: metadata.routeId, providerFailureDomainId: metadata.providerFailureDomainId, fallbackKind }
}

function isLocalControlFailure(error) {
  return error instanceof EvidenceSelectionError || error instanceof ContentError && [401, 409, 503].includes(error.status)
}

function mapQaInfrastructureError(error, stage) {
  const name = typeof error?.name === 'string' ? error.name : undefined
  const code = Number.isInteger(error?.code) ? error.code : undefined
  const protectedStatus = [401, 409, 429].includes(error?.status)
  const isMongoError = name?.startsWith('Mongo') || code !== undefined
  if (!isMongoError || protectedStatus || name === 'ProviderRoutingError') return null
  console.error('Q&A infrastructure error', { stage, name, code })
  return new ContentError(503, 'service_unavailable', 'Q&A service is temporarily unavailable')
}

async function qaRepositoryCall(stage, operation) {
  try {
    return await operation()
  } catch (error) {
    const mapped = mapQaInfrastructureError(error, stage)
    throw mapped ?? error
  }
}

function scopeValue(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new ContentError(422, 'validation_error', 'Answer scope is invalid')
  let topics
  if (scope.topics !== undefined) {
    if (!Array.isArray(scope.topics) || scope.topics.length > 10 || scope.topics.some((topic) => typeof topic !== 'string')) throw new ContentError(422, 'validation_error', 'Answer topics are invalid')
    const normalizedTopics = scope.topics.map((topic) => topic.trim().toLowerCase())
    if (normalizedTopics.some((topic) => topic.length < 1 || topic.length > 100) || new Set(normalizedTopics).size !== normalizedTopics.length) throw new ContentError(422, 'validation_error', 'Answer topics are invalid')
    topics = [...normalizedTopics].sort()
  }
  const hasScope = scope.articleId || topics?.length > 0 || scope.publishedAfter && scope.publishedBefore
  if (!hasScope) throw new ContentError(422, 'validation_error', 'Answer scope is required')
  if ((scope.publishedAfter && !scope.publishedBefore) || (!scope.publishedAfter && scope.publishedBefore)) throw new ContentError(422, 'validation_error', 'Answer date range is invalid')
  const publishedAfter = scope.publishedAfter ? new Date(scope.publishedAfter) : undefined
  const publishedBefore = scope.publishedBefore ? new Date(scope.publishedBefore) : undefined
  if ((publishedAfter && Number.isNaN(publishedAfter.getTime())) || (publishedBefore && Number.isNaN(publishedBefore.getTime())) || (publishedAfter && publishedBefore && publishedAfter > publishedBefore)) throw new ContentError(422, 'validation_error', 'Answer date range is invalid')
  return {
    ...(scope.articleId ? { articleId: scope.articleId?.toHexString?.() ?? String(scope.articleId) } : {}),
    ...(topics ? { topics } : {}),
    ...(publishedAfter ? { publishedAfter } : {}),
    ...(publishedBefore ? { publishedBefore } : {}),
  }
}

function answerRefusal({ id, chatSessionId, reason, createdAt }) {
  return { id, status: 'refused', paragraphs: [], citations: [], refusalReason: reason, chatSessionId, createdAt }
}

function scopeHashValue(scope) {
  return {
    ...scope,
    ...(scope.publishedAfter ? { publishedAfter: scope.publishedAfter.toISOString() } : {}),
    ...(scope.publishedBefore ? { publishedBefore: scope.publishedBefore.toISOString() } : {}),
  }
}
function safeClarificationDetail(value) {
  const code = QA_CLARIFICATION_CODES.includes(value?.code) ? value.code : 'qa_clarify_ambiguous_time'
  return { field: '/question', code, message: clarificationForCode(code) }
}

function clarificationError(value) {
  const detail = safeClarificationDetail(value)
  return new ContentError(422, 'validation_error', detail.message, [detail])
}

function clarificationFromAttempt(attempt) {
  return attempt?.error?.code?.startsWith('qa_clarify_') ? { code: attempt.error.code, field: '/question', message: attempt.error.message } : null
}

export function createQaService({ articleRepository, chatRepository, answerAttemptRepository = chatRepository, providerRouter, providerAdapters = {}, rateLimitAdmission, queryEmbedding, privacyCapability = 'zdr-verified', supportVerifier, intentPlanner = planQaIntent, intentCompiler = compileQaExecutionPlan, qaTimeZone = QA_TIME_ZONE, now = () => new Date() } = {}) {
  if (!chatRepository || typeof chatRepository.reserveAnswerAttempt !== 'function') throw new Error('Chat repository is required')
  if (!providerRouter || typeof providerRouter.execute !== 'function') throw new Error('Provider router is required')
  const articleRepo = articleRepository ?? { findQnaEvidence: async () => [] }
  const adapters = providerAdapters
  const verifySupport = supportVerifier ?? (async () => ({ verdict: 'uncertain' }))

  async function actorFenceRead(actor, execution) {
    if (typeof chatRepository.assertActorFence !== 'function') return true
    return await awaitExecution(() => qaRepositoryCall('assertActorFence', () => chatRepository.assertActorFence(actor, { signal: execution.signal, deadline: execution.deadline })), execution, now)
  }

  async function attemptUpdate(attemptId, update, options, execution) {
    if (typeof answerAttemptRepository.updateAnswerAttempt !== 'function') return undefined
    return await awaitExecution(() => qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attemptId, update, options)), execution, now)
  }

  async function reserveAttemptWithCancellationCleanup({ actor, idempotencyKeyHash, requestHash, chatSessionId, execution }) {
    let reservationAccepted = false
    const reservation = awaitExecution(() => {
      const operation = qaRepositoryCall('reserveAnswerAttempt', () => answerAttemptRepository.reserveAnswerAttempt({
        actor,
        idempotencyKeyHash,
        requestHash,
        chatSessionId,
        quotaReservationKey: `answer:${actor.userId}`,
        rateLimitAdmission,
        quotaScopes: ['answer-minute', 'answer-daily'],
        now: now(),
        signal: execution.signal,
        deadline: execution.deadline,
      }))
      Promise.resolve(operation).then((candidate) => {
        if (!reservationAccepted && isExecutionUnavailable(undefined, execution, now)) {
          Promise.resolve(markCancelledAttempt(answerAttemptRepository, candidate, now, ['reserved'])).catch(() => {})
        }
      }, () => {})
      return operation
    }, execution, now)
    const attempt = await reservation
    reservationAccepted = true
    return attempt
  }

  async function prepareProviderInput({ question, admittedQuestion, scope, expectedFence, ordering = ['relevance'], queryVariants = [], execution }) {
    const boundedVariants = boundedQueryVariants(queryVariants)
    const admitted = admittedQuestion ?? admitQuestion(question, { capability: privacyCapability })
    throwIfExecutionUnavailable(execution, now)
    let embedding
    if (typeof queryEmbedding === 'function') {
      try {
        const contextOptions = queryEmbedding.length > 1 || queryEmbedding.executionContextAware === true
          ? { signal: execution.signal, deadline: execution.deadline }
          : null
        embedding = contextOptions
          ? await awaitExecution(() => queryEmbedding(admitted.question, contextOptions), execution, now)
          : await awaitExecution(() => queryEmbedding(admitted.question), execution, now)
      } catch (error) {
        if (isExecutionUnavailable(error, execution, now)) throw new QaExecutionControlError()
        embedding = undefined
      }
      if (embedding && (typeof embedding.model !== 'string' || !embedding.model || !Number.isInteger(embedding.dimensions) || embedding.dimensions < 1 || !Number.isInteger(embedding.version) || embedding.version < 1 || typeof embedding.artifactCompatibilityId !== 'string' || !embedding.artifactCompatibilityId || !Array.isArray(embedding.embedding) || embedding.embedding.length !== embedding.dimensions || embedding.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) embedding = undefined
    }
    throwIfExecutionUnavailable(execution, now)
    const records = await awaitExecution(() => qaRepositoryCall('findQnaEvidence', () => articleRepo.findQnaEvidence({ question: admitted.question, queryEmbedding: embedding, queryVariants: boundedVariants, scope, ordering, limit: 50, includeSource: true, signal: execution.signal, deadline: execution.deadline })), execution, now)
    throwIfExecutionUnavailable(execution, now)
    let evidence
    try {
      evidence = filterQnaEvidence(records)
    } catch (error) {
      if (expectedFence && error instanceof EvidenceSelectionError) { error.discard = true; throw error }
      throw error
    }
    throwIfExecutionUnavailable(execution, now)
    const prompt = buildGroundedPrompt({ question: admitted.question, evidence })
    evidence = prompt.evidence
    let fence
    try {
      fence = evidenceAdmissionFence(evidence)
    } catch (error) {
      if (expectedFence && error instanceof EvidenceSelectionError) { error.discard = true }
      throw error
    }
    if (expectedFence && fence.digest !== expectedFence.digest) {
      const error = new EvidenceSelectionError('policy-blocked', 'Evidence policy changed during answer generation')
      error.discard = true
      throw error
    }
    throwIfExecutionUnavailable(execution, now)
    const routerPrompt = Object.freeze({
      prompt: prompt.prompt,
      citations: Object.freeze(prompt.citations.map(({ id, articleId, sourceId }) => Object.freeze({ id, articleId, sourceId }))),
      blocks: Object.freeze(prompt.blocks.map(({ id, citationId, text }) => Object.freeze({ id, citationId, text }))),
      evidenceMap: Object.freeze({ ...prompt.evidenceMap }),
    })
    const selectedArticleIds = Object.freeze(evidence.map(({ article }) => article?.id ?? (article?._id?.toHexString ? article._id.toHexString() : String(article?._id ?? ''))).filter(Boolean))
    return Object.freeze({ admitted, evidence, fence: Object.freeze(fence), prompt, selectedArticleIds, queryVariants: boundedVariants, routerInput: freezeDeep({ question: admitted.question, prompt: routerPrompt }), embedding })
  }

  async function assertCurrentEvidenceFence({ providerInput, scope, ordering = ['relevance'], execution }) {
    throwIfExecutionUnavailable(execution, now)
    const selectedArticleIds = providerInput.selectedArticleIds ?? providerInput.evidence.map(({ article }) => article?.id ?? (article?._id?.toHexString ? article._id.toHexString() : String(article?._id ?? ''))).filter(Boolean)
    const recheckScope = { ...scope, articleIds: [...selectedArticleIds] }
    const records = await awaitExecution(() => qaRepositoryCall('recheckEvidence', () => typeof articleRepo.findQnaEvidenceByIds === 'function'
      ? articleRepo.findQnaEvidenceByIds({ ids: selectedArticleIds, question: providerInput.admitted.question, queryEmbedding: providerInput.embedding, queryVariants: providerInput.queryVariants, scope, ordering, limit: 50, includeSource: true, signal: execution.signal, deadline: execution.deadline })
      : articleRepo.findQnaEvidence({ question: providerInput.admitted.question, queryEmbedding: providerInput.embedding, queryVariants: providerInput.queryVariants, scope: recheckScope, ordering, limit: 50, includeSource: true, signal: execution.signal, deadline: execution.deadline })), execution, now)
    throwIfExecutionUnavailable(execution, now)
    const selectedIdsSet = new Set(selectedArticleIds.map((id) => String(id)))
    const matchingRecords = (records ?? []).filter((record) => {
      const id = String(record?.article?.id ?? record?.article?._id ?? record?.id ?? record?._id ?? '')
      return selectedIdsSet.has(id)
    })
    let currentEvidence
    try { currentEvidence = filterQnaEvidence(matchingRecords) } catch (error) {
      if (error instanceof EvidenceSelectionError) error.discard = true
      throw error
    }
    let currentFence
    try { currentFence = evidenceAdmissionFence(currentEvidence) } catch (error) {
      if (error instanceof EvidenceSelectionError) error.discard = true
      throw error
    }
    if (currentFence.digest !== providerInput.fence.digest) {
      const error = new EvidenceSelectionError('policy-blocked', 'Evidence policy changed during answer generation')
      error.discard = true
      throw error
    }
    throwIfExecutionUnavailable(execution, now)
    return currentFence
  }

  async function refusal({ actor, attempt, reason, scope, question, expectedEvidenceFence, execution }) {
    throwIfExecutionUnavailable(execution, now)
    const createdAt = now().toISOString()
    let chat = null
    if (typeof chatRepository.appendAnswer === 'function') {
      chat = await awaitExecution(() => qaRepositoryCall('appendAnswer', () => chatRepository.appendAnswer({ actor, chatSessionId: attempt.chatSessionId, scope, question, answer: answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: attempt.chatSessionId, reason, createdAt }), attempt: { id: attempt._id, outcome: 'refused' }, expectedEvidenceFence, now: now(), signal: execution.signal, deadline: execution.deadline })), execution, now)
    }
    throwIfExecutionUnavailable(execution, now)
    if (!chat?.attemptCommitted) await attemptUpdate(attempt._id, { status: 'refused', resultStatus: 'refused', chatSessionId: chat?.chatSessionId, messageId: chat?.messageId }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
    return chat?.answer ?? answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: chat?.chatSessionId ?? attempt.chatSessionId, reason, createdAt })
  }

  async function privacyRefusal({ actor, attempt, scope, chatSessionId, execution }) {
    throwIfExecutionUnavailable(execution, now)
    if (typeof chatRepository.appendRefusalWithoutQuestion !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
    const createdAt = now().toISOString()
    const answer = answerRefusal({ id: `answer-${randomUUID()}`, chatSessionId, reason: 'sensitive-input', createdAt })
    const chat = await awaitExecution(() => qaRepositoryCall('appendRefusalWithoutQuestion', () => chatRepository.appendRefusalWithoutQuestion({ actor, chatSessionId, scope, answer, attempt: { id: attempt._id, outcome: 'refused' }, now: now(), signal: execution.signal, deadline: execution.deadline })), execution, now)
    throwIfExecutionUnavailable(execution, now)
    return chat?.answer ?? { ...answer, chatSessionId: chat?.chatSessionId ?? chatSessionId }
  }


  function routeFromInvocation(invocation) {
    return invocation && typeof invocation === 'object' && Object.hasOwn(invocation, 'route') ? invocation.route : invocation
  }

  function inputFromInvocation(invocation, fallback) {
    return invocation && typeof invocation === 'object' && Object.hasOwn(invocation, 'admittedInput') ? invocation.admittedInput : fallback
  }

  async function markAmbiguousAttempt(attempt, execution) {
    const error = { code: 'ambiguous_provider_outcome', message: 'Provider outcome is unavailable', retryable: false, occurredAt: now() }
    if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
      try {
        await attemptUpdate(attempt._id, { status: 'failed', error }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
      } catch (updateError) {
        if (isExecutionUnavailable(updateError, execution, now)) throw updateError
        // An earlier CAS may have completed the terminal transition.
      }
    }
    throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
  }

  async function createAnswer({ auth, question, scope, chatSessionId, idempotencyKey, request, signal, deadline } = {}) {
    let actor
    try { actor = contentActorFence(auth) } catch { throw new ContentError(401, 'unauthorized', 'Authentication is required') }
    if (!KEY_PATTERN.test(String(idempotencyKey ?? ''))) throw new ContentError(400, 'bad_request', 'Idempotency-Key is invalid')
    const referenceInstant = new Date(now())
    const safeScope = scopeValue(scope)
    if (typeof question !== 'string' || question.length < 3 || question.length > 1000) throw new ContentError(422, 'validation_error', 'Question is invalid')
    let privacyError
    let admittedQuestion
    try { admittedQuestion = admitQuestion(question, { capability: privacyCapability }) } catch (error) {
      if (error instanceof PrivacyAdmissionError && error.code === 'sensitive-input') privacyError = error
      else throw error
    }
    const sensitiveScope = detectSensitiveInput(JSON.stringify(safeScope))
    if (sensitiveScope && !privacyError) privacyError = new PrivacyAdmissionError('sensitive-input', 'Answer scope cannot be processed safely')
    const refusalScope = sensitiveScope ? Object.freeze({}) : safeScope
    const execution = executionContext({ request, signal, deadline, referenceInstant })
    let attempt
    try {
      throwIfExecutionUnavailable(execution, now)
      if (chatSessionId) {
        if (typeof chatRepository.getChatSession !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
        const existingSession = await awaitExecution(() => qaRepositoryCall('getChatSession', () => chatRepository.getChatSession({ actor, chatSessionId, now: now(), signal: execution.signal, deadline: execution.deadline })), execution, now)
        throwIfExecutionUnavailable(execution, now)
        if (!existingSession) throw new ContentError(404, 'not_found', 'Chat session not found')
        if (existingSession.scope !== undefined) {
          const persistedScope = scopeValue(existingSession.scope)
          if (canonicalRequestHash({ scope: scopeHashValue(persistedScope) }) !== canonicalRequestHash({ scope: scopeHashValue(safeScope) })) throw new ContentError(409, 'conflict', 'Answer scope conflicts with the selected chat session')
        }
      }
      const idempotencyKeyHash = sha256(String(idempotencyKey))
      const requestHash = canonicalRequestHash({ question: admittedQuestion?.question ?? question, scope: scopeHashValue(safeScope), chatSessionId: chatSessionId ?? null })
      attempt = await reserveAttemptWithCancellationCleanup({ actor, idempotencyKeyHash, requestHash, chatSessionId, execution })
      throwIfExecutionUnavailable(execution, now)
      if (attempt?.status === 'mismatch') throw new ContentError(409, 'idempotency_mismatch', 'Answer request conflicts with current idempotency intent')
      if (['completed', 'refused', 'failed'].includes(attempt.status)) {
        const persistedClarification = clarificationFromAttempt(attempt)
        if (persistedClarification) throw clarificationError(persistedClarification)
        if (attempt.resultStatus && attempt.chatSessionId && typeof chatRepository.getAnswerResult === 'function') {
          const replay = await awaitExecution(() => qaRepositoryCall('getAnswerResult', () => chatRepository.getAnswerResult({ actor, chatSessionId: attempt.chatSessionId, messageId: attempt.messageId, now: now(), signal: execution.signal, deadline: execution.deadline })), execution, now)
          throwIfExecutionUnavailable(execution, now)
          if (replay) return { answer: replay }
        }
        if (attempt.status === 'failed') throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
        if (attempt.status === 'completed' || attempt.status === 'refused') throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
      }
      if (attempt.reused && ['reserved', 'provider-running'].includes(attempt.status)) throw new ContentError(503, 'service_unavailable', 'Answer is already being processed')
      if (attempt.status === 'provider-running' && attempt.providerReservationExpiresAt && new Date(attempt.providerReservationExpiresAt) <= now()) {
        throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
      }
      if (privacyError) return { answer: await privacyRefusal({ actor, attempt, scope: refusalScope, chatSessionId, execution }) }
      let providerInput
      let executionScope = safeScope
      let retrievalOrdering = ['relevance']
      let localControlFailure
      try {
        if (!await actorFenceRead(actor, execution)) {
          await attemptUpdate(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
          throw new ContentError(401, 'unauthorized', 'Authentication is required')
        }
        throwIfExecutionUnavailable(execution, now)
        const plannerInput = {
          version: 'qa-planner-input-v1',
          question: admittedQuestion.question,
          explicitScope: safeScope,
          referenceInstant: referenceInstant.toISOString(),
          timeZone: qaTimeZone,
        }
        let proposal
        let executionPlan
        try {
          throwIfExecutionUnavailable(execution, now)
          // The bootstrap marks planner wrappers that can dispatch an optional provider call.
          if (intentPlanner !== planQaIntent && !await actorFenceRead(actor, execution)) throw new ContentError(401, 'unauthorized', 'Authentication is required')
          throwIfExecutionUnavailable(execution, now)
          proposal = await awaitExecution(() => intentPlanner(plannerInput, { attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), signal: execution.signal, deadline: execution.deadline }), execution, now)
          throwIfExecutionUnavailable(execution, now)
          assertQaIntentProposal(proposal)
          executionPlan = await awaitExecution(() => intentCompiler({ proposal, explicitScope: safeScope, question: admittedQuestion.question, referenceInstant: referenceInstant.toISOString(), timeZone: qaTimeZone, signal: execution.signal, deadline: execution.deadline }), execution, now)
          throwIfExecutionUnavailable(execution, now)
        } catch (error) {
          if (error instanceof ContentError) throw error
          const safeError = { code: 'provider_unavailable', message: 'Q&A intent planning is temporarily unavailable', retryable: true, occurredAt: referenceInstant }
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await attemptUpdate(attempt._id, { status: 'failed', error: safeError }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
          throw new ContentError(503, 'service_unavailable', 'Q&A intent planning is temporarily unavailable')
        }
        if (!executionPlan || !['execute', 'clarify'].includes(executionPlan.decision)) throw new ContentError(503, 'service_unavailable', 'Q&A intent planning is temporarily unavailable')
        if (executionPlan.decision === 'clarify') {
          const detail = safeClarificationDetail(executionPlan.provenance?.clarification ?? executionPlan.clarification)
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await attemptUpdate(attempt._id, { status: 'failed', error: { code: detail.code, message: detail.message, retryable: false, occurredAt: referenceInstant } }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
          throw clarificationError(detail)
        }
        throwIfExecutionUnavailable(execution, now)
        retrievalOrdering = Array.isArray(executionPlan.ordering) && executionPlan.ordering.includes('freshness') ? ['relevance', 'freshness'] : ['relevance']
        executionScope = scopeValue(executionPlan.effectiveScope)
        providerInput = await prepareProviderInput({ question, admittedQuestion, scope: executionScope, ordering: retrievalOrdering, queryVariants: executionPlan.queryVariants, execution })
        throwIfExecutionUnavailable(execution, now)
        let primaryGenerationRoute
        function routeMetadata(route) {
          if (!route || typeof route !== 'object' || !route.routeId || !route.providerFailureDomainId) return {}
          if (!primaryGenerationRoute) {
            primaryGenerationRoute = { routeId: route.routeId, providerFailureDomainId: route.providerFailureDomainId, model: route.model }
            return { providerRouteId: route.routeId, providerFailureDomainId: route.providerFailureDomainId, fallbackKind: 'none' }
          }
          const fallbackKind = route.providerFailureDomainId === primaryGenerationRoute.providerFailureDomainId
            ? route.model !== primaryGenerationRoute.model ? 'model' : attempt.fallbackKind ?? 'none'
            : 'provider'
          return { providerRouteId: route.routeId, providerFailureDomainId: route.providerFailureDomainId, fallbackKind }
        }
        const renewProviderStage = async (route, { recordRoute = true } = {}) => {
          throwIfExecutionUnavailable(execution, now)
          if (!await actorFenceRead(actor, execution)) throw new ContentError(401, 'unauthorized', 'Authentication is required')
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
            const metadata = recordRoute ? routeMetadata(route) : {}
            attempt = await attemptUpdate(attempt._id, { status: 'provider-running', providerReservationExpiresAt: new Date(now().getTime() + 60_000), ...metadata }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
          }
          throwIfExecutionUnavailable(execution, now)
        }
        const invokeAnswer = async (invocation) => {
          const route = routeFromInvocation(invocation)
          const admittedInput = inputFromInvocation(invocation, providerInput.routerInput)
          try {
            await renewProviderStage(route)
            await assertCurrentEvidenceFence({ providerInput, scope: executionScope, ordering: retrievalOrdering, execution })
          } catch (error) {
            if (isLocalControlFailure(error)) {
              localControlFailure = error
              throw new ProviderAdapterError('policy', { localControl: true })
            }
            throw error
          }
          throwIfExecutionUnavailable(execution, now)
          if (!adapters.llmProvider?.answer) throw new ProviderAdapterError('config')
          return adapters.llmProvider.answer({ route, input: admittedInput.prompt.prompt, locale: 'vi', tools: [], signal: execution.signal, deadline: execution.deadline })
        }
        const validateGenerationOutput = ({ output: candidate }) => {
          if (candidate?.status === 'refused') return candidate
          const parsedCandidate = candidate?.status === 'answered' ? candidate : { ...candidate, status: 'answered' }
          if (parsedCandidate.status !== 'answered' || !Array.isArray(parsedCandidate.paragraphs)) throw new ProviderAdapterError('schema')
          try {
            return { ...parsedCandidate, paragraphs: validateParagraphCitations({ paragraphs: parsedCandidate.paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: providerInput.prompt.blocks }) }
          } catch { throw new ProviderAdapterError('schema') }
        }
        let output
        const generation = await awaitExecution(() => providerRouter.execute({ workloadId: 'qa-generation', admittedInput: providerInput.routerInput, attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), signal: execution.signal, deadline: execution.deadline, invoke: invokeAnswer, validateOutput: validateGenerationOutput }), execution, now)
        throwIfExecutionUnavailable(execution, now)
        output = generation?.output
        const metadata = providerMetadataUpdate(generation?.metadata)
        if (metadata && typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
          attempt = await attemptUpdate(attempt._id, metadata, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
          throwIfExecutionUnavailable(execution, now)
        }
        if (output?.status === 'refused') return { answer: await refusal({ actor, attempt, reason: ['insufficient-evidence', 'policy-blocked', 'sensitive-input', 'provider-unavailable'].includes(output.refusalReason) ? output.refusalReason : 'insufficient-evidence', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence, execution }) }
        const parsed = output
        const paragraphs = parsed.paragraphs
        {
          throwIfExecutionUnavailable(execution, now)
          if (!await actorFenceRead(actor, execution)) {
            await attemptUpdate(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatuses: ['reserved', 'provider-running'] }, execution)
            throw new ContentError(401, 'unauthorized', 'Authentication is required')
          }
          throwIfExecutionUnavailable(execution, now)
          const supportBlocks = citedEvidenceBlocks({ paragraphs, blocks: providerInput.prompt.blocks })
          const supportInput = boundedSupportInput({ question: providerInput.admitted.question, paragraphs, blocks: providerInput.prompt.blocks })
          const invokeSupport = async (invocation) => {
            const route = routeFromInvocation(invocation)
            const admittedInput = inputFromInvocation(invocation, supportInput)
            try {
              await renewProviderStage(route, { recordRoute: false })
              await assertCurrentEvidenceFence({ providerInput, scope: executionScope, ordering: retrievalOrdering, execution })
            } catch (error) {
              if (isLocalControlFailure(error)) {
                localControlFailure = error
                throw new ProviderAdapterError('policy', { localControl: true })
              }
              throw error
            }
            throwIfExecutionUnavailable(execution, now)
            return (adapters.llmProvider?.verifySupport
              ? adapters.llmProvider.verifySupport({ route, input: JSON.stringify(admittedInput), locale: 'vi', tools: [], signal: execution.signal, deadline: execution.deadline })
              : verifySupport({ route, question: admittedInput.question, addressesQuestion: admittedInput.addressesQuestion, paragraphs: admittedInput.paragraphs, evidenceBlocks: admittedInput.evidenceBlocks, evidenceMap: admittedInput.evidenceMap, signal: execution.signal, deadline: execution.deadline }))
          }
          const validateSupportOutput = ({ output: candidate }) => {
            if (!candidate || typeof candidate !== 'object' || !['supported', 'unsupported', 'uncertain'].includes(candidate.verdict) || typeof candidate.addressesQuestion !== 'boolean' || !Array.isArray(candidate.evidenceBlockIds)) throw new ProviderAdapterError('support')
            return candidate
          }
          const support = await awaitExecution(() => providerRouter.execute({ workloadId: 'qa-support', admittedInput: supportInput, attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), signal: execution.signal, deadline: execution.deadline, invoke: invokeSupport, validateOutput: validateSupportOutput }), execution, now)
          throwIfExecutionUnavailable(execution, now)
          const verdict = support?.output
          const verdictValue = verdict?.verdict ?? verdict
          if (verdict?.addressesQuestion !== true || ['unsupported', 'uncertain'].includes(verdictValue)) {
            const supportError = new Error('Answer support verdict is insufficient')
            supportError.code = verdict?.addressesQuestion === true ? verdictValue : 'uncertain'
            throw supportError
          }
          assertSupportedAnswer({ verdict: verdictValue, verdictEvidenceBlockIds: verdict?.evidenceBlockIds, paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: supportBlocks })
          throwIfExecutionUnavailable(execution, now)
        }
        throwIfExecutionUnavailable(execution, now)
        const hydrated = hydrateAnswerCitations({ citationIds: [...new Set(paragraphs.flatMap(({ citationIds }) => citationIds))], evidence: providerInput.evidence })
        throwIfExecutionUnavailable(execution, now)
        const answer = { id: parsed.id ?? `answer-${attempt._id?.toHexString?.()}`, status: 'answered', paragraphs: paragraphs.map(({ text, citationIds }) => ({ text, citationIds })), citations: hydrated, refusalReason: null, chatSessionId: chatSessionId ?? undefined, createdAt: now().toISOString() }
        const chat = await awaitExecution(() => qaRepositoryCall('appendAnswer', () => chatRepository.appendAnswer({ actor, chatSessionId, scope: safeScope, question: providerInput.admitted.question, answer, citations: hydrated, attempt: { id: attempt._id, outcome: 'completed' }, expectedEvidenceFence: providerInput.fence, now: now(), signal: execution.signal, deadline: execution.deadline })), execution, now)
        throwIfExecutionUnavailable(execution, now)
        if (!chat?.attemptCommitted) await attemptUpdate(attempt._id, { status: 'completed', resultStatus: 'answered', chatSessionId: chat.chatSessionId, messageId: chat.messageId }, { expectedStatus: 'provider-running' }, execution)
        return { answer: { ...answer, chatSessionId: chat.chatSessionId } }
      } catch (error) {
        if (isExecutionUnavailable(error, execution, now)) throw new ContentError(503, 'service_unavailable', 'Q&A service is temporarily unavailable')
        if (localControlFailure) {
          const controlFailure = localControlFailure
          if (controlFailure instanceof EvidenceSelectionError && controlFailure.discard) throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
          throw controlFailure
        }
        if (error?.name === 'ProviderRoutingError') {
          if (error.failureClass === 'ambiguous') return await markAmbiguousAttempt(attempt, execution)
          if (error.failureClass === 'policy') return { answer: await refusal({ actor, attempt, reason: 'policy-blocked', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence, execution }) }
          if (error.failureClass === 'sensitive-input') return { answer: await privacyRefusal({ actor, attempt, scope: safeScope, chatSessionId, execution }) }
          return { answer: await refusal({ actor, attempt, reason: 'provider-unavailable', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence, execution }) }
        }
        if (error instanceof PrivacyAdmissionError) return { answer: await refusal({ actor, attempt, reason: error.code === 'sensitive-input' ? 'sensitive-input' : 'provider-unavailable', scope: safeScope, question, execution }) }
        if (error instanceof EvidenceSelectionError) {
          if (error.discard) {
            if (error.code === 'insufficient-evidence') throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
            throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
          }
          return { answer: await refusal({ actor, attempt, reason: error.code === 'policy-blocked' ? 'policy-blocked' : 'insufficient-evidence', scope: safeScope, question, execution }) }
        }
        if (['unsupported', 'uncertain'].includes(error?.code)) return { answer: await refusal({ actor, attempt, reason: deterministicRefusal(error.code), scope: safeScope, question, expectedEvidenceFence: providerInput?.fence, execution }) }
        if (error?.code === 'idempotency_mismatch') throw new ContentError(409, 'idempotency_mismatch', 'Answer request conflicts with current idempotency intent')
        if (error?.code === 'conflict' || error?.status === 409) throw new ContentError(409, 'conflict', 'Answer request conflicts with current state')
        if (error?.retryable || error?.code === 'provider_unavailable' || error?.name === 'ProviderAdapterError' || error?.name === 'ProviderBoundaryError' || ['provider_response_invalid', 'provider_http_error', 'provider_network_error', 'provider_credential_unavailable', 'provider_route_invalid'].includes(error?.code)) return { answer: await refusal({ actor, attempt, reason: 'provider-unavailable', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence, execution }) }
        throw error
      }
    } catch (error) {
      if (isExecutionUnavailable(error, execution, now)) {
        await markCancelledAttempt(answerAttemptRepository, attempt, now)
        throw new ContentError(503, 'service_unavailable', 'Q&A service is temporarily unavailable')
      }
      throw error
    } finally {
      execution.cleanup()
    }
  }

  async function listChatSessions({ auth, query } = {}) {
    const actor = contentActorFence(auth)
    return qaRepositoryCall('listChatSessions', () => chatRepository.listChatSessions({ actor, cursor: query?.cursor, limit: query?.limit === undefined ? 20 : Number(query.limit), now: now() }))
  }
  async function getChatSession({ auth, chatSessionId } = {}) {
    const actor = contentActorFence(auth)
    const session = await qaRepositoryCall('getChatSession', () => chatRepository.getChatSession({ actor, chatSessionId, now: now() }))
    if (!session) throw new ContentError(404, 'not_found', 'Chat session not found')
    return { session }
  }
  async function deleteChatSession({ auth, chatSessionId } = {}) {
    const actor = contentActorFence(auth)
    await qaRepositoryCall('deleteChatSession', () => chatRepository.deleteChatSession({ actor, chatSessionId }))
  }
  async function clearChatSessions({ auth } = {}) {
    const actor = contentActorFence(auth)
    await qaRepositoryCall('clearChatSessions', () => chatRepository.clearChatSessions({ actor }))
  }
  return Object.freeze({ createAnswer, listChatSessions, getChatSession, deleteChatSession, clearChatSessions })
}

export { scopeValue }
