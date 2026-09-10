import { useCallback, useEffect, useRef, useState } from 'react'
import { PageHeading } from '../components/reader-primitives.jsx'
import { ALL_TOPICS, GROUPED_TOPICS, TOPICS } from '../components/reader-format.js'
import { resolveTopic } from '../../../../shared/topic-catalog.js'
import { useDialogFocus } from '../../qa/dialog-focus.js'

export default function AccountView({
  user = null,
  topics = ALL_TOPICS,
  onToggleTopic,
  onClearTopics,
  onSavePreferences,
  onRequestDeletion,
  onChangePassword,
  onLogout,
  saving = false,
  deleting = false,
  notice = null,
  error = null,
  initialPasswordOpen = false,
  initialPasswordSuccessOpen = false,
  initialDeletionOpen = false,
}) {
  const isGoogleUser = user?.hasPassword === false || user?.authProvider === 'google' || Boolean(user?.isGoogle)
  const [showPasswordForm, setShowPasswordForm] = useState(!isGoogleUser && initialPasswordOpen)
  const [passwordSuccessOpen, setPasswordSuccessOpen] = useState(!isGoogleUser && initialPasswordSuccessOpen)
  const COUNTDOWN_SECONDS = 5
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)
  const countdownIntervalRef = useRef(null)

  const DELETION_COUNTDOWN_SECONDS = 5
  const [deletionConfirmationOpen, setDeletionConfirmationOpen] = useState(!isGoogleUser && initialDeletionOpen)
  const [deletionVerifyEmail, setDeletionVerifyEmail] = useState('')
  const [deletionRiskConfirmed, setDeletionRiskConfirmed] = useState(false)
  const [deletionSafetyCountdown, setDeletionSafetyCountdown] = useState(DELETION_COUNTDOWN_SECONDS)
  const deletionCountdownIntervalRef = useRef(null)

  const [topicSearch, setTopicSearch] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)
  const [passwordError, setPasswordError] = useState(null)
  // hasPassword === false → tài khoản Google-only, cho phép ĐẶT mật khẩu lần đầu
  // mà không cần mật khẩu hiện tại.
  const needsCurrentPassword = user?.hasPassword !== false
  const successNotice = needsCurrentPassword
    ? 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.'
    : 'Đặt mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.'
  const describePasswordError = (requestError) => {
    if (requestError?.code === 'csrf_invalid') return 'Phiên bảo mật đã thay đổi. Vui lòng tải lại trang rồi thử lại.'
    if (requestError?.code === 'google_reauth_required') return 'Vui lòng đăng nhập lại bằng Google rồi thử đặt mật khẩu.'
    if (requestError?.status === 403) return 'Mật khẩu hiện tại không đúng.'
    if (requestError?.status === 422) return 'Mật khẩu mới không hợp lệ (10–128 ký tự).'
    if (requestError?.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'
    return requestError?.message || 'Không thể đổi mật khẩu. Vui lòng thử lại.'
  }
  const handleLogoutNow = useCallback(() => {
    if (countdownIntervalRef.current) {
      globalThis.clearInterval(countdownIntervalRef.current)
      countdownIntervalRef.current = null
    }
    setPasswordSuccessOpen(false)
    if (typeof onLogout === 'function') {
      onLogout(successNotice)
    }
  }, [onLogout, successNotice])

  const closePasswordSuccessDialog = useCallback(() => {
    handleLogoutNow()
  }, [handleLogoutNow])
  const passwordSuccessDialogRef = useDialogFocus(passwordSuccessOpen, closePasswordSuccessDialog)

  useEffect(() => {
    if (!passwordSuccessOpen) {
      if (countdownIntervalRef.current) {
        globalThis.clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
      return undefined
    }

    countdownIntervalRef.current = globalThis.setInterval(() => {
      setCountdown((current) => {
        if (current <= 1) {
          if (countdownIntervalRef.current) {
            globalThis.clearInterval(countdownIntervalRef.current)
            countdownIntervalRef.current = null
          }
          handleLogoutNow()
          return 0
        }
        return current - 1
      })
    }, 1000)

    return () => {
      if (countdownIntervalRef.current) {
        globalThis.clearInterval(countdownIntervalRef.current)
        countdownIntervalRef.current = null
      }
    }
  }, [passwordSuccessOpen, handleLogoutNow])

  const submitPassword = async (event) => {
    event.preventDefault()
    setPasswordError(null)
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
      setShowPasswordForm(false)
      setCountdown(COUNTDOWN_SECONDS)
      setPasswordSuccessOpen(true)
    } catch (requestError) {
      setPasswordError(describePasswordError(requestError))
    } finally {
      setPasswordSubmitting(false)
    }
  }

  const handleOpenDeletion = () => {
    setDeletionVerifyEmail('')
    setDeletionRiskConfirmed(false)
    setDeletionSafetyCountdown(DELETION_COUNTDOWN_SECONDS)
    setDeletionConfirmationOpen(true)
  }

  const closeDeletionConfirmation = useCallback(() => {
    if (deletionCountdownIntervalRef.current) {
      globalThis.clearInterval(deletionCountdownIntervalRef.current)
      deletionCountdownIntervalRef.current = null
    }
    setDeletionConfirmationOpen(false)
    setDeletionVerifyEmail('')
    setDeletionRiskConfirmed(false)
    setDeletionSafetyCountdown(DELETION_COUNTDOWN_SECONDS)
  }, [DELETION_COUNTDOWN_SECONDS])

  const confirmDeletion = useCallback(() => {
    closeDeletionConfirmation()
    void onRequestDeletion?.()
  }, [closeDeletionConfirmation, onRequestDeletion])

  const deletionDialogRef = useDialogFocus(deletionConfirmationOpen, closeDeletionConfirmation)

  useEffect(() => {
    if (!deletionConfirmationOpen) {
      if (deletionCountdownIntervalRef.current) {
        globalThis.clearInterval(deletionCountdownIntervalRef.current)
        deletionCountdownIntervalRef.current = null
      }
      return undefined
    }

    deletionCountdownIntervalRef.current = globalThis.setInterval(() => {
      setDeletionSafetyCountdown((current) => {
        if (current <= 1) {
          if (deletionCountdownIntervalRef.current) {
            globalThis.clearInterval(deletionCountdownIntervalRef.current)
            deletionCountdownIntervalRef.current = null
          }
          return 0
        }
        return current - 1
      })
    }, 1000)

    return () => {
      if (deletionCountdownIntervalRef.current) {
        globalThis.clearInterval(deletionCountdownIntervalRef.current)
        deletionCountdownIntervalRef.current = null
      }
    }
  }, [deletionConfirmationOpen])

  const targetEmail = (user?.email || '').trim().toLowerCase()
  const isEmailMatched = targetEmail
    ? deletionVerifyEmail.trim().toLowerCase() === targetEmail
    : true
  const canConfirmDeletion =
    !deleting &&
    deletionSafetyCountdown === 0 &&
    isEmailMatched &&
    deletionRiskConfirmed

  const selected = Array.isArray(user?.topicPreferences) ? user.topicPreferences : []
  const isDefaultCatalog = !topics || topics === ALL_TOPICS || topics === TOPICS
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

  const handleClearAll = () => {
    if (typeof onClearTopics === 'function') {
      onClearTopics()
    } else {
      for (const item of [...selected]) {
        onToggleTopic?.(item)
      }
    }
  }

  // Phân nhánh hiển thị: danh mục chuẩn (22 chủ đề phân 8 nhóm) hoặc danh sách tùy chỉnh phẳng
  const normalizedSearch = topicSearch.trim().toLowerCase()
  const unknownSelected = selected.filter(
    (item) => !ALL_TOPICS.some((opt) => opt === item || (resolveTopic(opt).canonicalId && resolveTopic(opt).canonicalId === resolveTopic(item).canonicalId))
  )
  const filteredGroups = GROUPED_TOPICS.map((group) => {
    const items = group.items.filter((item) => {
      if (!normalizedSearch) return true
      return (
        item.label.toLowerCase().includes(normalizedSearch) ||
        group.label.toLowerCase().includes(normalizedSearch)
      )
    })
    return items.length > 0 ? { ...group, items } : null
  }).filter(Boolean)

  const customItems = unknownSelected
    .filter((item) => !normalizedSearch || item.toLowerCase().includes(normalizedSearch))
    .map((item) => ({ id: item, label: item, isCustom: true }))

  const baseOptions = Array.isArray(topics) ? topics : ALL_TOPICS
  const unknownCustomSelected = selected.filter(
    (item) => !baseOptions.some((opt) => opt === item || (resolveTopic(opt).canonicalId && resolveTopic(opt).canonicalId === resolveTopic(item).canonicalId))
  )
  const flatOptions = [...baseOptions, ...unknownCustomSelected]

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
              <button className="public-btn public-btn-ghost" type="button" onClick={() => onLogout()}>
                Đăng xuất
              </button>
            ) : null}
          </div>
          <p>Feed có thể ưu tiên những chủ đề này (tối đa 20 chủ đề).</p>

          <div className="public-preference-toolbar">
            <div className="public-preference-meta">
              <span className="public-preference-count">
                Đã chọn: <strong>{selected.length}</strong>/20 chủ đề
              </span>
              {selected.length > 0 ? (
                <button
                  className="public-text-action public-topic-clear-btn"
                  type="button"
                  title="Bỏ chọn tất cả chủ đề"
                  onClick={handleClearAll}
                >
                  Bỏ chọn hết
                </button>
              ) : null}
            </div>
            {isDefaultCatalog ? (
              <div className="public-topic-search-wrap public-preference-search">
                <input
                  type="search"
                  className="public-input public-topic-search-input"
                  placeholder="Tìm trong 22 chủ đề..."
                  value={topicSearch}
                  onChange={(event) => setTopicSearch(event.target.value)}
                  aria-label="Tìm kiếm chủ đề quan tâm"
                />
                {topicSearch ? (
                  <button
                    className="public-topic-search-clear"
                    type="button"
                    onClick={() => setTopicSearch('')}
                    aria-label="Xóa tìm kiếm"
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {isDefaultCatalog ? (
            <div className="public-preference-groups" aria-label="Chủ đề quan tâm">
              {filteredGroups.length === 0 && customItems.length === 0 ? (
                <p className="public-topic-empty">Không tìm thấy chủ đề nào phù hợp.</p>
              ) : (
                filteredGroups.map((group) => (
                  <div key={group.id} className="public-preference-group">
                    <div className="public-preference-group-header">
                      <span className="public-preference-group-title">{group.label}</span>
                    </div>
                    <div className="public-topic-row public-preference-grid">
                      {group.items.map((item) => {
                        const active = isTopicSelected(item.label)
                        return (
                          <button
                            key={item.id}
                            type="button"
                            aria-pressed={active}
                            className={active ? 'active' : ''}
                            onClick={() => onToggleTopic?.(item.label)}
                          >
                            {item.label}{item.isParent ? <span className="public-topic-parent-tag">Chính</span> : null}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                ))
              )}
              {customItems.length > 0 ? (
                <div className="public-preference-group">
                  <div className="public-preference-group-header">
                    <span className="public-preference-group-title">Chủ đề khác</span>
                  </div>
                  <div className="public-topic-row public-preference-grid">
                    {customItems.map((item) => {
                      const active = isTopicSelected(item.label)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-pressed={active}
                          className={active ? 'active' : ''}
                          onClick={() => onToggleTopic?.(item.label)}
                        >
                          {item.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="public-topic-row public-preference-grid" aria-label="Chủ đề quan tâm">
              {flatOptions.map((topic) => {
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
          )}

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
        {!isGoogleUser ? (
          <section className="public-account-card public-account-security">
            <h2>{needsCurrentPassword ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}</h2>
            <p>
              {needsCurrentPassword
                ? 'Đặt mật khẩu mới. Sau khi đổi thành công, hệ thống sẽ tự động đăng xuất để bạn đăng nhập lại bằng mật khẩu mới.'
                : 'Tài khoản của bạn đang đăng nhập bằng Google. Đặt mật khẩu để có thể đăng nhập bằng email.'}
            </p>
            {!showPasswordForm ? (
              <div>
                <button
                  className="public-btn public-btn-secondary"
                  type="button"
                  onClick={() => {
                    setShowPasswordForm(true)
                    setPasswordError(null)
                  }}
                >
                  {needsCurrentPassword ? 'Đổi mật khẩu' : 'Đặt mật khẩu'}
                </button>
              </div>
            ) : (
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
                <div className="public-password-actions">
                  <button
                    className="public-btn public-btn-secondary"
                    type="submit"
                    disabled={passwordSubmitting}
                  >
                    {passwordSubmitting ? 'Đang lưu...' : 'Xác nhận'}
                  </button>
                  <button
                    className="public-btn public-btn-ghost"
                    type="button"
                    disabled={passwordSubmitting}
                    onClick={() => {
                      setShowPasswordForm(false)
                      setPasswordError(null)
                      setCurrentPassword('')
                      setNewPassword('')
                      setConfirmPassword('')
                    }}
                  >
                    Hủy
                  </button>
                </div>
              </form>
            )}
          </section>
        ) : null}
        {!isGoogleUser ? (
          <section className="public-account-card public-danger-zone">
            <h2>Quản lý dữ liệu</h2>
            <p>
              Yêu cầu xóa tài khoản sẽ thu hồi phiên hiện tại và bắt đầu quy trình làm sạch dữ liệu.
            </p>
            <button
              className="public-btn public-btn-danger"
              type="button"
              disabled={deleting}
              onClick={handleOpenDeletion}
            >
              {deleting ? 'Đang gửi...' : 'Yêu cầu xóa tài khoản'}
            </button>
          </section>
        ) : null}
      </div>
      {!isGoogleUser && deletionConfirmationOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={deletionDialogRef}
            className="public-dialog public-deletion-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-delete-account-title"
            aria-describedby="public-delete-account-description"
            tabIndex={-1}
          >
            <p className="public-eyebrow">Xác nhận yêu cầu</p>
            <h2 id="public-delete-account-title">Yêu cầu xóa tài khoản?</h2>

            <div className="public-deletion-warning-box" role="alert">
              <strong>Cảnh báo quan trọng:</strong> Thao tác này sẽ xóa vĩnh viễn tài khoản của bạn khỏi hệ thống. Toàn bộ lịch sử đọc, đánh dấu và dữ liệu cá nhân sẽ bị hủy và không thể khôi phục.
            </div>

            <p id="public-delete-account-description" className="public-deletion-prompt">
              {user?.email ? (
                <>
                  Để xác nhận, vui lòng nhập chính xác địa chỉ email của bạn:{' '}
                  <strong className="public-deletion-email-target">{user.email}</strong>
                </>
              ) : (
                'Vui lòng xác nhận để tiếp tục quy trình xóa tài khoản.'
              )}
            </p>

            {user?.email ? (
              <div className="public-field">
                <label htmlFor="account-deletion-email">Xác nhận email</label>
                <input
                  id="account-deletion-email"
                  name="deletionVerifyEmail"
                  className="public-input"
                  type="email"
                  placeholder={user.email}
                  value={deletionVerifyEmail}
                  onChange={(event) => setDeletionVerifyEmail(event.target.value)}
                  autoComplete="off"
                  disabled={deleting}
                />
              </div>
            ) : null}

            <div className="public-deletion-checkbox-wrap">
              <label className="public-checkbox-label" htmlFor="account-deletion-risk-confirm">
                <input
                  id="account-deletion-risk-confirm"
                  name="deletionRiskConfirmed"
                  type="checkbox"
                  checked={deletionRiskConfirmed}
                  onChange={(event) => setDeletionRiskConfirmed(event.target.checked)}
                  disabled={deleting}
                />
                <span>Tôi hiểu và đồng ý xóa vĩnh viễn tài khoản này cùng toàn bộ dữ liệu liên quan.</span>
              </label>
            </div>

            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                disabled={deleting}
                onClick={closeDeletionConfirmation}
              >
                Quay lại
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                disabled={!canConfirmDeletion}
                onClick={confirmDeletion}
              >
                {deleting
                  ? 'Đang gửi...'
                  : deletionSafetyCountdown > 0
                    ? `Xác nhận xóa (${deletionSafetyCountdown}s)`
                    : 'Xác nhận xóa'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {!isGoogleUser && passwordSuccessOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={passwordSuccessDialogRef}
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-password-success-title"
            aria-describedby="public-password-success-description"
            tabIndex={-1}
          >
            <p className="public-eyebrow">Thông báo</p>
            <h2 id="public-password-success-title">
              {needsCurrentPassword ? 'Đổi mật khẩu thành công!' : 'Đặt mật khẩu thành công!'}
            </h2>
            <p id="public-password-success-description">
              Mật khẩu của bạn đã được cập nhật thành công. Hệ thống sẽ tự động đăng xuất sau{' '}
              <strong className="public-countdown-highlight">{countdown} giây</strong> để bạn đăng nhập lại bằng mật khẩu mới.
            </p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-primary"
                type="button"
                onClick={handleLogoutNow}
              >
                {`Đăng xuất ngay (${countdown}s)`}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

export { AccountView }
