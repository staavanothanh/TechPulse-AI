import { useState } from 'react'
import {
  DELETION_FLAGS,
  formatAdminDate,
  listItems,
  mutateAdmin,
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

const TAKEDOWN_TRANSITIONS = Object.freeze({
  received: ['reviewing', 'Bắt đầu xem xét', 'takedown_review_started'],
  reviewing: ['approved', 'Phê duyệt yêu cầu', 'takedown_approved'],
  approved: ['completed', 'Ghi nhận hoàn tất', 'takedown_completed'],
})

function TakedownRowActions({ item, onTransition, busy }) {
  const transition = TAKEDOWN_TRANSITIONS[item.status]
  return transition ? (
    <AdminButton
      size="small"
      variant={transition[0] === 'completed' ? 'primary' : 'secondary'}
      icon="arrow"
      onClick={() => onTransition(item, transition)}
      disabled={busy}
    >
      {transition[1]}
    </AdminButton>
  ) : (
    <span className="admin-muted">Không có bước tiếp theo</span>
  )
}

function CompletionFlags({ completion = {} }) {
  return (
    <div className="admin-flags">
      {DELETION_FLAGS.map(([key, label]) => (
        <span className={completion[key] ? 'done' : ''} key={key}>
          <i aria-hidden="true" />
          {label}
        </span>
      ))}
    </div>
  )
}

export function AdminGovernanceView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const seed = initialData ?? {}
  const takedowns = useAdminResource(api, 'listTakedownRequests', {
    initialData: seed.takedowns,
    onSessionExpired,
    cacheScope,
  })
  const deletions = useAdminResource(api, 'listAccountDeletionRequests', {
    initialData: seed.deletions,
    onSessionExpired,
    cacheScope,
  })
  const mutation = useAdminMutation({ onSessionExpired, cacheScope })
  const [confirmation, setConfirmation] = useState(null)
  function transition(item, next) {
    setConfirmation({ type: 'takedown', item, next, reasonCode: next[2] })
  }
  function retryDeletion(item) {
    setConfirmation({ type: 'deletion', item, reasonCode: 'account_deletion_retry_requested' })
  }
  async function confirmGovernanceAction() {
    if (!confirmation) return
    const response =
      confirmation.type === 'takedown'
        ? await mutation.run(
            () =>
              mutateAdmin(api, 'updateTakedownRequest', {
                csrfToken: session?.csrfToken,
                pathParams: { takedownRequestId: confirmation.item.id },
                body: { status: confirmation.next[0], reasonCode: confirmation.reasonCode },
              }),
            'Đã cập nhật workflow takedown.',
          )
        : await mutation.run(
            () =>
              mutateAdmin(api, 'retryAccountDeletionRequest', {
                csrfToken: session?.csrfToken,
                pathParams: { deletionRequestId: confirmation.item.id },
                body: { reasonCode: confirmation.reasonCode },
                idempotencyStore: mutation.idempotencyStore,
                idempotencyIntent: `account-deletion-retry:${confirmation.item.id}`,
              }),
            'Đã xếp lại workflow xóa tài khoản.',
          )
    if (response) {
      setConfirmation(null)
      if (confirmation.type === 'takedown') takedowns.reload()
      else deletions.reload()
    }
  }
  const tdRows = listItems(takedowns.data)
  const deletionRows = listItems(deletions.data)
  return (
    <div className="admin-view admin-governance-view">
      <PageHeader
        eyebrow="Governance"
        title="Takedown & xóa tài khoản"
        description="Xử lý workflow gỡ nội dung và theo dõi tiến độ xóa tài khoản. Danh sách không hiển thị thông tin người yêu cầu."
        action={
          <AdminButton
            icon="refresh"
            onClick={() => {
              takedowns.reload()
              deletions.reload()
            }}
            disabled={mutation.busy}
          >
            Làm mới
          </AdminButton>
        }
      />
      {mutation.error ? (
        <p className="admin-inline-error" role="alert">
          {mutation.error}
        </p>
      ) : null}
      {mutation.notice ? (
        <p className="admin-inline-success" role="status">
          {mutation.notice}
        </p>
      ) : null}
      <Panel
        title="Takedown requests"
        hint="Hide trước khi hoàn tất. Completion chỉ hợp lệ khi server xác nhận đầy đủ cleanup"
      >
        <ResourceFrame resource={takedowns} loadingLabel="Đang tải takedown requests…">
          <Table
            label="Takedown requests"
            rows={tdRows}
            emptyTitle="Không có takedown đang mở."
            columns={[
              {
                key: 'id',
                label: 'Request',
                render: (value, row) => (
                  <div className="admin-cell-resource">
                    <strong className="admin-cell-primary">
                      {row.targetType} · {row.targetIds?.length ?? 0} target
                    </strong>
                    <small className="admin-cell-sub">
                      <span>Request: </span>
                      <CompactId id={value} label="Request ID" length={8} />
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
                key: 'requestedScope',
                label: 'Phạm vi',
                render: (value) => (
                  <span>{Array.isArray(value) ? value.join(', ') : 'Chưa ghi nhận'}</span>
                ),
              },
              {
                key: 'createdAt',
                label: 'Tiếp nhận',
                render: (value) => <time dateTime={value}>{formatAdminDate(value)}</time>,
              },
            ]}
          >
            {(row) => (
              <TakedownRowActions item={row} onTransition={transition} busy={mutation.busy} />
            )}
          </Table>
        </ResourceFrame>
      </Panel>
      <Panel
        title="Account deletion workflows"
        hint="Bảy completion flags thuộc server-owned cleanup fence"
      >
        <ResourceFrame resource={deletions} loadingLabel="Đang tải account deletion workflows…">
          <Table
            label="Account deletion workflows"
            rows={deletionRows}
            emptyTitle="Không có workflow xóa tài khoản lỗi."
            columns={[
              {
                key: 'id',
                label: 'Workflow',
                render: (value, row) => (
                  <div className="admin-cell-resource">
                    <strong className="admin-cell-primary">
                      User Deletion · attempt {row.attempt ?? 1}
                    </strong>
                    <small className="admin-cell-sub">
                      <span>Workflow: </span>
                      <CompactId id={value} label="Workflow ID" length={8} />
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
                key: 'completion',
                label: 'Tiến độ',
                render: (value) => <CompletionFlags completion={value} />,
              },
              {
                key: 'error',
                label: 'Kết quả',
                render: (value) =>
                  value ? (
                    <span className="admin-safe-error">
                      {value.code ?? 'cleanup_error'}: {value.message ?? 'Không thể xử lý'}
                    </span>
                  ) : (
                    <span className="admin-muted">Không có lỗi</span>
                  ),
              },
            ]}
          >
            {(row) =>
              row.status === 'failed' ? (
                <AdminButton
                  size="small"
                  variant="primary"
                  icon="refresh"
                  onClick={() => retryDeletion(row)}
                  disabled={mutation.busy}
                >
                  Thử lại xóa dữ liệu
                </AdminButton>
              ) : (
                <span className="admin-muted">Theo dõi</span>
              )
            }
          </Table>
        </ResourceFrame>
      </Panel>
      <AdminConfirmDialog
        open={Boolean(confirmation)}
        title={
          confirmation?.type === 'takedown'
            ? confirmation?.next?.[1] + '?'
            : 'Thử lại xóa tài khoản?'
        }
        consequence={
          confirmation?.type === 'takedown'
            ? 'Server sẽ kiểm tra lifecycle và completion fence trước khi thay đổi trạng thái.'
            : 'Server sẽ tiếp tục các bước cleanup còn lại mà không khôi phục identity hoặc session.'
        }
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmGovernanceAction}
      />
    </div>
  )
}
