import { useState } from 'react'
import { PageHeading } from '../components/reader-primitives.jsx'
import { TOPICS } from '../components/reader-format.js'
import { resolveTopic } from '../../../../shared/topic-catalog.js'

export default function AccountView({
  user = null,
  topics = TOPICS,
  onToggleTopic,
  onSavePreferences,
  onRequestDeletion,
  onLogout,
  saving = false,
  deleting = false,
  notice = null,
  error = null,
}) {
  const [deletionConfirmationOpen, setDeletionConfirmationOpen] = useState(false)
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
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-delete-account-title"
          >
            <p className="public-eyebrow">Xác nhận yêu cầu</p>
            <h2 id="public-delete-account-title">Yêu cầu xóa tài khoản?</h2>
            <p>
              Phiên hiện tại sẽ bị thu hồi và quy trình làm sạch dữ liệu sẽ bắt đầu. Thao tác này
              không thể hoàn tác.
            </p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={() => setDeletionConfirmationOpen(false)}
              >
                Quay lại
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                disabled={deleting}
                onClick={() => {
                  setDeletionConfirmationOpen(false)
                  void onRequestDeletion?.()
                }}
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
