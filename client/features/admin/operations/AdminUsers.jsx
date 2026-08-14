import { useState } from 'react'
import { normalizeAdminFailure } from './admin-utils.js'
import {
  AdminConfirmationDialog,
  AdminListControls,
  FailureNotice,
  LoadingState,
  RecordTable,
} from './admin-shared.jsx'
import { formatDate, statusLabel, useRetryAfterCooldown } from './admin-helpers.js'

export default function AdminUsers({ data, state, failure, onRetry, adminApi, csrfToken, onNavigate, query, onQueryChange, loadingMore, onLoadMore }) {
  const rows = data?.data ?? []
  const [selectedUser, setSelectedUser] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [busyId, setBusyId] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const changeStatus = async () => {
    const user = confirmation?.user
    if (!adminApi?.updateUserStatus || !csrfToken) return
    const status = user.status === 'suspended' ? 'active' : 'suspended'
    setBusyId(user.id)
    try {
      await adminApi.updateUserStatus({
        pathParams: { userId: user.id },
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({
          status,
          reasonCode: status === 'active' ? 'user_restored' : 'user_suspended',
        }),
      })
      setConfirmation(null)
      setConfirmationError(null)
      onRetry()
    } catch (error) {
      setRetryAfter(Number.isSafeInteger(error?.retryAfter) ? error.retryAfter : 0)
      setConfirmationError(normalizeAdminFailure(error).message)
    } finally {
      setBusyId(null)
    }
  }
  if (state === 'loading') return <LoadingState label="Đang tải người dùng…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">AUTH-005 · SAFE USER LIFECYCLE</span>
          <h1>Người dùng</h1>
          <p>Deleted identity luôn hiển thị null; suspend thu hồi session ở server.</p>
        </div>
        <div className="admin-record-actions">
          <button type="button" className="admin-button" onClick={onRetry}>
            Làm mới
          </button>
          <button type="button" className="admin-button" onClick={() => onNavigate?.('deletions')}>
            Theo dõi xóa tài khoản
          </button>
        </div>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls
          query={query}
          fields={[
            ['status', 'Trạng thái', ['active', 'suspended', 'deleted']],
            ['email', 'Email'],
          ]}
          onApply={onQueryChange}
          data={data}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
        <RecordTable
          rows={rows}
          label="Danh sách người dùng"
          columns={[
            ['id', 'User ID', (value) => <code>{value}</code>],
            ['email', 'Email', (value) => value ?? '—'],
            ['role', 'Role', (value) => value ?? '—'],
            ['status', 'Trạng thái', statusLabel],
            ['updatedAt', 'Cập nhật', formatDate],
          ]}
        />
        {rows
          .filter((item) => item.status !== 'deleted')
          .map((user) => (
            <div className="admin-record-actions" key={`user-${user.id}`}>
              <button
                type="button"
                className="admin-button"
                onClick={async () => {
                  setSelectedUser(user)
                  setDetailState('loading')
                  try {
                    const response = await adminApi?.getAdminUser?.({
                      pathParams: { userId: user.id },
                    })
                    setSelectedUser(response?.data ?? response)
                    setDetailState('ready')
                  } catch {
                    setDetailState('error')
                  }
                }}
              >
                Mở user detail
              </button>
              <button
                type="button"
                className="admin-button"
                disabled={busyId === user.id}
                onClick={(event) => {
                  setConfirmationError(null)
                  setConfirmation({ user, trigger: event.currentTarget })
                }}
              >
                {busyId === user.id ? 'Đang xử lý…' : user.status === 'suspended' ? 'Khôi phục user' : 'Tạm dừng user'}
              </button>
            </div>
          ))}
      </section>
      {selectedUser ? (
        <section className="admin-panel">
          <h2>User detail</h2>
          {detailState === 'loading' ? <LoadingState label="Đang tải user detail…" /> : detailState === 'error' ? <p className="admin-muted">Chi tiết không còn khả dụng.</p> : <p className="admin-muted">Trạng thái server: {statusLabel(selectedUser.status)}</p>}
        </section>
      ) : null}
      <AdminConfirmationDialog
        open={Boolean(confirmation)}
        trigger={confirmation?.trigger}
        title={confirmation?.user?.status === 'suspended' ? 'Khôi phục user?' : 'Tạm dừng user?'}
        consequence="Thay đổi lifecycle sẽ thu hồi hoặc khôi phục session theo server policy."
        reasonCode={confirmation?.user?.status === 'suspended' ? 'user_restored' : 'user_suspended'}
        retryAfter={retryAfter}
        busy={Boolean(busyId)}
        error={confirmationError}
        onCancel={() => {
          setConfirmation(null)
          setConfirmationError(null)
        }}
        onConfirm={changeStatus}
      />
    </>
  )
}
