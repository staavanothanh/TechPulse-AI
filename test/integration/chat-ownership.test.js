import { describe, expect, it } from 'vitest'
import { createQaService } from '../../server/application/qa/service.js'
import { createProviderRouterFixture } from '../unit/qa/provider-router-fixture.js'

const auth = { user: { id: 'user-1', status: 'active', sessionVersion: 1 }, session: { id: 'session-1', userSessionVersion: 1 } }

describe('chat ownership integration boundary', () => {
  it('returns the same non-disclosing not-found result for a foreign chat continuation before provider work', async () => {
    const reserveAnswerAttempt = async () => { throw new Error('must not reserve') }
    const answer = async () => { throw new Error('must not call provider') }
    const chatRepository = { reserveAnswerAttempt, getChatSession: async () => null }
    const service = createQaService({ chatRepository, providerRouter: createProviderRouterFixture(), providerAdapters: { llmProvider: { answer } } })
    await expect(service.createAnswer({ auth, question: 'Tiếp tục phiên này', scope: { topics: ['AI'] }, chatSessionId: '507f1f77bcf86cd799439099', idempotencyKey: 'foreign-session-key' })).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})
