import { describe, expect, it } from 'vitest'
import {
  bootstrapSessionFailure,
  preferenceDraftForUser,
  SESSION_EXPIRED_MESSAGE,
  sessionExpiredNotice,
  validateTopicPreferences,
} from '../../client/features/auth/session-state.js'

describe('auth/account in-memory session state', () => {
  it('scopes a preference draft to the active user and clears it for no session', () => {
    const userA = { id: 'user-a', topicPreferences: ['AI', 'Robot'] }
    const userB = { id: 'user-b', topicPreferences: ['Security'] }

    expect(preferenceDraftForUser(userA)).toEqual(['AI', 'Robot'])
    expect(preferenceDraftForUser(userB)).toEqual(['Security'])
    expect(preferenceDraftForUser(null)).toEqual([])
  })

  it('keeps a 401 bootstrap distinct from a retryable network or service failure', () => {
    expect(bootstrapSessionFailure({ status: 401 })).toEqual({
      status: 'ready',
      user: null,
      csrfToken: null,
      error: null,
    })
    expect(bootstrapSessionFailure({ status: 503, message: 'temporarily unavailable' })).toEqual({
      status: 'error',
      user: null,
      csrfToken: null,
      error: 'temporarily unavailable',
    })
  })

  it('preserves a session-expired reason for the account surface', () => {
    expect(sessionExpiredNotice({ status: 401 })).toBe(SESSION_EXPIRED_MESSAGE)
    expect(sessionExpiredNotice({ status: 503 })).toBeNull()
  })

  it('validates the preference editor before it submits a draft', () => {
    expect(validateTopicPreferences(['AI', 'Robot'])).toEqual({
      valid: true,
      topics: ['AI', 'Robot'],
    })
    expect(validateTopicPreferences(['AI', 'AI']).valid).toBe(false)
    expect(
      validateTopicPreferences(Array.from({ length: 21 }, (_value, index) => `topic-${index}`))
        .valid,
    ).toBe(false)
    expect(validateTopicPreferences(['x'.repeat(65)]).valid).toBe(false)
  })
})
