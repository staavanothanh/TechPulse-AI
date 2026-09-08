import { useCallback, useState } from 'react'
import { PageHeading } from '../components/reader-primitives.jsx'
import { TOPICS } from '../components/reader-format.js'
import { resolveTopic } from '../../../../shared/topic-catalog.js'
import { useDialogFocus } from '../../qa/dialog-focus.js'

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
  notice = null,
  error = null,
}) {
  const [deletionConfirmationOpen, setDeletionConfirmationOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState(null)
  const [passwordSuccess, setPasswordSuccess] = useState(null)
  // hasPassword === false → tài khoản Google-only, cho phép ĐẶT mật khẩu lần đầu
  // mà không cần mật khẩu hiện tại.
  const needsCurrentPassword = user?.hasPassword !== false
  const describePasswordError = (requestError) => {
    if (requestError?.status === 403) return 'Mật khẩu hiện tại không đúng.'
    if (requestError?.status === 422) return 'Mật khẩu mới không hợp lệ (10–128 ký tự).'
    if (requestError?.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    return requestError?.message || 'Không thể đổi mật khẩu. Vui lòng thử lại.'
  }
  const submitPassword = async (event) => {
    event.preventDefault()
    setPasswordError(null)
    setPasswordSuccess(null)
    if (needsCurrentPassword && !currentPassword) {
      setPasswordError('Vui lòng nhập mật khẩu hiện tại.')
      return
    }
    if (newPassword.length < 10 || newPassword.length > 128) {
      setPasswordError('Mật khẩu mới phải từ 10 đến 128 ký tự.')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('Mật khẩu xác nhận không khớp.')
      return
    }
    setPasswordSubmitting(true)
    try {
      await onChangePassword?.(needsCurrentPassword ? { currentPassword, newPassword } : { newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordSuccess(needsCurrentPassword ? 'Đổi mật khẩu thành công.' : 'Đặt mật khẩu thành công.')
    } catch (requestError) {
      setPasswordError(describePasswordError(requestError))
    } finally {
      setPasswordSubmitting(false)
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
        <section className="public-account-card public-account-security">
          <h2>{needsCurrentPassword ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}</h2>
          <p>
            {needsCurrentPassword
              ? 'Đặt mật khẩu mới. Sau khi đổi, các thiết bị khác sẽ bị đăng xuất.'
              : 'Tài khoản của bạn đang đăng nhập bằng Google. Đặt mật khẩu để có thể đăng nhập bằng email.'}
          </p>
          <form className="public-password-form public-field-group" onSubmit={submitPassword} noValidate>
            {needsCurrentPassword ? (
              <div className="public-field">
                <label htmlFor="account-current-password">Mật khẩu hiện tại</label>
                <input
                  id="account-current-password"
                  name="currentPassword"
                  className="public-input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                />
              </div>
            ) : null}
            <div className="public-field">
              <label htmlFor="account-new-password">Mật khẩu mới</label>
              <input
                id="account-new-password"
                name="newPassword"
                className="public-input"
                type="password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </div>
            <div className="public-field">
              <label htmlFor="account-confirm-password">Xác nhận mật khẩu mới</label>
              <input
                id="account-confirm-password"
                name="confirmPassword"
                className="public-input"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </div>
            {passwordError ? (
              <p className="public-field-error" role="alert">
                {passwordError}
              </p>
            ) : null}
            {passwordSuccess ? (
              <p className="public-form-success" role="status">
                {passwordSuccess}
              </p>
            ) : null}
            <button
              className="public-btn public-btn-secondary"
              type="submit"
              disabled={passwordSubmitting}
            >
              {passwordSubmitting
                ? 'Đang lưu...'
                : needsCurrentPassword
                  ? 'Đổi mật khẩu'
                  : 'Đặt mật khẩu'}
            </button>
          </form>
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
