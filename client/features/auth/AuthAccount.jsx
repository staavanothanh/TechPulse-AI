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
    <form className="field-group" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }) }} noValidate>
      <div className="field">
        <label htmlFor="auth-email">Email</label>
        <input className="input" id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" maxLength="254" />
      </div>
      <div className="field">
        <label htmlFor="auth-password">Mật khẩu</label>
        <input className="input" id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength="8" autoComplete="current-password" maxLength="128" />
      </div>
      {error ? <p className="field-error" role="alert">{errorMessage(error)}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Đang xử lý…' : 'Đăng nhập'}</button>
      <p className="auth-switch">Chưa có tài khoản? <button type="button" onClick={onSwitch}>Tạo tài khoản</button></p>
    </form>
  )
}

function RegisterForm({ onSubmit, onSwitch, busy, error }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  return (
    <form className="field-group" onSubmit={(event) => { event.preventDefault(); onSubmit({ email, password }) }} noValidate>
      <div className="field">
        <label htmlFor="auth-email">Email</label>
        <input className="input" id="auth-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" maxLength="254" />
      </div>
      <div className="field">
        <label htmlFor="auth-password">Mật khẩu</label>
        <input className="input" id="auth-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength="8" autoComplete="new-password" maxLength="128" />
      </div>
      {error ? <p className="field-error" role="alert">{errorMessage(error)}</p> : null}
      <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>{busy ? 'Đang tạo…' : 'Tạo tài khoản'}</button>
      <p className="auth-switch">Đã có tài khoản? <button type="button" onClick={onSwitch}>Đăng nhập</button></p>
    </form>
  )
}

const TOPIC_PRESETS = Object.freeze(['AI', 'JavaScript', 'Blockchain', 'DevOps', 'Bảo mật', 'Dữ liệu'])

export default function AuthAccount({ api, initialUser, initialCsrfToken, initialNotice = null, onSession }) {
  const [user, setUser] = useState(initialUser)
  const [csrfToken, setCsrfToken] = useState(initialCsrfToken ?? null)
  const [mode, setMode] = useState('login')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(() => initialNotice ? { status: 401, message: initialNotice } : null)
  const [notice, setNotice] = useState(null)
  const [topics, setTopics] = useState(() => preferenceDraftForUser(initialUser))
  const [deleteBusy, setDeleteBusy] = useState(false)

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

  async function requestDeletion() {
    if (!csrfToken) return
    setDeleteBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api.requestAccountDeletion({ headers: { 'X-CSRF-Token': csrfToken, 'Idempotency-Key': `account-deletion-${Date.now()}` }, credentials: 'same-origin' })
      applySession(null, null, 'Yêu cầu xóa tài khoản đã được chấp nhận. Phiên của bạn đã bị thu hồi.')
    } catch (requestError) {
      handleRequestError(requestError)
    } finally {
      setDeleteBusy(false)
    }
  }

  function toggleTopic(topic) {
    setTopics((current) => current.includes(topic) ? current.filter((item) => item !== topic) : [...current, topic])
  }

  if (!user) return (
    <div className="auth-panel" aria-labelledby="auth-title">
      <p className="eyebrow">TechPulse AI · Đăng nhập</p>
      <h2 id="auth-title">{mode === 'login' ? 'Tiếp tục đọc tin công nghệ' : 'Tạo tài khoản mới'}</h2>
      <p>{mode === 'login' ? 'Đăng nhập để xem feed, lưu bài và hỏi đáp có nguồn.' : 'Đăng ký nhanh, không cần xác minh. Vai trò mặc định là user.'}</p>
      {mode === 'login' ? <LoginForm onSubmit={submit} onSwitch={() => { setMode('register'); setError(null) }} busy={busy} error={error} /> : <RegisterForm onSubmit={submit} onSwitch={() => { setMode('login'); setError(null) }} busy={busy} error={error} />}
    </div>
  )

  return (
    <div className="account-grid" aria-labelledby="account-title">
      <div className="account-card wide">
        <div className="account-head">
          <div>
            <div className="eyebrow">ACCOUNT · {user.role}</div>
            <h2 id="account-title">Chủ đề quan tâm</h2>
            {user.email ? <p className="account-email">{user.email}</p> : null}
          </div>
          <button className="btn btn-ghost" type="button" onClick={logout}>Đăng xuất</button>
        </div>
        <p>Feed sẽ ưu tiên những chủ đề này. Phiên của bạn được giữ trong cookie HttpOnly; CSRF token chỉ tồn tại trong bộ nhớ của giao diện.</p>
        <div className="pref-grid" aria-label="Chủ đề quan tâm">
          {TOPIC_PRESETS.map((topic) => (
            <span key={topic} className={`scope-tag${topics.includes(topic) ? ' active' : ''}`}>
              <button type="button" aria-pressed={topics.includes(topic)} onClick={() => toggleTopic(topic)}>{topic}</button>
            </span>
          ))}
        </div>
        {notice ? <p className="form-success" role="status">{notice}</p> : null}
        {error ? <p className="form-error" role="alert">{errorMessage(error)}</p> : null}
        <button className="btn btn-secondary btn-sm" type="button" disabled={busy} onClick={savePreferences}>{busy ? 'Đang lưu…' : 'Lưu chủ đề'}</button>
      </div>
      <div className="account-card danger-zone">
        <h2>Xóa tài khoản</h2>
        <p>Tạo yêu cầu xóa tự động. Phiên bị thu hồi ngay, dữ liệu được làm sạch theo quy trình.</p>
        <button className="btn btn-danger" type="button" disabled={deleteBusy} onClick={requestDeletion}>{deleteBusy ? 'Đang gửi…' : 'Yêu cầu xóa tài khoản'}</button>
      </div>
    </div>
  )
}
