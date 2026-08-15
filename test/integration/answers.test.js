import { describe, expect, it } from 'vitest'
import { createQaService } from '../../server/application/qa/service.js'
import { createProviderRouterFixture } from '../unit/qa/provider-router-fixture.js'

const auth = { user: { id: 'user-1', status: 'active', sessionVersion: 1 }, session: { id: 'session-1', userSessionVersion: 1 } }

function repository({ evidence = [] } = {}) {
  const attempts = new Map()
  const writes = []
  return {
    writes,
    async reserveAnswerAttempt({ idempotencyKeyHash, requestHash, chatSessionId }) {
      const current = attempts.get(idempotencyKeyHash)
      if (current) return current.requestHash === requestHash ? { ...current, reused: true } : { ...current, status: 'mismatch' }
      const attempt = { _id: `attempt-${attempts.size + 1}`, status: 'reserved', requestHash, ...(chatSessionId ? { chatSessionId } : {}) }
      attempts.set(idempotencyKeyHash, attempt)
      return attempt
    },
    async updateAnswerAttempt(id, update) {
      const attempt = [...attempts.values()].find((item) => item._id === id)
      Object.assign(attempt, update)
      return attempt
    },
    async getChatSession() { return null },
    async appendAnswer(input) { writes.push(input); return { chatSessionId: 'chat-1', messageId: input.answer.id, answer: { ...input.answer, chatSessionId: 'chat-1' } } },
    async appendRefusalWithoutQuestion(input) { writes.push(input); return { chatSessionId: 'chat-1', messageId: input.answer.id, answer: { ...input.answer, chatSessionId: 'chat-1' } } },
    async findQnaEvidence() { return evidence },
  }
}

describe('answers integration boundary', () => {
  it('refuses a sensitive request without reserving an attempt or persisting the raw question', async () => {
    const repo = repository()
    const service = createQaService({ chatRepository: repo, articleRepository: repo, providerRouter: createProviderRouterFixture() })
    const result = await service.createAnswer({ auth, question: 'Dùng ghp_1234567890abcdefghijklmnop để trả lời', scope: { topics: ['AI'] }, idempotencyKey: 'integration-sensitive-key' })
    expect(result.answer).toMatchObject({ status: 'refused', refusalReason: 'sensitive-input' })
    expect(repo.writes).toEqual([expect.not.objectContaining({ question: expect.anything() })])
  })
})
