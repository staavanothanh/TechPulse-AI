import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AuthPanel from '../../../client/features/public/components/AuthPanel.jsx'
import { createSessionActions } from '../../../client/app/integration/session-actions.js'

const render = (props = {}) => renderToStaticMarkup(React.createElement(AuthPanel, props))

describe('public Google OAuth login', () => {
  it('renders the Google login button only in login mode', () => {
    const login = render({ mode: 'login' })
    const register = render({ mode: 'register' })

    expect(login).toContain('Đăng nhập bằng Google')
    expect(login).toContain('type="button"')
    expect(register).not.toContain('Đăng nhập bằng Google')
  })

  it('shows an accessible busy state and OAuth error', () => {
    const html = render({
      mode: 'login',
      googleBusy: true,
      error: 'Google OAuth hiện không khả dụng.',
    })

    expect(html).toContain('Đang chuyển đến Google...')
    expect(html).toContain('aria-busy="true"')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Đang chuyển đến Google\.\.\.<\/button>/)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Đăng nhập<\/button>/)
    expect(html).toContain('role="alert"')
    expect(html).toContain('Google OAuth hiện không khả dụng.')
  })

  it('requests the generated Google auth URL and redirects when the login action runs', async () => {
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?state=test-state'
    const api = { getGoogleAuthUrl: vi.fn().mockResolvedValue({ data: { authUrl } }) }
    const redirect = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => null,
      applySession: vi.fn(),
      redirect,
    })

    await actions.authenticateWithGoogle()

    expect(api.getGoogleAuthUrl).toHaveBeenCalledWith({ credentials: 'same-origin' })
    expect(redirect).toHaveBeenCalledWith(authUrl)
  })

  it('keeps the redirect side effect out of the error path', async () => {
    const apiError = Object.assign(new Error('Google OAuth unavailable'), { status: 503 })
    const api = { getGoogleAuthUrl: vi.fn().mockRejectedValue(apiError) }
    const redirect = vi.fn()
    const actions = createSessionActions({
      api,
      getCsrfToken: () => null,
      applySession: vi.fn(),
      redirect,
    })

    await expect(actions.authenticateWithGoogle()).rejects.toBe(apiError)
    expect(redirect).not.toHaveBeenCalled()
  })
})
