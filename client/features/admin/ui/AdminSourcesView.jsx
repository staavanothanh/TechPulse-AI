import { useState } from 'react'
import { listItems, mutateAdmin, useAdminMutation, useAdminResource } from './admin-data.js'
import {
  AdminButton,
  AdminConfirmDialog,
  EmptyState,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
} from './AdminShared.jsx'
import { SourceCreateForm, SourcePolicy, SourcePolicyReviewForm } from './AdminSourceForms.jsx'

export function AdminSourcesView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const resource = useAdminResource(api, 'listSources', {
    initialData,
    onSessionExpired,
    cacheScope,
  })
  const mutation = useAdminMutation({ onSessionExpired, cacheScope })
  const sources = listItems(resource.data)
  const [selectedId, setSelectedId] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const selected = sources.find((source) => source.id === selectedId) ?? sources[0] ?? null

  function reload() {
    resource.reload()
  }

  function statusAction(source, operationalStatus) {
    setConfirmation({
      type: 'status',
      source,
      operationalStatus,
      reasonCode: 'source_status_changed',
    })
  }

  async function confirmSourceAction() {
    if (!confirmation) return
    const response =
      confirmation.type === 'status'
        ? await mutation.run(
            () =>
              mutateAdmin(api, 'updateSource', {
                csrfToken: session?.csrfToken,
                pathParams: { sourceId: confirmation.source.id },
                body: {
                  operationalStatus: confirmation.operationalStatus,
                  reasonCode: confirmation.reasonCode,
                },
                idempotencyStore: mutation.idempotencyStore,
              }),
            'Đã chuyển nguồn sang ' + confirmation.operationalStatus + '.',
          )
        : await mutation.run(
            () =>
              mutateAdmin(api, 'requestSourcePolicyReReview', {
                csrfToken: session?.csrfToken,
                pathParams: { sourceId: confirmation.source.id },
                body: { reasonCode: confirmation.reasonCode },
                idempotencyStore: mutation.idempotencyStore,
                idempotencyIntent: `source-policy-rereview:${confirmation.source.id}`,
              }),
            'Đã fail-close source để duyệt lại.',
          )
    if (response) {
      setConfirmation(null)
      reload()
    }
  }

  function technicalCheck() {
    return mutation
      .run(
        () =>
          mutateAdmin(api, 'runSourceTechnicalCheck', {
            csrfToken: session?.csrfToken,
            pathParams: { sourceId: selected.id },
            body: { reasonCode: 'source_technical_check_requested' },
          }),
        'Đã yêu cầu kiểm tra kỹ thuật.',
      )
      .then((response) => {
        if (response) reload()
        return response
      })
  }

  function submitPolicyReview(review) {
    return mutation
      .run(
        () =>
          mutateAdmin(api, 'reviewSourcePolicy', {
            csrfToken: session?.csrfToken,
            pathParams: { sourceId: selected.id },
            body: review,
          }),
        'Đã gửi policy review.',
      )
      .then((response) => {
        if (response) reload()
        return response
      })
  }

  function createSource(input) {
    return mutation
      .run(
        () => mutateAdmin(api, 'createSource', { csrfToken: session?.csrfToken, body: input }),
        'Đã tạo source draft.',
      )
      .then((response) => {
        if (response) reload()
        return response
      })
  }

  return (
    <div className="admin-view admin-sources-view">
      <PageHeader
        eyebrow="Source Registry"
        title="Quản lý nguồn"
        description="Connector, publisher, rights policy và media policy. Giao diện không hiển thị thông tin nhạy cảm."
        action={
          <AdminButton icon="refresh" onClick={reload} disabled={mutation.busy}>
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
      <ResourceFrame resource={resource} loadingLabel="Đang tải Source Registry…">
        <div className="admin-source-workspace">
          <aside className="admin-source-list" aria-label="Danh sách nguồn">
            {sources.length ? (
              sources.map((source) => (
                <button
                  type="button"
                  key={source.id}
                  className={selected?.id === source.id ? 'active' : ''}
                  aria-pressed={selected?.id === source.id}
                  onClick={() => setSelectedId(source.id)}
                >
                  <strong>{source.name}</strong>
                  <small className="admin-mono">{source.sourceKey}</small>
                  <span>
                    <StatusBadge value={source.operationalStatus} />{' '}
                    <span className="admin-source-version">
                      policy v{source.policyVersion ?? 'n/a'}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <EmptyState
                title="Chưa có source."
                description="Tạo draft đầu tiên trong biểu mẫu bên phải."
              />
            )}
          </aside>
          <div className="admin-source-editor">
            {selected ? (
              <Panel title={selected.name} hint={selected.sourceKey + ' · ' + selected.domain}>
                <div className="admin-source-title">
                  <div>
                    <StatusBadge value={selected.operationalStatus} />
                    <StatusBadge
                      value={selected.licenseStatus}
                      label={selected.licenseStatus ?? 'Chưa ghi nhận'}
                    />
                  </div>
                  <span className="admin-mono">{selected.id}</span>
                </div>
                <SourcePolicy source={selected} />
                <div className="admin-row-actions admin-source-actions">
                  {selected.operationalStatus === 'draft' ? (
                    <AdminButton
                      size="small"
                      variant="secondary"
                      icon="activity"
                      onClick={() => statusAction(selected, 'testing')}
                      disabled={mutation.busy}
                    >
                      Chuyển sang kiểm thử
                    </AdminButton>
                  ) : null}
                  {['testing', 'paused'].includes(selected.operationalStatus) ? (
                    <AdminButton
                      size="small"
                      variant="primary"
                      icon="play"
                      onClick={() => statusAction(selected, 'active')}
                      disabled={mutation.busy}
                    >
                      Kích hoạt
                    </AdminButton>
                  ) : null}
                  {['testing', 'active'].includes(selected.operationalStatus) ? (
                    <AdminButton
                      size="small"
                      variant="secondary"
                      icon="pause"
                      onClick={() => statusAction(selected, 'paused')}
                      disabled={mutation.busy}
                    >
                      Tạm dừng
                    </AdminButton>
                  ) : null}
                  <AdminButton
                    size="small"
                    variant="secondary"
                    icon="activity"
                    onClick={() => void technicalCheck()}
                    disabled={mutation.busy}
                  >
                    Kiểm tra kỹ thuật
                  </AdminButton>
                  <AdminButton
                    size="small"
                    variant="secondary"
                    icon="refresh"
                    onClick={() =>
                      setConfirmation({
                        type: 'rereview',
                        source: selected,
                        reasonCode: 'source_policy_re_review_requested',
                      })
                    }
                    disabled={mutation.busy}
                  >
                    Yêu cầu duyệt lại
                  </AdminButton>
                </div>
              </Panel>
            ) : (
              <EmptyState
                title="Chọn một source"
                description="Policy và trạng thái sẽ hiển thị ở đây."
              />
            )}
            {selected ? (
              <SourcePolicyReviewForm
                key={`policy:${selected.id}:${selected.policyVersion ?? 'new'}`}
                source={selected}
                onSubmit={submitPolicyReview}
                busy={mutation.busy}
              />
            ) : null}
            <SourceCreateForm onSubmit={createSource} busy={mutation.busy} />
            <AdminConfirmDialog
              open={Boolean(confirmation)}
              title={
                confirmation?.type === 'rereview'
                  ? 'Fail-close source để duyệt lại?'
                  : 'Đổi trạng thái source?'
              }
              consequence={
                confirmation?.type === 'rereview'
                  ? 'Source sẽ cần một quyết định policy mới trước khi được xử lý tiếp.'
                  : 'Server sẽ kiểm tra lifecycle và policy trước khi đổi trạng thái.'
              }
              reasonCode={confirmation?.reasonCode}
              busy={mutation.busy}
              onCancel={() => setConfirmation(null)}
              onConfirm={confirmSourceAction}
            />
          </div>
        </div>
      </ResourceFrame>
    </div>
  )
}
