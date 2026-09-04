import { createHash, randomUUID } from 'node:crypto'
import { canonicalRequestHash } from '../../domain/jobs/idempotency.js'
import { ContentError, contentActorFence } from '../articles/query.js'
import { admitQuestion, PrivacyAdmissionError } from '../../domain/qa/privacy.js'
import { buildGroundedPrompt, evidenceAdmissionFence, filterQnaEvidence, EvidenceSelectionError } from '../../domain/qa/evidence.js'
import { resolveQaTemporalScope } from '../../../shared/qa-temporal.js'
import { hydrateAnswerCitations, validateParagraphCitations } from '../../domain/qa/citations.js'
import { assertSupportedAnswer, deterministicRefusal } from '../../domain/qa/support.js'
import { ProviderAdapterError } from '../../ai/provider-error-taxonomy.js'

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/
const MAX_SUPPORT_SERIALIZED_CHARS = 30_000
const MAX_SUPPORT_PARAGRAPH_CHARS = 10_000

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

export function createQaService({ articleRepository, chatRepository, answerAttemptRepository = chatRepository, providerRouter, providerAdapters = {}, rateLimitAdmission, queryEmbedding, privacyCapability = 'zdr-verified', supportVerifier, now = () => new Date() } = {}) {
  if (!chatRepository || typeof chatRepository.reserveAnswerAttempt !== 'function') throw new Error('Chat repository is required')
  if (!providerRouter || typeof providerRouter.execute !== 'function') throw new Error('Provider router is required')
  const articleRepo = articleRepository ?? { findQnaEvidence: async () => [] }
  const adapters = providerAdapters
  const verifySupport = supportVerifier ?? (async () => ({ verdict: 'uncertain' }))

  async function prepareProviderInput({ question, admittedQuestion, scope, expectedFence }) {
    const admitted = admittedQuestion ?? admitQuestion(question, { capability: privacyCapability })
    let embedding
    if (typeof queryEmbedding === 'function') {
      try { embedding = await queryEmbedding(admitted.question) } catch { embedding = undefined }
      if (embedding && (typeof embedding.model !== 'string' || !embedding.model || !Number.isInteger(embedding.dimensions) || embedding.dimensions < 1 || !Number.isInteger(embedding.version) || embedding.version < 1 || typeof embedding.artifactCompatibilityId !== 'string' || !embedding.artifactCompatibilityId || !Array.isArray(embedding.embedding) || embedding.embedding.length !== embedding.dimensions || embedding.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)))) embedding = undefined
    }
    const records = await qaRepositoryCall('findQnaEvidence', () => articleRepo.findQnaEvidence({ question: admitted.question, queryEmbedding: embedding, scope, limit: 50, includeSource: true }))
    let evidence
    try {
      evidence = filterQnaEvidence(records)
    } catch (error) {
      if (expectedFence && error instanceof EvidenceSelectionError) { error.discard = true; throw error }
      throw error
    }
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
    const routerPrompt = Object.freeze({
      prompt: prompt.prompt,
      citations: Object.freeze(prompt.citations.map(({ id, articleId, sourceId }) => Object.freeze({ id, articleId, sourceId }))),
      blocks: Object.freeze(prompt.blocks.map(({ id, citationId, text }) => Object.freeze({ id, citationId, text }))),
      evidenceMap: Object.freeze({ ...prompt.evidenceMap }),
    })
    const selectedArticleIds = Object.freeze(evidence.map(({ article }) => article?.id ?? (article?._id?.toHexString ? article._id.toHexString() : String(article?._id ?? ''))).filter(Boolean))
    return Object.freeze({
      admitted,
      evidence,
      fence: Object.freeze(fence),
      prompt,
      selectedArticleIds,
      routerInput: freezeDeep({ question: admitted.question, prompt: routerPrompt }),
      embedding,
    })
  }

  async function assertCurrentEvidenceFence({ providerInput, scope }) {
    const selectedArticleIds = providerInput.selectedArticleIds ?? providerInput.evidence.map(({ article }) => article?.id ?? (article?._id?.toHexString ? article._id.toHexString() : String(article?._id ?? ''))).filter(Boolean)
    const recheckScope = { ...scope, articleIds: [...selectedArticleIds] }
    const records = await qaRepositoryCall('recheckEvidence', () => articleRepo.findQnaEvidence({ question: providerInput.admitted.question, queryEmbedding: providerInput.embedding, scope: recheckScope, limit: 50, includeSource: true }))
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
    return currentFence
  }

  async function refusal({ actor, attempt, reason, scope, question, expectedEvidenceFence }) {
    const createdAt = now().toISOString()
    let chat = null
    if (typeof chatRepository.appendAnswer === 'function') {
      chat = await qaRepositoryCall('appendAnswer', () => chatRepository.appendAnswer({ actor, chatSessionId: attempt.chatSessionId, scope, question, answer: answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: attempt.chatSessionId, reason, createdAt }), attempt: { id: attempt._id, outcome: 'refused' }, expectedEvidenceFence, now: now() }))
    }
    if (!chat?.attemptCommitted && typeof chatRepository.updateAnswerAttempt === 'function') await qaRepositoryCall('updateAnswerAttempt', () => chatRepository.updateAnswerAttempt(attempt._id, { status: 'refused', resultStatus: 'refused', chatSessionId: chat?.chatSessionId, messageId: chat?.messageId }, { expectedStatuses: ['reserved', 'provider-running'] }))
    return chat?.answer ?? answerRefusal({ id: `answer-${attempt._id?.toHexString?.() ?? 'refused'}`, chatSessionId: chat?.chatSessionId ?? attempt.chatSessionId, reason, createdAt })
  }

  async function privacyRefusal({ actor, attempt, scope, chatSessionId }) {
    if (typeof chatRepository.appendRefusalWithoutQuestion !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
    const createdAt = now().toISOString()
    const answer = answerRefusal({ id: `answer-${randomUUID()}`, chatSessionId, reason: 'sensitive-input', createdAt })
    const chat = await qaRepositoryCall('appendRefusalWithoutQuestion', () => chatRepository.appendRefusalWithoutQuestion({ actor, chatSessionId, scope, answer, attempt: { id: attempt._id, outcome: 'refused' }, now: now() }))
    return chat?.answer ?? { ...answer, chatSessionId: chat?.chatSessionId ?? chatSessionId }
  }

  function routeFromInvocation(invocation) {
    return invocation && typeof invocation === 'object' && Object.hasOwn(invocation, 'route') ? invocation.route : invocation
  }

  function inputFromInvocation(invocation, fallback) {
    return invocation && typeof invocation === 'object' && Object.hasOwn(invocation, 'admittedInput') ? invocation.admittedInput : fallback
  }

  async function markAmbiguousAttempt(attempt) {
    const error = { code: 'ambiguous_provider_outcome', message: 'Provider outcome is unavailable', retryable: false, occurredAt: now() }
    if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
      try { await answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error }, { expectedStatuses: ['reserved', 'provider-running'] }) } catch { /* an earlier CAS may have completed the terminal transition */ }
    }
    throw new ContentError(503, 'service_unavailable', 'Answer outcome is unavailable')
  }

  async function createAnswer({ auth, question, scope, chatSessionId, idempotencyKey } = {}) {
    let actor
    try { actor = contentActorFence(auth) } catch { throw new ContentError(401, 'unauthorized', 'Authentication is required') }
    if (!KEY_PATTERN.test(String(idempotencyKey ?? ''))) throw new ContentError(400, 'bad_request', 'Idempotency-Key is invalid')
    const safeScope = scopeValue(resolveQaTemporalScope({ question, scope, now: now() }))
    if (typeof question !== 'string' || question.length < 3 || question.length > 1000) throw new ContentError(422, 'validation_error', 'Question is invalid')
    let privacyError
    let admittedQuestion
    try { admittedQuestion = admitQuestion(question, { capability: privacyCapability }) } catch (error) {
      if (error instanceof PrivacyAdmissionError && error.code === 'sensitive-input') privacyError = error
      else throw error
    }
    if (chatSessionId) {
      if (typeof chatRepository.getChatSession !== 'function') throw new ContentError(503, 'service_unavailable', 'Chat session service is unavailable')
      const existingSession = await qaRepositoryCall('getChatSession', () => chatRepository.getChatSession({ actor, chatSessionId, now: now() }))
      if (!existingSession) throw new ContentError(404, 'not_found', 'Chat session not found')
      if (existingSession.scope !== undefined) {
        const persistedScope = scopeValue(existingSession.scope)
        if (canonicalRequestHash({ scope: scopeHashValue(persistedScope) }) !== canonicalRequestHash({ scope: scopeHashValue(safeScope) })) throw new ContentError(409, 'conflict', 'Answer scope conflicts with the selected chat session')
      }
    }
    const idempotencyKeyHash = sha256(String(idempotencyKey))
    const requestHash = canonicalRequestHash({ question: admittedQuestion?.question ?? question, scope: scopeHashValue(safeScope), chatSessionId: chatSessionId ?? null })
    let attempt = await qaRepositoryCall('reserveAnswerAttempt', () => answerAttemptRepository.reserveAnswerAttempt({ actor, idempotencyKeyHash, requestHash, chatSessionId, quotaReservationKey: `answer:${actor.userId}`, rateLimitAdmission, quotaScopes: ['answer-minute', 'answer-daily'], now: now() }))
    if (attempt?.status === 'mismatch') throw new ContentError(409, 'idempotency_mismatch', 'Answer request conflicts with current idempotency intent')
    if (['completed', 'refused', 'failed'].includes(attempt.status)) {
      if (attempt.resultStatus && attempt.chatSessionId && typeof chatRepository.getAnswerResult === 'function') {
        const replay = await qaRepositoryCall('getAnswerResult', () => chatRepository.getAnswerResult({ actor, chatSessionId: attempt.chatSessionId, messageId: attempt.messageId, now: now() }))
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
    let localControlFailure
    try {
      if (typeof chatRepository.assertActorFence === 'function' && !await qaRepositoryCall('assertActorFence', () => chatRepository.assertActorFence(actor))) {
        if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatus: 'provider-running' }))
        throw new ContentError(401, 'unauthorized', 'Authentication is required')
      }
      providerInput = await prepareProviderInput({ question, admittedQuestion, scope: safeScope })
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
        if (typeof chatRepository.assertActorFence === 'function' && !await qaRepositoryCall('assertActorFence', () => chatRepository.assertActorFence(actor))) throw new ContentError(401, 'unauthorized', 'Authentication is required')
        if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
          const metadata = recordRoute ? routeMetadata(route) : {}
          attempt = await qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'provider-running', providerReservationExpiresAt: new Date(now().getTime() + 60_000), ...metadata }, { expectedStatuses: ['reserved', 'provider-running'] }))
        }
      }
      const invokeAnswer = async (invocation) => {
        const route = routeFromInvocation(invocation)
        const admittedInput = inputFromInvocation(invocation, providerInput.routerInput)
        try {
          await renewProviderStage(route)
          await assertCurrentEvidenceFence({ providerInput, scope: safeScope })
        } catch (error) {
          if (isLocalControlFailure(error)) {
            localControlFailure = error
            throw new ProviderAdapterError('policy', { localControl: true })
          }
          throw error
        }
        if (!adapters.llmProvider?.answer) throw new ProviderAdapterError('config')
        return adapters.llmProvider.answer({ route, input: admittedInput.prompt.prompt, locale: 'vi', tools: [] })
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
      const generation = await providerRouter.execute({ workloadId: 'qa-generation', admittedInput: providerInput.routerInput, attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), invoke: invokeAnswer, validateOutput: validateGenerationOutput })
      output = generation?.output
      const metadata = providerMetadataUpdate(generation?.metadata)
      if (metadata && typeof answerAttemptRepository.updateAnswerAttempt === 'function') {
        attempt = await qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attempt._id, metadata, { expectedStatuses: ['reserved', 'provider-running'] }))
      }
      if (output?.status === 'refused') return { answer: await refusal({ actor, attempt, reason: ['insufficient-evidence', 'policy-blocked', 'sensitive-input', 'provider-unavailable'].includes(output.refusalReason) ? output.refusalReason : 'insufficient-evidence', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
      const parsed = output
      let paragraphs
      paragraphs = parsed.paragraphs
      {
        if (typeof chatRepository.assertActorFence === 'function' && !await qaRepositoryCall('assertActorFence', () => chatRepository.assertActorFence(actor))) {
          if (typeof answerAttemptRepository.updateAnswerAttempt === 'function') await qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'failed', error: { code: 'actor_fence_lost', message: 'Authentication is no longer active', retryable: false, occurredAt: now() } }, { expectedStatus: 'provider-running' }))
          throw new ContentError(401, 'unauthorized', 'Authentication is required')
        }
        const supportBlocks = citedEvidenceBlocks({ paragraphs, blocks: providerInput.prompt.blocks })
        const supportInput = boundedSupportInput({ question: providerInput.admitted.question, paragraphs, blocks: providerInput.prompt.blocks })
        const invokeSupport = async (invocation) => {
          const route = routeFromInvocation(invocation)
          const admittedInput = inputFromInvocation(invocation, supportInput)
          try {
            await renewProviderStage(route, { recordRoute: false })
            await assertCurrentEvidenceFence({ providerInput, scope: safeScope })
          } catch (error) {
            if (isLocalControlFailure(error)) {
              localControlFailure = error
              throw new ProviderAdapterError('policy', { localControl: true })
            }
            throw error
          }
          return (adapters.llmProvider?.verifySupport
            ? adapters.llmProvider.verifySupport({ route, input: JSON.stringify(admittedInput), locale: 'vi', tools: [] })
            : verifySupport({ route, question: admittedInput.question, addressesQuestion: admittedInput.addressesQuestion, paragraphs: admittedInput.paragraphs, evidenceBlocks: admittedInput.evidenceBlocks, evidenceMap: admittedInput.evidenceMap }))
        }
        const validateSupportOutput = ({ output: candidate }) => {
          if (!candidate || typeof candidate !== 'object' || !['supported', 'unsupported', 'uncertain'].includes(candidate.verdict) || typeof candidate.addressesQuestion !== 'boolean' || !Array.isArray(candidate.evidenceBlockIds)) throw new ProviderAdapterError('support')
          return candidate
        }
        const support = await providerRouter.execute({ workloadId: 'qa-support', admittedInput: supportInput, attemptId: attempt._id?.toHexString?.() ?? String(attempt._id), invoke: invokeSupport, validateOutput: validateSupportOutput })
        const verdict = support?.output
        const verdictValue = verdict?.verdict ?? verdict
        if (verdict?.addressesQuestion !== true || ['unsupported', 'uncertain'].includes(verdictValue)) {
          const supportError = new Error('Answer support verdict is insufficient')
          supportError.code = verdict?.addressesQuestion === true ? verdictValue : 'uncertain'
          throw supportError
        }
        assertSupportedAnswer({ verdict: verdictValue, verdictEvidenceBlockIds: verdict?.evidenceBlockIds, paragraphs, citationIds: providerInput.prompt.citations.map(({ id }) => id), evidenceBlocks: supportBlocks })
      }
      const hydrated = hydrateAnswerCitations({ citationIds: [...new Set(paragraphs.flatMap(({ citationIds }) => citationIds))], evidence: providerInput.evidence })
      const answer = { id: parsed.id ?? `answer-${attempt._id?.toHexString?.()}`, status: 'answered', paragraphs: paragraphs.map(({ text, citationIds }) => ({ text, citationIds })), citations: hydrated, refusalReason: null, chatSessionId: chatSessionId ?? undefined, createdAt: now().toISOString() }
      const chat = await qaRepositoryCall('appendAnswer', () => chatRepository.appendAnswer({ actor, chatSessionId, scope: safeScope, question: providerInput.admitted.question, answer, citations: hydrated, attempt: { id: attempt._id, outcome: 'completed' }, expectedEvidenceFence: providerInput.fence, now: now() }))
      if (!chat?.attemptCommitted && typeof answerAttemptRepository.updateAnswerAttempt === 'function') await qaRepositoryCall('updateAnswerAttempt', () => answerAttemptRepository.updateAnswerAttempt(attempt._id, { status: 'completed', resultStatus: 'answered', chatSessionId: chat.chatSessionId, messageId: chat.messageId }, { expectedStatus: 'provider-running' }))
      return { answer: { ...answer, chatSessionId: chat.chatSessionId } }
    } catch (error) {
      if (localControlFailure) {
        const controlFailure = localControlFailure
        if (controlFailure instanceof EvidenceSelectionError && controlFailure.discard) throw new ContentError(409, 'conflict', 'Answer evidence changed during processing')
        throw controlFailure
      }
      if (error?.name === 'ProviderRoutingError') {
        if (error.failureClass === 'ambiguous') return markAmbiguousAttempt(attempt)
        if (error.failureClass === 'policy') return { answer: await refusal({ actor, attempt, reason: 'policy-blocked', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
        if (error.failureClass === 'sensitive-input') return { answer: await privacyRefusal({ actor, attempt, scope: safeScope, chatSessionId }) }
        return { answer: await refusal({ actor, attempt, reason: 'provider-unavailable', scope: safeScope, question, expectedEvidenceFence: providerInput?.fence }) }
      }
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
