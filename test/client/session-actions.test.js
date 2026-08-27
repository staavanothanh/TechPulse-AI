import { describe, expect, it, vi } from 'vitest'
import {
  createSessionActions,
  withSessionRecovery,
} from '../../client/app/integration/session-actions.js'

function response(user = { id: 'user-opaque', role: 'user' }, csrfToken = 'csrf-next') {
  return { data: { user, csrfToken } }
}

describe('application session actions', () => {
  it('uses generated login/register operations and applies the returned in-memory session', async () => {
    const api = {
      login: vi.fn().mockResolvedValue(response()),
      registerUser: vi.fn().mockResolvedValue(response()),
    }
    const applySession = vi.fn()
    const actions = createSessionActions({ api, getCsrfToken: () => null, applySession })

    await actions.authenticate({
      mode: 'login',
      email: 'reader@example.test',
      password: 'password-123',
    })
    await actions.authenticate({
      mode: 'register',
      email: 'reader@example.test',
      password: 'password-123',
    })

    expect(api.login).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    expect(api.registerUser).toHaveBeenCalledOnce()
    expect(applySession).toHaveBeenLastCalledWith(
      { id: 'user-opaque', role: 'user' },
      'csrf-next',
      null,
    )
  })

  it('ignores an authentication response after a newer session transition starts', async () => {
    let epoch = 0
    let resolveLogin
    const api = { login: vi.fn(() => new Promise((resolve) => { resolveLogin = resolve })) }
    const applySession = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => null,
      applySession,
      beginSessionTransition: () => { epoch += 1; return epoch },
      isSessionTransitionCurrent: (value) => value === epoch,
    })

    const pending = actions.authenticate({ mode: 'login', email: 'a@example.test', password: 'password-123' })
    epoch += 1
    resolveLogin(response({ id: 'old-user' }, 'old-csrf'))
    await pending

    expect(applySession).not.toHaveBeenCalled()
  })

  it('ignores stale logout, preference and deletion completions', async () => {
    let epoch = 0
    const deferred = () => {
      let resolve
      const promise = new Promise((nextResolve) => { resolve = nextResolve })
      return { promise, resolve }
    }
    const logout = deferred()
    const preferences = deferred()
    const deletion = deferred()
    const api = {
      logout: vi.fn(() => logout.promise),
      updatePreferences: vi.fn(() => preferences.promise),
      requestAccountDeletion: vi.fn(() => deletion.promise),
    }
    const applySession = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => 'csrf-current',
      applySession,
      createIdempotencyKey: () => 'delete-test',
      beginSessionTransition: () => { epoch += 1; return epoch },
      isSessionTransitionCurrent: (value) => value === epoch,
    })

    const pendingLogout = actions.logout()
    epoch += 1
    logout.resolve({ data: {} })
    await pendingLogout
    const pendingPreferences = actions.updatePreferences(['AI'])
    epoch += 1
    preferences.resolve(response({ id: 'old-user' }))
    await pendingPreferences
    const pendingDeletion = actions.requestDeletion()
    epoch += 1
    deletion.resolve({ data: {} })
    await pendingDeletion

    expect(applySession).not.toHaveBeenCalled()
  })

  it('keeps CSRF in memory for account mutations and clears the session after logout', async () => {
    const api = {
      logout: vi.fn().mockResolvedValue({ data: {} }),
      updatePreferences: vi
        .fn()
        .mockResolvedValue({ data: { id: 'user-opaque', role: 'user', topicPreferences: ['AI'] } }),
      requestAccountDeletion: vi.fn().mockResolvedValue({ data: {} }),
    }
    const applySession = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => 'csrf-in-memory',
      applySession,
      createIdempotencyKey: () => 'account-deletion-test',
    })

    await actions.updatePreferences(['AI'])
    await actions.logout()
    await actions.requestDeletion()

    expect(api.updatePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-in-memory' },
      }),
    )
    expect(api.logout).toHaveBeenCalledWith({
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'csrf-in-memory' },
    })
    expect(api.requestAccountDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'Idempotency-Key': 'account-deletion-test', 'X-CSRF-Token': 'csrf-in-memory' },
      }),
    )
    expect(applySession).toHaveBeenCalledWith(null, null, null)
    expect(applySession).toHaveBeenLastCalledWith(
      null,
      null,
      'Yêu cầu xóa tài khoản đã được chấp nhận. Phiên của bạn đã bị thu hồi.',
    )
  })

  it('rejects invalid preferences before calling the API', async () => {
    const api = { updatePreferences: vi.fn() }
    const actions = createSessionActions({ api, getCsrfToken: () => 'csrf', applySession: vi.fn() })

    await expect(actions.updatePreferences(['AI', 'AI'])).rejects.toMatchObject({ status: 422 })
    expect(api.updatePreferences).not.toHaveBeenCalled()
  })

  it('rejects session mutations when no in-memory CSRF token is available', async () => {
    const api = { logout: vi.fn() }
    const actions = createSessionActions({ api, getCsrfToken: () => null, applySession: vi.fn() })
    await expect(actions.logout()).rejects.toMatchObject({ status: 401 })
    expect(api.logout).not.toHaveBeenCalled()
  })

  it('recovers only an expired admin session and preserves authorization errors', async () => {
    const expired = Object.assign(new Error('expired'), { status: 401 })
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
    const invalid = Object.assign(new Error('invalid'), { status: 422 })
    const onSessionExpired = vi.fn()
    const api = withSessionRecovery(
      {
        getAdminOverview: vi
          .fn()
          .mockRejectedValueOnce(expired)
          .mockRejectedValueOnce(forbidden)
          .mockRejectedValueOnce(invalid),
      },
      onSessionExpired,
    )

    await expect(api.getAdminOverview()).rejects.toBe(expired)
    await expect(api.getAdminOverview()).rejects.toBe(forbidden)
    await expect(api.getAdminOverview()).rejects.toBe(invalid)
    expect(onSessionExpired).toHaveBeenCalledOnce()
  })

  it('does not expire a newer admin session for a late 401', async () => {
    let identity = 'admin:old:csrf-old'
    let epoch = 4
    let rejectRequest
    const onSessionExpired = vi.fn()
    const api = withSessionRecovery(
      { getAdminOverview: vi.fn(() => new Promise((_, reject) => { rejectRequest = reject })) },
      onSessionExpired,
      {
        getSessionIdentity: () => identity,
        isSessionIdentityCurrent: (value) => value === identity,
        getSessionEpoch: () => epoch,
        isSessionEpochCurrent: (value) => value === epoch,
      },
    )

    const pending = api.getAdminOverview()
    identity = 'admin:new:csrf-new'
    epoch = 5
    rejectRequest(Object.assign(new Error('expired'), { status: 401 }))

    await expect(pending).rejects.toMatchObject({ status: 401 })
    expect(onSessionExpired).not.toHaveBeenCalled()
  })
})
