import { useState } from 'react'
import {
  formatAdminDate,
  listItems,
  roleLabel,
  safeAdminError,
  useAdminResource,
} from './admin-data.js'
import {
  AdminButton,
  CompactId,
  PageHeader,
  Panel,
  ResourceFrame,
  SourceBadge,
  StatusBadge,
  Table,
} from './AdminShared.jsx'
export function AdminAuditView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const [draftQuery, setDraftQuery] = useState({ actorType: '', targetId: '' })
  const [appliedQuery, setAppliedQuery] = useState({})
  const resource = useAdminResource(api, 'listAuditLogs', {
    initialData,
    query: appliedQuery,
    onSessionExpired,
    cacheScope: cacheScope ?? session,
  })
  const rows = listItems(resource.data)
  return (
    <div className="admin-view admin-audit-view">
      <PageHeader
        eyebrow="Chỉ ghi thêm"
        title="Nhật ký kiểm toán bất biến"
        action={
          <AdminButton icon="refresh" onClick={resource.reload}>
            Làm mới
          </AdminButton>
        }
      />
      <form
        className="admin-toolbar"
        onSubmit={(event) => {
          event.preventDefault()
          setAppliedQuery({ ...draftQuery })
        }}
      >
        <label>
          <span>Loại tác nhân</span>
          <select
            value={draftQuery.actorType}
            onChange={(event) =>
              setDraftQuery((current) => ({ ...current, actorType: event.target.value }))
            }
          >
            <option value="">Tất cả</option>
            <option value="admin">Quản trị viên</option>
            <option value="user">Người dùng</option>
            <option value="system-worker">Tiến trình hệ thống</option>
          </select>
        </label>
        <label>
          <span>Mã đối tượng</span>
          <input
            value={draftQuery.targetId}
            maxLength="128"
            onChange={(event) =>
              setDraftQuery((current) => ({ ...current, targetId: event.target.value }))
            }
          />
        </label>
        <AdminButton type="submit" variant="secondary" icon="refresh">
          Lọc
        </AdminButton>
      </form>
      <Panel title="Dòng kiểm toán">
        <ResourceFrame resource={resource} loadingLabel="Đang tải nhật ký kiểm toán…">
          <Table
            label="Nhật ký kiểm toán"
            rows={rows}
            emptyTitle="Chưa có bản ghi kiểm toán phù hợp."
            columns={[
              {
                key: 'createdAt',
                label: 'Thời điểm',
                render: (value) => <time dateTime={value}>{formatAdminDate(value)}</time>,
              },
              {
                key: 'action',
                label: 'Hành động',
                render: (value) => <strong className="admin-mono">{value}</strong>,
              },
              {
                key: 'actorType',
                label: 'Tác nhân',
                render: (value, row) => (
                  <div className="admin-cell-resource">
                    <strong className="admin-cell-primary">{roleLabel(value)}</strong>
                    <small className="admin-cell-sub">
                      <CompactId id={row.actorId} label="Mã tác nhân" length={8} />
                    </small>
                  </div>
                ),
              },
              {
                key: 'targetType',
                label: 'Đối tượng',
                render: (value, row) => (
                  <div className="admin-cell-resource">
                    {value === 'source' ? (
                      <SourceBadge sourceId={row.targetId} />
                    ) : (
                      <strong className="admin-cell-primary">{value}</strong>
                    )}
                    <small className="admin-cell-sub">
                      <CompactId id={row.targetId} label="Mã đối tượng" length={8} />
                    </small>
                  </div>
                ),
              },
              {
                key: 'changedFields',
                label: 'Trường',
                render: (value) => (
                  <span className="admin-mono">
                    {Array.isArray(value) ? value.join(', ') : 'Chưa ghi nhận'}
                  </span>
                ),
              },
              { key: 'result', label: 'Kết quả', render: (value) => <StatusBadge value={value} /> },
            ]}
          />
        </ResourceFrame>
      </Panel>
    </div>
  )
}

export function AdminAccountView({ api, session, onLogout, onSessionExpired }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  async function logout() {
    if (!session?.csrfToken || typeof api?.logout !== 'function') return
    setBusy(true)
    setError(null)
    try {
      await api.logout({
        headers: { 'X-CSRF-Token': session.csrfToken },
        credentials: 'same-origin',
      })
      onLogout?.()
    } catch (requestError) {
      if (requestError?.status === 401)
        onSessionExpired?.('Phiên đăng nhập đã hết hạn khi đăng xuất.')
      setError(safeAdminError(requestError))
    } finally {
      setBusy(false)
    }
  }
  const user = session?.user ?? {}
  return (
    <div className="admin-view admin-account-view">
      <PageHeader
        eyebrow="Tài khoản quản trị"
        title="Phiên admin"
      />
      <Panel title="Thông tin phiên">
        <dl className="admin-account-facts">
          <div>
            <dt>Vai trò</dt>
            <dd>
              <StatusBadge value={user.role ?? 'admin'} label={roleLabel(user.role ?? 'admin')} />
            </dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email ?? 'Không hiển thị'}</dd>
          </div>
          <div>
            <dt>Phiên</dt>
            <dd>
              <StatusBadge value="active" label="Đang hoạt động" />
            </dd>
          </div>
          <div>
            <dt>CSRF</dt>
            <dd className="admin-mono">CSRF lưu trong bộ nhớ · gắn theo phiên</dd>
          </div>
        </dl>
        {error ? (
          <p className="admin-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="admin-panel-footer">
          <AdminButton variant="secondary" icon="lock" onClick={logout} disabled={busy}>
            {busy ? 'Đang đăng xuất…' : 'Đăng xuất'}
          </AdminButton>
        </div>
      </Panel>
    </div>
  )
}
