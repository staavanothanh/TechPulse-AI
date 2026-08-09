import { useState } from 'react'
import { preferenceDraftForUser, SESSION_EXPIRED_MESSAGE, sessionExpiredNotice, validateTopicPreferences } from './session-state.js'

function errorMessage(error) {
  if (error?.status === 401) return SESSION_EXPIRED_MESSAGE
  if (error?.status === 429) return 'Bạn thao tác quá nhanh. Hãy thử lại sau ít phút.'
  return error?.message ?? 'Không thể hoàn tất yêu cầu.'
}

function LoginForm({ onSubmit, onSwitch, busy, error }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }) }}>
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
      <label>Mật khẩu<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required autoComplete="current-password" /></label>
      {error ? <p className="form-error" role="alert">{errorMessage(error)}</p> : null}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Đang xử lý…' : 'Đăng nhập'}</button>
      <button className="text-button" type="button" onClick={onSwitch}>Tạo tài khoản mới</button>
    </form>
  )
}

function RegisterForm({ onSubmit, onSwitch, busy, error }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form className="auth-form" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }) }}>
      <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label>
      <label>Mật khẩu<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength="10" autoComplete="new-password" /></label>
      {error ? <p className="form-error" role="alert">{errorMessage(error)}</p> : null}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo tài khoản'}</button>
      <button className="text-button" type="button" onClick={onSwitch}>Tôi đã có tài khoản</button>
    </form>
  )
}

export default function AuthAccount({ api, initialUser, initialCsrfToken, initialNotice = null, onSession }) {
  const [user, setUser] = useState(initialUser)
  const [csrfToken, setCsrfToken] = useState(initialCsrfToken ?? null)
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => initialNotice ? { status: 401, message: initialNotice } : null)
  const [notice, setNotice] = useState(null)
  const [topics, setTopics] = useState(() => preferenceDraftForUser(initialUser))

  function applySession(nextUser, nextCsrfToken, sessionNotice = null) {
    setUser(nextUser ?? null)
    setCsrfToken(nextCsrfToken ?? null)
    setTopics(preferenceDraftForUser(nextUser))
    onSession(nextUser ?? null, nextCsrfToken ?? null, sessionNotice)
  }

  function handleRequestError(requestError) {
    setNotice(null)
    const expiredNotice = sessionExpiredNotice(requestError)
    setError(requestError)
    if (expiredNotice) applySession(null, null, expiredNotice)
  }

  async function submit(credentials) {
    setBusy(true)
    setError(null)
    try {
      const response = mode === 'login' ? await api.login({ body: JSON.stringify(credentials), headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' }) : await api.registerUser({ body: JSON.stringify(credentials), headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin' })
      applySession(response.data.user, response.data.csrfToken)
    } catch (requestError) {
      handleRequestError(requestError)
    } finally {
      setBusy(false)
    }
  }

  async function savePreferences() {
    const draft = validateTopicPreferences(topics)
    if (!draft.valid || !csrfToken) {
      setError({ status: 422, message: 'Chủ đề quan tâm không hợp lệ.' })
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await api.updatePreferences({ body: JSON.stringify({ topicPreferences: draft.topics }), headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, credentials: 'same-origin' })
      applySession(response.data, csrfToken)
      setNotice('Đã lưu chủ đề quan tâm.')
    } catch (requestError) {
      handleRequestError(requestError)
    } finally {
      setBusy(false)
    }
  }

  async function logout() {
    if (!csrfToken) return
    try {
      await api.logout({ headers: { 'X-CSRF-Token': csrfToken }, credentials: 'same-origin' })
    } catch (requestError) {
      handleRequestError(requestError)
      return
    }
    applySession(null, null)
  }

  if (!user) return (
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="eyebrow">STEP 02 · ACCOUNT</div>
      <h1 id="auth-title">Đọc tin có ngữ cảnh, giữ quyền kiểm soát.</h1>
      <p className="hero-copy">Đăng nhập để lưu chủ đề yêu thích và nhận phiên làm việc an toàn bằng cookie.</p>
      {mode === 'login' ? <LoginForm onSubmit={submit} onSwitch={() => { setMode('register'); setError(null) }} busy={busy} error={error} /> : <RegisterForm onSubmit={submit} onSwitch={() => { setMode('login'); setError(null) }} busy={busy} error={error} />}
    </section>
  )

  return (
    <section className="auth-card" aria-labelledby="account-title">
      <div className="eyebrow">ACCOUNT · {user.role}</div>
      <h1 id="account-title">Xin chào, {user.email}</h1>
      <p className="hero-copy">Phiên của bạn được giữ trong cookie HttpOnly; CSRF token chỉ tồn tại trong bộ nhớ của giao diện.</p>
      <form className="auth-form" onSubmit={(event) => { event.preventDefault(); savePreferences() }}>
        <label htmlFor="topic-preferences">Chủ đề quan tâm<input id="topic-preferences" value={topics.join(', ')} onChange={(event) => setTopics(event.target.value.split(',').map((topic) => topic.trim()).filter(Boolean))} placeholder="AI, Robot, Web" /></label>
        <div className="account-actions"><button className="primary-button" type="submit" disabled={busy}>Lưu chủ đề</button><button className="text-button" type="button" onClick={logout}>Đăng xuất</button></div>
      </form>
      {notice ? <p className="form-success" role="status">{notice}</p> : null}
      {error ? <p className="form-error" role="alert">{errorMessage(error)}</p> : null}
    </section>
  )
}
