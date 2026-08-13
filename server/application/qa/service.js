import { createHash, randomUUID } from 'node:crypto'
import { canonicalRequestHash } from '../../domain/jobs/idempotency.js'
import { ContentError, contentActorFence } from '../articles/query.js'
import { admitQuestion, PrivacyAdmissionError } from '../../domain/qa/privacy.js'
import { buildGroundedPrompt, evidenceAdmissionFence, filterQnaEvidence, EvidenceSelectionError } from '../../domain/qa/evidence.js'
import { hydrateAnswerCitations, validateParagraphCitations } from '../../domain/qa/citations.js'
import { assertSupportedAnswer, deterministicRefusal } from '../../domain/qa/support.js'

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/

function sha256(value) { return createHash('sha256').update(value).digest('hex') }

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

export function createQaService({ articleRepository, chatRepository, answerAttemptRepository = chatRepository, providerAdmission, providerAdapters = {}, rateLimitAdmission, queryEmbedding, routes = {}, supportVerifier, now = () => new Date() } = {}) {
  if (!chatRepository || typeof chatRepository.reserveAnswerAttempt !== 'function') throw new Error('Chat repository is required')
  const articleRepo = articleRepository ?? { findQnaEvidence: async () => [] }
  const adapters = providerAdapters
  const primaryRoute = routes.primary ?? routes.answerPrimary ?? routes.summary
  const fallbackRoute = routes.fallback ?? routes.answerFallback
  const supportRoute = routes.support ?? routes.answerSupport
  const verifySupport = supportVerifier ?? (async () => ({ verdict: 'uncertain' }))

  async function prepareProviderInput({ question, scope, expectedFence }) {
    const admitted = admitQuestion(question, { capability: 'zdr-verified' })
    let embedding
    if (typeof queryEmbedding === 'function') {
      try { embedding = await queryEmbedding(admitted.question) } catch { embedding = undefined }
      if (embedding && (embedding.model !== 'baai/bge-m3' || embedding.dimensions !== 1024 || embedding.version !== 1 || !Array.isArray(embedding.embedding) || embedding.embedding.length !== 1024)) embedding = undefined
    }
    const records = await articleRepo.findQnaEvidence({ question: admitted.question, queryEmbedding: embedding, scope, limit: 50, includeSource: true })
    let evidence
    try {
      evidence = filterQnaEvidence(records)
    } catch (error) {
      if (expectedFence && error instanceof EvidenceSelectionError) { error.discard = true; throw error }
      throw error
    }
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
    return Object.freeze({ admitted, evidence, fence: Object.freeze(fence), prompt: buildGroundedPrompt({ question: admitted.question, evidence }) })
  }

  async function refusal({ actor, attempt, reason, scope, question, expectedEvidenceFence }) {
    const createdAt = now().toISOString()
    const chat = typeof chatRepository.appendAnswer === 'function'
      ? await chatRepository.appendAnswer({ actor, chatSessionId: attempt.chatSessionId, scope, question, answer: answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: attempt.chatSessionId, reason, createdAt }), attempt: { id: attempt._id, outcome: 'refused' }, expectedEvidenceFence, now: now() })
      : null
    if (!chat?.attemptCommitted && typeof chatRepository.updateAnswerAttempt === 'function') await chatRepository.updateAnswerAttempt(attempt._id, { status: 'refused', resultStatus: 'refused', chatSessionId: chat?.chatSessionId, messageId: chat?.messageId }, { expectedStatuses: ['reserved', 'provider-running'] })
    return chat?.answer ?? answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: chat?.chatSessionId ?? attempt.chatSessionId, reason, createdAt })
  }

  async function privacyRefusal({ actor, attempt, scope, chatSessionId }) {
    if (typeof chatRepository.appendRefusalWithoutQuestion !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
    const createdAt = now().toISOString()
    const answer = answerRefusal({ id: `answer-${randomUUID()}`, chatSessionId, reason: 'sensitive-input', createdAt })
    const chat = await chatRepository.appendRefusalWithoutQuestion({ actor, chatSessionId, scope, answer, attempt: { id: attempt._id, outcome: 'refused' }, now: now() })
    return chat?.answer ?? { ...answer, chatSessionId: chat?.chatSessionId ?? chatSessionId }
  }

  async function createAnswer({ auth, question, scope, chatSessionId, idempotencyKey } = {}) {
    let actor
    try { actor = contentActorFence(auth) } catch { throw new ContentError(401, 'unauthorized', 'Authentication is required') }
    if (!KEY_PATTERN.test(String(idempotencyKey ?? ''))) throw new ContentError(400, 'bad_request', 'Idempotency-Key is invalid')
    const safeScope = scopeValue(scope)
    if (typeof question !== 'string' || question.length < 3 || question.length > 1000) throw new ContentError(422, 'validation_error', 'Question is invalid')
    let privacyError
    try { admitQuestion(question, { capability: 'zdr-verified' }) } catch (error) {
      if (error instanceof PrivacyAdmissionError && error.code === 'sensitive-input') privacyError = error
      else throw error
    }
    if (chatSessionId) {
      if (typeof chatRepository.getChatSession !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
      const existingSession = await chatRepository.getChatSession({ actor, chatSessionId, now: now() })
      if (!existingSession) throw new ContentError(404, 'not_found', 'Chat session not found')
      if (existingSession.scope !== undefined) {
        const persistedScope = scopeValue(existingSession.scope)
        if (canonicalRequestHash({ scope: scopeHashValue(persistedScope) }) !== canonicalRequestHash({ scope: scopeHashValue(safeScope) })) throw new ContentError(409, 'conflict', 'Answer scope conflicts with the selected chat session')
      }
    }
    const idempotencyKeyHash = sha256(String(idempotencyKey))
    const requestHash = canonicalRequestHash({ question, scope: scopeHashValue(safeScope), chatSessionId: chatSessionId ?? null })
    let attempt = await answerAttemptRepository.reserveAnswerAttempt({ actor, idempotencyKeyHash, requestHash, chatSessionId, quotaReservationKey: `answer:${actor.userId}`, rateLimitAdmission, quotaScopes: ['answer-minute', 'answer-daily'], now: now() })
    if (attempt?.status === 'mismatch') throw new ContentError(409, 'idempotency_mismatch', 'Answer request conflicts with current idempotency intent')
    if (['completed', 'refused', 'failed'].includes(attempt.status)) {
      if (attempt.resultStatus && attempt.chatSessionId && typeof chatRepository.getAnswerResult === 'function') {
        const replay = await chatRepository.getAnswerResult({ actor, chatSessionId: attempt.chatSessionId, messageId: attempt.messageId, now: now() })
        if (replay) return { answer: replay }
      }
      if (attempt.status === 'failed') throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
      if (attempt.status === 'completed' || attempt.status === 'refused') throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
    }
    if (attempt.reused && ['reserved', 'provider-running'].includes(attempt.status)) throw new ContentError(503, 'service_unavailable', 'Answer is already being processed')
    if (attempt.status === 'provider-running' && attempt.providerReservationExpiresAt && new Date(attempt.providerReservationExpiresAt) <= now()) {
      throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
    }
    if (privacyError) return { answer: await privacyRefusal({ actor, attempt, scope: safeScope, chatSessionId }) }
    let providerInput
    try {
      if (typeof chatRepository.assertActorFence === 'function' && !await chatRepository.assertActorFence(actor)) {
        if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatus: 'provider-running' })
        throw new ContentError(401, 'unauthorized', 'Authentication is required')
      }
      providerInput = await prepareProviderInput({ question, scope: safeScope })
      const renewProviderStage = async () => {
        if (typeof chatRepository.assertActorFence === 'function' && !await chatRepository.assertActorFence(actor)) throw new ContentError(401, 'unauthorized', 'Authentication is required')
        if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
          attempt = await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'provider-running', providerReservationExpiresAt: new Date(now().getTime() + 60_000) }, { expectedStatuses: ['reserved', 'provider-running'] })
        }
      }
      const invokeAnswer = async (route) => {
        await renewProviderStage()
        providerInput = await prepareProviderInput({ question, scope: safeScope, expectedFence: providerInput.fence })
        if (!adapters.llmProvider?.answer) throw Object.assign(new Error('Provider unavailable'), { code: 'provider_unavailable', retryable: true })
        return adapters.llmProvider.answer({ route, input: providerInput.prompt.prompt, locale: 'vi', tools: [] })
      }
      let output
      try {
        output = providerAdmission ? await providerAdmission.run({ routeId: primaryRoute, capability: 'zdr-verified', attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), kind: 'answer-primary', invoke: invokeAnswer }) : await invokeAnswer(primaryRoute)
      } catch (error) {
        if (!error?.retryable || !fallbackRoute) throw error
        if (typeof chatRepository.assertActorFence === 'function' && !await chatRepository.assertActorFence(actor)) {
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatus: 'provider-running' })
          throw new ContentError(401, 'unauthorized', 'Authentication is required')
        }
        output = providerAdmission ? await providerAdmission.run({ routeId: fallbackRoute, capability: 'zdr-verified', attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), kind: 'answer-fallback', invoke: invokeAnswer }) : await invokeAnswer(fallbackRoute)
      }
      if (output?.status === 'refused') return { answer: await refusal({ actor, attempt, reason: ['insufficient-evidence', 'policy-blocked', 'sensitive-input', 'provider-unavailable'].includes(output.refusalReason) ? output.refusalReason : 'insufficient-evidence', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
      const parsed = output?.status === 'answered' ? output : { ...output, status: 'answered' }
      if (parsed.status !== 'answered' || !Array.isArray(parsed.paragraphs)) {
        const shapeError = new Error('Provider answer shape is invalid')
        shapeError.code = 'provider_response_invalid'
        throw shapeError
      }
      let paragraphs
      try {
        paragraphs = validateParagraphCitations({ paragraphs: parsed.paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: providerInput.prompt.blocks })
      } catch {
        const shapeError = new Error('Provider answer evidence references are invalid')
        shapeError.code = 'provider_response_invalid'
        throw shapeError
      }
      {
        if (typeof chatRepository.assertActorFence === 'function' && !await chatRepository.assertActorFence(actor)) {
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatus: 'provider-running' })
          throw new ContentError(401, 'unauthorized', 'Authentication is required')
        }
        const invokeSupport = async (route) => {
          await renewProviderStage()
          providerInput = await prepareProviderInput({ question, scope: safeScope, expectedFence: providerInput.fence })
          paragraphs = validateParagraphCitations({ paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: providerInput.prompt.blocks })
          return verifySupport({ route, question: providerInput.admitted.question, addressesQuestion: true, paragraphs, evidenceBlocks: providerInput.prompt.blocks, evidenceMap: providerInput.prompt.evidenceMap })
        }
        const verdict = providerAdmission && supportRoute
          ? await providerAdmission.run({ routeId: supportRoute, capability: 'zdr-verified', attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), kind: 'answer-support', invoke: invokeSupport })
          : await invokeSupport(supportRoute)
        const verdictValue = verdict?.verdict ?? verdict
        if (verdict?.addressesQuestion !== true || ['unsupported', 'uncertain'].includes(verdictValue)) {
          const supportError = new Error('Answer support verdict is insufficient')
          supportError.code = verdict?.addressesQuestion === true ? verdictValue : 'uncertain'
          throw supportError
        }
        assertSupportedAnswer({ verdict: verdictValue, verdictEvidenceBlockIds: verdict?.evidenceBlockIds, paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: providerInput.prompt.blocks })
      }
      const hydrated = hydrateAnswerCitations({ citationIds: [...new Set(paragraphs.flatMap(({ citationIds }) => citationIds))], evidence: providerInput.evidence })
      const answer = { id: parsed.id ?? `answer-${attempt._id?.toHexString?.()}`, status: 'answered', paragraphs: paragraphs.map(({ text, citationIds }) => ({ text, citationIds })), citations: hydrated, refusalReason: null, chatSessionId: chatSessionId ?? undefined, createdAt: now().toISOString() }
      const chat = await chatRepository.appendAnswer({ actor, chatSessionId, scope: safeScope, question: providerInput.admitted.question, answer, citations: hydrated, attempt: { id: attempt._id, outcome: 'completed' }, expectedEvidenceFence: providerInput.fence, now: now() })
      if (!chat?.attemptCommitted && typeof answerAttemptRepository.updateAnswerAttempt === 'function') await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'completed', resultStatus: 'answered', chatSessionId: chat.chatSessionId, messageId: chat.messageId }, { expectedStatus: 'provider-running' })
      return { answer: { ...answer, chatSessionId: chat.chatSessionId } }
    } catch (error) {
      if (error instanceof PrivacyAdmissionError) return { answer: await refusal({ actor, attempt, reason: error.code === 'sensitive-input' ? 'sensitive-input' : 'provider-unavailable', scope: safeScope, question }) }
      if (error instanceof EvidenceSelectionError) {
        if (error.discard) {
          if (error.code === 'insufficient-evidence') throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
          throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
        }
        return { answer: await refusal({ actor, attempt, reason: error.code === 'policy-blocked' ? 'policy-blocked' : 'insufficient-evidence', scope: safeScope, question }) }
      }
      if (['unsupported', 'uncertain'].includes(error?.code)) return { answer: await refusal({ actor, attempt, reason: deterministicRefusal(error.code), scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
      if (error?.code === 'idempotency_mismatch') throw new ContentError(409, 'idempotency_mismatch', 'Answer request conflicts with current idempotency intent')
      if (error?.code === 'conflict' || error?.status === 409) throw new ContentError(409, 'conflict', 'Answer request conflicts with current state')
      if (error?.retryable || error?.code === 'provider_unavailable' || error?.name === 'ProviderAdapterError' || error?.name === 'ProviderBoundaryError' || ['provider_response_invalid', 'provider_http_error', 'provider_network_error', 'provider_credential_unavailable', 'provider_route_invalid'].includes(error?.code)) return { answer: await refusal({ actor, attempt, reason: 'provider-unavailable', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
      throw error
    }
  }

  async function listChatSessions({ auth, query } = {}) {
    const actor = contentActorFence(auth)
    return chatRepository.listChatSessions({ actor, cursor: query?.cursor, limit: query?.limit === undefined ? 20 : Number(query.limit), now: now() })
  }
  async function getChatSession({ auth, chatSessionId } = {}) {
    const actor = contentActorFence(auth)
    const session = await chatRepository.getChatSession({ actor, chatSessionId, now: now() })
    if (!session) throw new ContentError(404, 'not_found', 'Chat session not found')
    return { session }
  }
  async function deleteChatSession({ auth, chatSessionId } = {}) {
    const actor = contentActorFence(auth)
    await chatRepository.deleteChatSession({ actor, chatSessionId })
  }
  async function clearChatSessions({ auth } = {}) {
    const actor = contentActorFence(auth)
    await chatRepository.clearChatSessions({ actor })
  }
  return Object.freeze({ createAnswer, listChatSessions, getChatSession, deleteChatSession, clearChatSessions })
}

export { scopeValue }
