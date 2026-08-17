import { createQaService } from '../application/qa/service.js'
import { rankQnaEvidence } from '../ai/retrieval.js'

const AUTH = Object.freeze({
  user: Object.freeze({ id: '507f1f77bcf86cd799439001', status: 'active', sessionVersion: 1 }),
  session: Object.freeze({ id: '507f1f77bcf86cd799439002', userSessionVersion: 1 }),
})

function evidenceIds(input) {
  return [...String(input ?? '').matchAll(/<evidence-block\s+id="(E\d+)"\s+citation="(C\d+)"/g)].map(([, evidenceBlockId, citationId]) => ({ evidenceBlockId, citationId }))
}

function createRepository(records) {
  const attempts = new Map()
  const sessions = []
  return {
    async reserveAnswerAttempt({ idempotencyKeyHash, requestHash, chatSessionId }) {
      const existing = attempts.get(idempotencyKeyHash)
      if (existing) return existing.requestHash === requestHash ? { ...existing, reused: true } : { ...existing, status: 'mismatch' }
      const attempt = { _id: `eval-attempt-${attempts.size + 1}`, idempotencyKeyHash, requestHash, status: 'reserved', ...(chatSessionId ? { chatSessionId } : {}) }
      attempts.set(idempotencyKeyHash, attempt)
      return { ...attempt, reused: false }
    },
    async updateAnswerAttempt(id, update) {
      const attempt = [...attempts.values()].find((value) => value._id === id)
      Object.assign(attempt, update)
      return attempt
    },
    async appendAnswer({ answer, chatSessionId }) {
      const value = { chatSessionId: chatSessionId ?? '507f1f77bcf86cd799439003', messageId: answer.id, answer: { ...answer, chatSessionId: chatSessionId ?? '507f1f77bcf86cd799439003' } }
      sessions.push(value)
      return { ...value, attemptCommitted: true }
    },
    async appendRefusalWithoutQuestion({ answer, chatSessionId }) {
      const value = { chatSessionId: chatSessionId ?? '507f1f77bcf86cd799439003', messageId: answer.id, answer: { ...answer, chatSessionId: chatSessionId ?? '507f1f77bcf86cd799439003' } }
      sessions.push(value)
      return { ...value, attemptCommitted: true }
    },
    async findQnaEvidence({ question }) {
      return rankQnaEvidence({ question, records, relevanceThreshold: 0.25, maxCandidates: 50 })
    },
  }
}

function createControlledProviderRouter() {
  return Object.freeze({
    async execute({ workloadId, admittedInput, invoke, validateOutput }) {
      const route = Object.freeze({
        routeId: workloadId === 'qa-support' ? 'controlled-support' : 'controlled-primary',
        providerId: 'controlled',
        providerFailureDomainId: 'controlled-local',
        model: 'controlled',
      })
      const output = await invoke({ route, admittedInput })
      return Object.freeze({
        output: validateOutput({ route, output, admittedInput }),
        metadata: Object.freeze({
          workloadId,
          routeId: route.routeId,
          providerId: route.providerId,
          providerFailureDomainId: route.providerFailureDomainId,
          model: route.model,
          externalAttempts: 1,
          fallback: 'none',
        }),
      })
    },
  })
}

/**
 * Run a bounded fixture through the production createAnswer orchestration.
 * The repository/providers are deterministic and in-memory; no network or Mongo is used.
 */
export async function createControlledAnswer({ item, question, scope, idempotencyKey } = {}) {
  const repository = createRepository(item?.evidence ?? [])
  const service = createQaService({
    articleRepository: repository,
    chatRepository: repository,
    providerRouter: createControlledProviderRouter(),
    providerAdapters: {
      llmProvider: {
        async answer({ input }) {
          if (item?.expected !== 'answered' || item?.recordedProviderOutput?.status === 'refused') return { status: 'refused', refusalReason: item?.recordedProviderOutput?.refusalReason ?? item?.expected }
          const ids = evidenceIds(input)
          return {
            status: 'answered',
            paragraphs: [{
              text: item?.recordedProviderOutput?.paragraphs?.[0]?.text ?? item?.expectedClaims?.join('. ') ?? 'Thong tin duoc neu trong nguon.',
              citationIds: ids.slice(0, 1).map(({ citationId }) => citationId),
              evidenceBlockIds: ids.slice(0, 1).map(({ evidenceBlockId }) => evidenceBlockId),
            }],
          }
        },
      },
    },
    supportVerifier: async ({ evidenceBlocks, question: admittedQuestion }) => ({
      verdict: item?.adjudication?.supportVerdict ?? 'uncertain',
      addressesQuestion: item?.adjudication?.addressesQuestion === true && typeof admittedQuestion === 'string' && admittedQuestion.length > 0,
      evidenceBlockIds: evidenceBlocks.map(({ id }) => id),
    }),
  })
  return service.createAnswer({ auth: AUTH, question, scope: scope ?? { topics: ['eval'] }, idempotencyKey })
}
