import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROUTES,
  PUBLIC_ROUTES,
  isSessionAccessFailure,
  normalizeAdminRoute,
  normalizePublicRoute,
  publicSessionKey,
  publicSessionForRole,
  sessionSurface,
} from '../../../client/redesign/integration/routing.js'
import { recoverBootstrapSession } from '../../../client/redesign/integration/session-actions.js'
import {
  preferenceDraftForUser,
  sessionExpiredNotice,
  validateTopicPreferences,
} from '../../../client/features/auth/session-state.js'

describe('redesign integration role and route policy', () => {
  it('keeps the complete public and admin route sets at the integration boundary', () => {
    expect([...PUBLIC_ROUTES]).toEqual(['feed', 'search', 'saved', 'article', 'qa', 'account'])
    expect([...ADMIN_ROUTES]).toEqual([
      'overview',
      'jobs',
      'articles',
      'governance',
      'sources',
      'users',
      'audit',
      'account',
      'deletions',
    ])
    expect(normalizePublicRoute('unknown')).toBe('feed')
    expect(normalizeAdminRoute('unknown')).toBe('overview')
    expect(normalizePublicRoute('saved')).toBe('saved')
    expect(normalizeAdminRoute('audit')).toBe('audit')
  })

  it('renders only the surface allowed by the current server session role', () => {
    expect(sessionSurface({ status: 'loading', user: null })).toBe('public')
    expect(sessionSurface({ status: 'ready', user: { role: 'user' } })).toBe('public')
    expect(sessionSurface({ status: 'ready', user: { role: 'admin' } })).toBe('admin')
    expect(sessionSurface({ status: 'ready', user: { role: 'owner' } })).toBe('public')
  })

  it('removes privileged identities from the public surface without mutating reader sessions', () => {
    const loading = { status: 'loading', user: null }
    const reader = { status: 'ready', user: { role: 'user' }, csrfToken: 'reader-csrf' }
    const admin = { status: 'ready', user: { role: 'admin' }, csrfToken: 'admin-csrf' }
    expect(publicSessionForRole(loading)).toBe(loading)
    expect(publicSessionForRole(reader)).toBe(reader)
    expect(publicSessionForRole(admin)).toEqual({ status: 'ready', user: null, csrfToken: null })
  })

  it('changes the public controller identity across logout and account switches', () => {
    expect(publicSessionKey({ status: 'ready', user: null })).toBe('guest')
    expect(publicSessionKey({ status: 'ready', user: { id: 'reader-one', role: 'user' } })).toBe(
      'user:reader-one',
    )
    expect(publicSessionKey({ status: 'ready', user: { id: 'reader-two', role: 'user' } })).toBe(
      'user:reader-two',
    )
    expect(publicSessionKey({ status: 'loading', user: null })).toBe('guest')
  })

  it('recovers 401 as a guest but keeps 403 in the explicit retry state', () => {
    expect(
      recoverBootstrapSession(Object.assign(new Error('expired'), { status: 401 })),
    ).toMatchObject({ status: 'ready', user: null, csrfToken: null })
    expect(
      recoverBootstrapSession(Object.assign(new Error('forbidden'), { status: 403 })),
    ).toMatchObject({ status: 'error', user: null, csrfToken: null, error: 'forbidden' })
  })

  it('treats both authentication and authorization loss as runtime session recovery', () => {
    expect(isSessionAccessFailure({ status: 401 })).toBe(true)
    expect(isSessionAccessFailure({ status: 403 })).toBe(false)
    expect(isSessionAccessFailure({ status: 422 })).toBe(false)
    expect(isSessionAccessFailure(null)).toBe(false)
  })

  it('keeps account preference and expiry rules in the reused session module', () => {
    const user = { topicPreferences: ['AI'] }
    expect(preferenceDraftForUser(user)).toEqual(['AI'])
    expect(preferenceDraftForUser(null)).toEqual([])
    expect(validateTopicPreferences([' AI ', 'DevOps'])).toEqual({
      valid: true,
      topics: ['AI', 'DevOps'],
    })
    expect(validateTopicPreferences('AI')).toEqual({ valid: false, topics: [] })
    expect(validateTopicPreferences(['AI', 'AI'])).toEqual({ valid: false, topics: [] })
    expect(validateTopicPreferences(['x'.repeat(65)])).toEqual({ valid: false, topics: [] })
    expect(sessionExpiredNotice({ status: 401 })).toMatch(/Phiên đăng nhập/)
    expect(sessionExpiredNotice({ status: 403 })).toBeNull()
  })
})
