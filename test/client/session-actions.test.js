import { describe, expect, it, vi } from 'vitest'
import {
  createSessionActions,
  recoverPendingLogout,
  withSessionRecovery,
} from '../../client/app/integration/session-actions.js'
import {
  genericOAuthRedirectError,
  OAUTH_REDIRECT_ERROR_MESSAGES,
  authErrorForRedirect,
} from '../../client/app/integration/oauth-redirect.js'

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

    expect(api.updatePreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-in-memory' },
      }),
    )
    expect(api.logout).toHaveBeenCalledWith({
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'csrf-in-memory' },
    })
    expect(applySession).toHaveBeenCalledWith(null, null, null)
  })
  it.each([
    ['503', Object.assign(new Error('service unavailable'), { status: 503 })],
    ['403', Object.assign(new Error('csrf rejected'), { status: 403 })],
    ['network', new Error('network unavailable')],
  ])('preserves local session and CSRF after a %s logout failure', async (_label, failure) => {
    const api = {
      logout: vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ data: {} }),
    }
    const applySession = vi.fn()
    const actions = createSessionActions({ api, getCsrfToken: () => 'csrf-retry', applySession })

    await expect(actions.logout()).rejects.toBe(failure)
    expect(applySession).not.toHaveBeenCalled()

    await actions.logout()
    expect(api.logout).toHaveBeenNthCalledWith(2, {
      credentials: 'same-origin',
      headers: { 'X-CSRF-Token': 'csrf-retry' },
    })
    expect(applySession).toHaveBeenCalledWith(null, null, null)
  })

  it('bootstraps CSRF before pending logout and clears markers only after success', async () => {
    const calls = []
    const storage = { removeItem: vi.fn() }
    const api = {
      getCurrentUser: vi.fn(async (options) => {
        calls.push(['me', options])
        return response({ id: 'user-after-reload' }, 'csrf-bootstrapped')
      }),
      logout: vi.fn(async (options) => {
        calls.push(['logout', options])
        return { data: {} }
      }),
    }

    await expect(recoverPendingLogout({ api, storage, pendingNotice: 'Đăng xuất sau đổi mật khẩu.' })).resolves.toEqual({
      status: 'cleared',
      notice: 'Đăng xuất sau đổi mật khẩu.',
    })
    expect(calls).toEqual([
      ['me', { credentials: 'same-origin' }],
      ['logout', { credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-bootstrapped' } }],
    ])
    expect(storage.removeItem).toHaveBeenCalledWith('techpulse_pending_logout')
  })

  it('keeps the pending logout marker on transient recovery failure', async () => {
    const storage = { removeItem: vi.fn() }
    const api = {
      getCurrentUser: vi.fn().mockRejectedValue(Object.assign(new Error('temporary outage'), { status: 503 })),
      logout: vi.fn(),
    }

    await expect(recoverPendingLogout({ api, storage, pendingNotice: 'Đăng xuất sau đổi mật khẩu.' })).resolves.toMatchObject({
      status: 'retry',
      notice: 'Đăng xuất sau đổi mật khẩu.',
      error: { status: 503 },
    })
    expect(api.logout).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })

  it.each([
    ['bootstrap', { getCurrentUser: vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { status: 401 })) }],
    ['logout', { getCurrentUser: vi.fn().mockResolvedValue(response()), logout: vi.fn().mockRejectedValue(Object.assign(new Error('expired'), { status: 401 })) }],
  ])('clears the pending marker when the server reports an invalid session during %s', async (_stage, api) => {
    const storage = { removeItem: vi.fn() }

    await expect(recoverPendingLogout({ api, storage, pendingNotice: 'Đăng xuất sau đổi mật khẩu.' })).resolves.toMatchObject({ status: 'cleared' })
    expect(storage.removeItem).toHaveBeenCalledWith('techpulse_pending_logout')
  })

  it('sends the current CSRF token for account deletion before clearing the session', async () => {
    const api = { requestAccountDeletion: vi.fn().mockResolvedValue({ data: {} }) }
    const applySession = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => 'csrf-in-memory',
      applySession,
      createIdempotencyKey: () => 'account-deletion-test',
    })

    await actions.requestDeletion()

    expect(api.requestAccountDeletion).toHaveBeenCalledWith(expect.objectContaining({
      headers: { 'Idempotency-Key': 'account-deletion-test', 'X-CSRF-Token': 'csrf-in-memory' },
    }))
    expect(applySession).toHaveBeenCalledWith(null, null, 'Yêu cầu xóa tài khoản đã được chấp nhận. Phiên của bạn đã bị thu hồi.')
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

  it('maps OAuth redirect error markers to fixed English messages', () => {
    expect(authErrorForRedirect('conflict')).toEqual(
      expect.objectContaining({ status: 409, code: 'conflict', message: 'Account already exists' }),
    )
    expect(authErrorForRedirect('account_suspended')).toEqual(
      expect.objectContaining({ status: 403, message: 'This account has been suspended' }),
    )
    expect(authErrorForRedirect('oauth_identity_conflict')).toEqual(
      expect.objectContaining({ message: 'Email account requires explicit Google linking' }),
    )
    expect(authErrorForRedirect('oauth_provider_error')).toEqual(
      expect.objectContaining({ status: 502, message: 'Google OAuth verification failed' }),
    )
  })

  it('falls back to a generic sign-in message for unknown OAuth redirect markers', () => {
    const error = genericOAuthRedirectError()
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(400)
    expect(OAUTH_REDIRECT_ERROR_MESSAGES.unexpected_marker).toBeUndefined()
    expect(error.message).toMatch(/could not be completed/i)
  })

  it('returns null when no OAuth redirect marker is present', () => {
    expect(authErrorForRedirect(null)).toBeNull()
    expect(authErrorForRedirect(undefined)).toBeNull()
    expect(authErrorForRedirect('')).toBeNull()
  })

  it('commits the rotated session before marking password logout pending', async () => {
    const rotatedUser = { id: 'user-opaque', role: 'user', hasPassword: true }
    const api = { changePassword: vi.fn().mockResolvedValue(response(rotatedUser, 'csrf-rotated')) }
    const events = []
    const applySession = vi.fn(() => events.push('commit'))
    const onPasswordChangeSuccess = vi.fn(() => events.push('pending-marker'))
    const actions = createSessionActions({
      api,
      getCsrfToken: () => 'csrf-in-memory',
      applySession,
      onPasswordChangeSuccess,
    })

    await actions.changePassword({ currentPassword: 'old-password-1', newPassword: 'new-password-1' })
    expect(api.changePassword).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: 'same-origin',
        body: JSON.stringify({ newPassword: 'new-password-1', currentPassword: 'old-password-1' }),
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-in-memory' },
      }),
    )
    expect(applySession).toHaveBeenLastCalledWith(rotatedUser, 'csrf-rotated', null)
    expect(onPasswordChangeSuccess).toHaveBeenLastCalledWith('Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.')
    expect(events).toEqual(['commit', 'pending-marker'])

    await actions.changePassword({ newPassword: 'first-password-1' })
    expect(api.changePassword).toHaveBeenLastCalledWith(
      expect.objectContaining({ body: JSON.stringify({ newPassword: 'first-password-1' }) }),
    )
    expect(onPasswordChangeSuccess).toHaveBeenLastCalledWith('Đặt mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.')
  })

  it('ignores a stale password change completion after a newer session transition starts', async () => {
    let epoch = 0
    let resolveChange
    const api = {
      changePassword: vi.fn(() => new Promise((resolve) => { resolveChange = resolve })),
    }
    const applySession = vi.fn()
    const onPasswordChangeSuccess = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => 'csrf-current',
      applySession,
      onPasswordChangeSuccess,
      beginSessionTransition: () => { epoch += 1; return epoch },
      isSessionTransitionCurrent: (value) => value === epoch,
    })

    const pending = actions.changePassword({ newPassword: 'new-password-1' })
    epoch += 1
    resolveChange(response({ id: 'old-user' }, 'old-csrf'))
    await pending

    expect(applySession).not.toHaveBeenCalled()
    expect(onPasswordChangeSuccess).not.toHaveBeenCalled()
  })

  it('serializes password rotation ahead of concurrent preference saves and uses the rotated CSRF token', async () => {
    let resolvePassword
    let resolvePreferences
    let csrfToken = 'csrf-initial'
    const api = {
      changePassword: vi.fn(() => new Promise((resolve) => { resolvePassword = resolve })),
      updatePreferences: vi.fn((init) => new Promise((resolve) => {
        resolvePreferences = () => resolve({ data: { id: 'user-opaque', topicPreferences: ['AI'] }, init })
      })),
    }
    const applySession = vi.fn((_user, nextCsrfToken) => { csrfToken = nextCsrfToken })
    const actions = createSessionActions({ api, getCsrfToken: () => csrfToken, applySession })

    const passwordPending = actions.changePassword({ newPassword: 'new-password-1' })
    const preferencesPending = actions.updatePreferences(['AI'])
    await Promise.resolve()
    expect(api.updatePreferences).not.toHaveBeenCalled()

    resolvePassword(response({ id: 'user-opaque', hasPassword: true }, 'csrf-rotated'))
    await passwordPending
    expect(api.updatePreferences).toHaveBeenCalledWith(expect.objectContaining({
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-rotated' },
    }))

    resolvePreferences()
    await preferencesPending
  })

  it('resynchronizes a stable controller after an external session rerender', async () => {
    let csrfToken = 'csrf-t0'
    const api = {
      changePassword: vi.fn().mockResolvedValue(response({ id: 'user-opaque', hasPassword: true }, 'csrf-t1')),
      logout: vi.fn().mockResolvedValue({ data: {} }),
    }
    const actions = createSessionActions({ api, getCsrfToken: () => csrfToken, applySession: vi.fn() })

    await actions.changePassword({ newPassword: 'new-password-1' })
    csrfToken = 'csrf-t2'
    await actions.logout()

    expect(api.logout).toHaveBeenCalledWith({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-t2' } })
  })
  it('forwards an optional notice when logging out', async () => {
    const api = { logout: vi.fn().mockResolvedValue({ data: {} }) }
    const applySession = vi.fn()
    const actions = createSessionActions({ api, getCsrfToken: () => 'csrf-t3', applySession })

    await actions.logout('Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.')

    expect(api.logout).toHaveBeenCalledWith({ credentials: 'same-origin', headers: { 'X-CSRF-Token': 'csrf-t3' } })
    expect(applySession).toHaveBeenCalledWith(
      null,
      null,
      'Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.',
    )
  })
})
