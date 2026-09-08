import { useCallback, useState } from 'react'
import { PageHeading } from '../components/reader-primitives.jsx'
import { TOPICS } from '../components/reader-format.js'
import { resolveTopic } from '../../../../shared/topic-catalog.js'
import { useDialogFocus } from '../../qa/dialog-focus.js'

function mapPasswordError(err) {
  const msg = err?.message || ''
  if (msg.includes('Current password is incorrect')) return 'Mật khẩu hiện tại không chính xác.'
  if (msg.includes('New password must be different')) return 'Mật khẩu mới không được trùng mật khẩu hiện tại.'
  if (msg.includes('between 10 and 128')) return 'Mật khẩu mới phải có ít nhất 10 ký tự.'
  if (msg.includes('Google OAuth')) return 'Tài khoản Google không sử dụng mật khẩu riêng.'
  if (msg.includes('Session is invalid') || msg.includes('Session is no longer active')) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
  if (msg.includes('rate limit') || err?.status === 429) return 'Bạn đã thử quá số lần quy định. Vui lòng đợi ít phút rồi thử lại.'
  if (msg.includes('API request failed') || err?.status === 404) return 'Máy chủ backend chưa nhận API đổi mật khẩu mới (404). Vui lòng restart lệnh "npm run dev" trong terminal để máy chủ nạp route mới.'
  if (msg.includes('unavailable') || msg.includes('not configured') || err?.status === 503) return 'Dịch vụ xác thực đang tạm thời không khả dụng (503). Vui lòng restart lệnh "npm run dev" trong terminal để hoàn tất nạp cấu hình mới.'
  return msg || 'Đổi mật khẩu không thành công. Vui lòng thử lại.'
}

export default function AccountView({
  user = null,
  topics = TOPICS,
  onToggleTopic,
  onSavePreferences,
  onRequestDeletion,
  onChangePassword,
  onLogout,
  saving = false,
  deleting = false,
  changingPassword = false,
  notice = null,
  error = null,
  initialPasswordDialogOpen = false,
}) {
  const [deletionConfirmationOpen, setDeletionConfirmationOpen] = useState(false)
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(initialPasswordDialogOpen)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLocalError, setPasswordLocalError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')

  const isGoogleAccount = Boolean(user?.googleSub)

  const closePasswordDialog = useCallback(() => {
    setPasswordDialogOpen(false)
    setPasswordLocalError('')
  }, [])
  const openPasswordDialog = useCallback(() => {
    setPasswordDialogOpen(true)
    setPasswordLocalError('')
    setPasswordSuccess('')
    setCurrentPassword('')
    setNewPassword('')
    setConfirmPassword('')
  }, [])
  const passwordDialogRef = useDialogFocus(passwordDialogOpen, closePasswordDialog)

  const handlePasswordSubmit = async (event) => {
    event.preventDefault()
    setPasswordLocalError('')
    setPasswordSuccess('')
    if (!currentPassword) {
      setPasswordLocalError('Vui lòng nhập mật khẩu hiện tại.')
      return
    }
    if (!newPassword || newPassword.length < 10) {
      setPasswordLocalError('Mật khẩu mới phải có ít nhất 10 ký tự.')
      return
    }
    if (newPassword.length > 128) {
      setPasswordLocalError('Mật khẩu mới không được vượt quá 128 ký tự.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordLocalError('Mật khẩu xác nhận không khớp.')
      return
    }
    if (newPassword === currentPassword) {
      setPasswordLocalError('Mật khẩu mới không được trùng mật khẩu hiện tại.')
      return
    }
    try {
      await onChangePassword?.({ currentPassword, newPassword })
      closePasswordDialog()
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordSuccess('Đổi mật khẩu thành công. Đang chuyển hướng đăng nhập...')
    } catch (err) {
      setPasswordLocalError(mapPasswordError(err))
    }
  }

  const closeDeletionConfirmation = useCallback(() => setDeletionConfirmationOpen(false), [])
  const confirmDeletion = useCallback(() => {
    closeDeletionConfirmation()
    void onRequestDeletion?.()
  }, [closeDeletionConfirmation, onRequestDeletion])
  const deletionDialogRef = useDialogFocus(deletionConfirmationOpen, closeDeletionConfirmation)
  const selected = Array.isArray(user?.topicPreferences) ? user.topicPreferences : []
  const baseOptions = Array.isArray(topics) ? topics : TOPICS
  const isTopicSelected = (topic) => {
    const topicResolved = resolveTopic(topic)
    return selected.some((item) => {
      if (item === topic) return true
      const itemResolved = resolveTopic(item)
      return (
        Boolean(topicResolved.canonicalId) &&
        Boolean(itemResolved.canonicalId) &&
        topicResolved.canonicalId === itemResolved.canonicalId
      )
    })
  }
  const unknownSelected = selected.filter(
    (item) => !baseOptions.some((opt) => opt === item || (resolveTopic(opt).canonicalId && resolveTopic(opt).canonicalId === resolveTopic(item).canonicalId))
  )
  const options = [...baseOptions, ...unknownSelected]
  return (
    <section
      className="public-view public-account-view"
      aria-labelledby="public-account-title"
      data-od-id="account"
    >
      <PageHeading
        id="public-account-title"
        eyebrow="Tài khoản"
        title="Cài đặt tài khoản"
        copy="Quản lý chủ đề, lịch sử và dữ liệu cá nhân."
      />
      <div className="public-account-grid">
        <section className="public-account-card public-account-card-wide">
          <div className="public-account-head">
            <div>
              <h2>Chủ đề quan tâm</h2>
              {user?.email ? <p className="public-account-email">{user.email}</p> : null}
            </div>
            {onLogout ? (
              <button className="public-btn public-btn-ghost" type="button" onClick={onLogout}>
                Đăng xuất
              </button>
            ) : null}
          </div>
          <p>Feed có thể ưu tiên những chủ đề này.</p>
          <div className="public-topic-row public-preference-grid" aria-label="Chủ đề quan tâm">
            {options.map((topic) => {
              const active = isTopicSelected(topic)
              return (
                <button
                  key={topic}
                  type="button"
                  aria-pressed={active}
                  className={active ? 'active' : ''}
                  onClick={() => onToggleTopic?.(topic)}
                >
                  {topic}
                </button>
              )
            })}
          </div>
          {notice ? (
            <p className="public-form-success" role="status">
              {notice}
            </p>
          ) : null}
          {error ? (
            <p className="public-field-error" role="alert">
              {typeof error === 'string' ? error : error.message}
            </p>
          ) : null}
          <button
            className="public-btn public-btn-secondary"
            type="button"
            disabled={saving}
            onClick={() => onSavePreferences?.(selected)}
          >
            {saving ? 'Đang lưu...' : 'Lưu chủ đề'}
          </button>
        </section>
        <section className="public-account-card">
          <h2>Bảo mật tài khoản</h2>
          {isGoogleAccount ? (
            <p>Tài khoản này được đăng nhập bằng Google nên không sử dụng mật khẩu riêng.</p>
          ) : (
            <>
              <p>
                Đổi mật khẩu định kỳ giúp bảo vệ tài khoản và thông tin cá nhân của bạn an toàn hơn.
              </p>
              {passwordSuccess ? (
                <p className="public-form-success" role="status">
                  {passwordSuccess}
                </p>
              ) : null}
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={openPasswordDialog}
              >
                Đổi mật khẩu
              </button>
            </>
          )}
        </section>
        <section className="public-account-card public-danger-zone">
          <h2>Quản lý dữ liệu</h2>
          <p>
            Yêu cầu xóa tài khoản sẽ thu hồi phiên hiện tại và bắt đầu quy trình làm sạch dữ liệu.
          </p>
          <button
            className="public-btn public-btn-danger"
            type="button"
            disabled={deleting}
            onClick={() => setDeletionConfirmationOpen(true)}
          >
            {deleting ? 'Đang gửi...' : 'Yêu cầu xóa tài khoản'}
          </button>
        </section>
      </div>
      {passwordDialogOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={passwordDialogRef}
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-change-password-title"
            tabIndex={-1}
          >
            <p className="public-eyebrow">Bảo mật</p>
            <h2 id="public-change-password-title">Đổi mật khẩu</h2>
            <form onSubmit={handlePasswordSubmit} className="public-field-group" noValidate>
              <div className="public-field">
                <label htmlFor="current-password-input">Mật khẩu hiện tại</label>
                <input
                  id="current-password-input"
                  name="currentPassword"
                  type="password"
                  className="public-input"
                  value={currentPassword}
                  onChange={(event) => {
                    setCurrentPassword(event.target.value)
                    setPasswordLocalError('')
                  }}
                  autoComplete="current-password"
                  required
                />
              </div>
              <div className="public-field">
                <label htmlFor="new-password-input">Mật khẩu mới</label>
                <input
                  id="new-password-input"
                  name="newPassword"
                  type="password"
                  className="public-input"
                  placeholder="Tối thiểu 10 ký tự"
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value)
                    setPasswordLocalError('')
                  }}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={128}
                />
              </div>
              <div className="public-field">
                <label htmlFor="confirm-password-input">Xác nhận mật khẩu mới</label>
                <input
                  id="confirm-password-input"
                  name="confirmPassword"
                  type="password"
                  className="public-input"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value)
                    setPasswordLocalError('')
                  }}
                  autoComplete="new-password"
                  required
                  minLength={10}
                  maxLength={128}
                />
              </div>
              {passwordLocalError ? (
                <p className="public-field-error" role="alert">
                  {passwordLocalError}
                </p>
              ) : null}
              <div className="public-dialog-actions">
                <button
                  className="public-btn public-btn-secondary"
                  type="button"
                  onClick={closePasswordDialog}
                  disabled={changingPassword}
                >
                  Hủy
                </button>
                <button
                  className="public-btn public-btn-primary"
                  type="submit"
                  disabled={changingPassword}
                >
                  {changingPassword ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
      {deletionConfirmationOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={deletionDialogRef}
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-delete-account-title"
            aria-describedby="public-delete-account-description"
            tabIndex={-1}
          >
            <p className="public-eyebrow">Xác nhận yêu cầu</p>
            <h2 id="public-delete-account-title">Yêu cầu xóa tài khoản?</h2>
            <p id="public-delete-account-description">
              Phiên hiện tại sẽ bị thu hồi và quy trình làm sạch dữ liệu sẽ bắt đầu. Thao tác này
              không thể hoàn tác.
            </p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={closeDeletionConfirmation}
              >
                Quay lại
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                disabled={deleting}
                onClick={confirmDeletion}
              >
                {deleting ? 'Đang gửi...' : 'Xác nhận xóa'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

export { AccountView }
