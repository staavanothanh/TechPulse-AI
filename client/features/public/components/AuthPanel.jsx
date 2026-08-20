import { useState } from 'react'
import { normalizeAuthMode, validateCredentials } from '../validation.js'

function AuthAlert({ error, notice }) {
  if (!error && !notice) return null
  const message = typeof error === 'string' ? error : error?.message
  return (
    <div
      className={`public-alert ${error ? 'public-alert-error' : 'public-alert-info'}`}
      role={error ? 'alert' : 'status'}
    >
      <span aria-hidden="true">{error ? '!' : 'i'}</span>
      <p>{message || notice}</p>
    </div>
  )
}

export default function AuthPanel({
  mode: initialMode = 'login',
  busy = false,
  error = null,
  notice = null,
  onSubmit,
  onModeChange,
  onGuestBrowse,
}) {
  const [mode, setMode] = useState(() => normalizeAuthMode(initialMode))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState({})
  const emailId = 'public-auth-email'
  const passwordId = 'public-auth-password'

  function switchMode() {
    const next = mode === 'login' ? 'register' : 'login'
    setMode(next)
    setErrors({})
    onModeChange?.(next)
  }

  function submit(event) {
    event.preventDefault()
    const validation = validateCredentials({ email, password })
    setErrors(validation.errors)
    if (!validation.valid) {
      const first = Object.keys(validation.errors)[0]
      event.currentTarget.elements[first === 'email' ? 'email' : 'password']?.focus()
      return
    }
    onSubmit?.({ email: email.trim(), password, mode })
  }

  const register = mode === 'register'
  const submitLabel = busy
    ? register
      ? 'Đang tạo...'
      : 'Đang xử lý...'
    : register
      ? 'Tạo tài khoản'
      : 'Đăng nhập'
  return (
    <section
      className="public-auth-panel"
      aria-labelledby="public-auth-title"
      data-od-id="auth-panel"
    >
      <p className="public-eyebrow">TechPulse AI · {register ? 'Tạo tài khoản' : 'Đăng nhập'}</p>
      <h2 id="public-auth-title">
        {register ? 'Tạo tài khoản mới' : 'Tiếp tục đọc tin công nghệ'}
      </h2>
      <p className="public-auth-copy">
        {register
          ? 'Tạo tài khoản để lưu bài và dùng hỏi đáp có nguồn.'
          : 'Đăng nhập để xem feed, lưu bài và hỏi đáp có nguồn.'}
      </p>
      <AuthAlert error={error} notice={notice} />
      <form id="public-auth-form" className="public-field-group" onSubmit={submit} noValidate>
        <div className="public-field">
          <label htmlFor={emailId}>Email</label>
          <input
            id={emailId}
            name="email"
            className="public-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
            maxLength={254}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? `${emailId}-error` : undefined}
          />
          {errors.email ? (
            <p className="public-field-error" id={`${emailId}-error`}>
              {errors.email}
            </p>
          ) : null}
        </div>
        <div className="public-field">
          <label htmlFor={passwordId}>Mật khẩu</label>
          <input
            id={passwordId}
            name="password"
            className="public-input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={register ? 'new-password' : 'current-password'}
            required
            minLength={8}
            maxLength={128}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? `${passwordId}-error` : undefined}
          />
          {errors.password ? (
            <p className="public-field-error" id={`${passwordId}-error`}>
              {errors.password}
            </p>
          ) : null}
        </div>
        <button
          className="public-btn public-btn-primary public-btn-block"
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {submitLabel}
        </button>
      </form>
      <p className="public-auth-switch">
        {register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?'}{' '}
        <button type="button" onClick={switchMode}>
          {register ? 'Đăng nhập' : 'Tạo tài khoản'}
        </button>
      </p>
      {!register ? (
        <button className="public-auth-guest" type="button" onClick={onGuestBrowse}>
          Tiếp tục như khách →
        </button>
      ) : null}
    </section>
  )
}
