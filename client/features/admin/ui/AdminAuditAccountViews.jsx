import { useState } from 'react'
import { formatAdminDate, listItems, safeAdminError, useAdminResource } from './admin-data.js'
import {
  AdminButton,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
  Table,
} from './AdminShared.jsx'

export function AdminAuditView({ api, initialData, onSessionExpired }) {
  const [query, setQuery] = useState({})
  const resource = useAdminResource(api, 'listAuditLogs', { initialData, query, onSessionExpired })
  const rows = listItems(resource.data)
  return (
    <div className="admin-view admin-audit-view">
      <PageHeader
        eyebrow="Append-only"
        title="Audit bất biến"
        description="Mọi mutation admin đều ghi audit với reasonCode allowlist. Không có update hoặc delete endpoint."
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
          resource.reload()
        }}
      >
        <label>
          <span>Actor type</span>
          <select
            value={query.actorType ?? ''}
            onChange={(event) =>
              setQuery((current) => ({ ...current, actorType: event.target.value }))
            }
          >
            <option value="">Tất cả</option>
            <option value="admin">admin</option>
            <option value="user">user</option>
            <option value="system-worker">system-worker</option>
          </select>
        </label>
        <label>
          <span>Target ID</span>
          <input
            value={query.targetId ?? ''}
            maxLength="128"
            onChange={(event) =>
              setQuery((current) => ({ ...current, targetId: event.target.value }))
            }
          />
        </label>
        <AdminButton type="submit" variant="secondary" icon="refresh">
          Lọc
        </AdminButton>
      </form>
      <Panel title="Audit stream" hint="Read-only structured events">
        <ResourceFrame resource={resource} loadingLabel="Đang tải audit logs…">
          <Table
            label="Audit logs"
            rows={rows}
            emptyTitle="Chưa có audit record phù hợp."
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
                label: 'Actor',
                render: (value, row) => (
                  <>
                    <span>{value}</span>
                    <small className="admin-mono">{row.actorId}</small>
                  </>
                ),
              },
              {
                key: 'targetType',
                label: 'Đối tượng',
                render: (value, row) => (
                  <>
                    <span>{value}</span>
                    <small className="admin-mono">{row.targetId}</small>
                  </>
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
        description="Phiên server-side, CSRF trong memory và không lưu token trong trình duyệt."
      />
      <Panel title="Thông tin phiên" hint="Dữ liệu lấy từ session props">
        <dl className="admin-account-facts">
          <div>
            <dt>Vai trò</dt>
            <dd>
              <StatusBadge value={user.role ?? 'admin'} label={user.role ?? 'admin'} />
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
            <dd className="admin-mono">session-bound · memory</dd>
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
