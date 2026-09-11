import { useState } from 'react'
import {
  formatAdminDate,
  listItems,
  mutateAdmin,
  roleLabel,
  useAdminMutation,
  useAdminResource,
} from './admin-data.js'
import {
  AdminButton,
  AdminConfirmDialog,
  CompactId,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
  Table,
} from './AdminShared.jsx'

export function AdminUsersView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const resource = useAdminResource(api, 'listAdminUsers', {
    initialData,
    onSessionExpired,
    cacheScope,
  })
  const mutation = useAdminMutation({ onSessionExpired, cacheScope })
  const [confirmation, setConfirmation] = useState(null)
  const rows = listItems(resource.data)
  function updateStatus(user) {
    const suspended = user.status === 'suspended'
    setConfirmation({ user, suspended, reasonCode: suspended ? 'user_restored' : 'user_suspended' })
  }
  async function confirmUserStatus() {
    if (!confirmation) return
    const { user, suspended, reasonCode } = confirmation
    const response = await mutation.run(
      () =>
        mutateAdmin(api, 'updateUserStatus', {
          csrfToken: session?.csrfToken,
          pathParams: { userId: user.id },
          body: { status: suspended ? 'active' : 'suspended', reasonCode },
        }),
      suspended ? 'Đã khôi phục người dùng.' : 'Đã tạm dừng người dùng.',
    )
    if (response) {
      setConfirmation(null)
      resource.reload()
    }
  }
  return (
    <div className="admin-view admin-users-view">
      <PageHeader
        eyebrow="Người dùng"
        title="Quản lý người dùng"
        action={
          <AdminButton icon="refresh" onClick={resource.reload} disabled={mutation.busy}>
            Làm mới
          </AdminButton>
        }
      />
      {mutation.error ? (
        <p className="admin-inline-error" role="alert">
          {mutation.error}
        </p>
      ) : null}
      <Panel title="Vòng đời người dùng" hint={`${rows.length} bản ghi trong trang hiện tại`}>
        <ResourceFrame resource={resource} loadingLabel="Đang tải người dùng…">
          <Table
            label="Danh sách người dùng"
            rows={rows}
            emptyTitle="Chưa có người dùng phù hợp."
            columns={[
              {
                key: 'id',
                label: 'Người dùng',
                render: (value, row) =>
                  row.status === 'deleted' ? (
                    <div className="admin-cell-resource">
                      <strong className="admin-muted">Đã ẩn (xóa vĩnh viễn)</strong>
                      <small className="admin-cell-sub">
                        <span>Người dùng: </span>
                        <CompactId id={value} label="Mã người dùng" length={8} />
                        <span> · {row.role ? roleLabel(row.role) : 'ẩn danh'}</span>
                      </small>
                    </div>
                  ) : (
                    <div className="admin-cell-resource">
                      <strong className="admin-cell-primary">{row.email || 'Chưa ghi nhận email'}</strong>
                      <small className="admin-cell-sub">
                        <span>Người dùng: </span>
                        <CompactId id={value} label="Mã người dùng" length={8} />
                        <span> · {row.role ? roleLabel(row.role) : 'Người dùng'}</span>
                      </small>
                    </div>
                  ),
              },
              {
                key: 'status',
                label: 'Trạng thái',
                render: (value) => <StatusBadge value={value} />,
              },
              {
                key: 'updatedAt',
                label: 'Cập nhật',
                render: (value) => <time dateTime={value}>{formatAdminDate(value)}</time>,
              },
            ]}
          >
            {(row) =>
              row.status === 'deleted' ? (
                <span className="admin-muted">Không thao tác</span>
              ) : (
                <AdminButton
                  size="small"
                  variant={row.status === 'suspended' ? 'primary' : 'secondary'}
                  icon={row.status === 'suspended' ? 'play' : 'pause'}
                  onClick={() => updateStatus(row)}
                  disabled={mutation.busy}
                >
                  {row.status === 'suspended' ? 'Khôi phục' : 'Tạm dừng'}
                </AdminButton>
              )
            }
          </Table>
        </ResourceFrame>
      </Panel>
      <AdminConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.suspended ? 'Khôi phục người dùng?' : 'Tạm dừng người dùng?'}
        consequence="Máy chủ sẽ cập nhật vòng đời và thu hồi phiên theo chính sách."
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmUserStatus}
      />
    </div>
  )
}
