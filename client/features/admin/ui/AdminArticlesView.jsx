import { useRef, useState } from 'react'
import {
  formatAdminDate,
  listItems,
  mutateAdmin,
  useAdminMutation,
  useAdminResource,
} from './admin-data.js'
import {
  AdminButton,
  AdminConfirmDialog,
  ArticlePreviewDialog,
  CompactId,
  Icon,
  PageHeader,
  Panel,
  ResourceFrame,
  SourceBadge,
  StatusBadge,
  Table,
} from './AdminShared.jsx'

function ArticleActions({ article, onAction, busy }) {
  if (article.status === 'removed') return <span className="admin-muted">Đã gỡ bỏ</span>
  return (
    <div className="admin-row-actions">
      <AdminButton
        size="small"
        variant="secondary"
        icon={article.status === 'published' ? 'archive' : 'play'}
        onClick={(event) => onAction(article, 'status', event.currentTarget)}
        disabled={busy}
      >
        {article.status === 'published' ? 'Ẩn bài' : 'Hiện bài'}
      </AdminButton>
      <AdminButton
        size="small"
        variant="secondary"
        icon="refresh"
        onClick={(event) => onAction(article, 'summary', event.currentTarget)}
        disabled={busy}
      >
        Tạo lại tóm tắt
      </AdminButton>
      <AdminButton
        size="small"
        variant="secondary"
        icon="activity"
        onClick={(event) => onAction(article, 'embedding', event.currentTarget)}
        disabled={busy}
      >
        Tạo lại vector
      </AdminButton>
    </div>
  )
}

export function AdminArticlesView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const [draftQuery, setDraftQuery] = useState({ status: '', sourceId: '' })
  const [appliedQuery, setAppliedQuery] = useState({})
  const resource = useAdminResource(api, 'listAdminArticles', {
    initialData,
    query: appliedQuery,
    onSessionExpired,
    cacheScope,
  })
  const mutation = useAdminMutation({ onSessionExpired, cacheScope })
  const [confirmation, setConfirmation] = useState(null)
  const [previewArticleId, setPreviewArticleId] = useState(null)
  const confirmationTriggerRef = useRef(null)
  const previewTriggerRef = useRef(null)
  function applyFilters(event) {
    event.preventDefault()
    setAppliedQuery({ ...draftQuery })
  }
  function onAction(article, action, trigger) {
    if (trigger) confirmationTriggerRef.current = trigger
    if (action === 'status') {
      const next = article.status === 'published' ? 'hidden' : 'published'
      setConfirmation({ article, action, next, reasonCode: 'article_status_changed' })
    } else {
      setConfirmation({ article, action, reasonCode: 'artifact_regeneration_requested' })
    }
  }
  async function confirmArticleAction() {
    if (!confirmation) return
    const { article, action, next, reasonCode } = confirmation
    const request =
      action === 'status'
        ? () =>
            mutateAdmin(api, 'updateAdminArticle', {
              csrfToken: session?.csrfToken,
              pathParams: { articleId: article.id },
              body: { status: next, reasonCode },
              idempotencyStore: mutation.idempotencyStore,
              idempotencyIntent: `status:${article.id}:${next}`,
            })
        : action === 'summary'
          ? () =>
              mutateAdmin(api, 'createSummaryJob', {
                csrfToken: session?.csrfToken,
                pathParams: { articleId: article.id },
                body: { reasonCode },
                idempotencyStore: mutation.idempotencyStore,
                idempotencyIntent: `summary:${article.id}`,
              })
          : () =>
              mutateAdmin(api, 'createIndexingJob', {
                csrfToken: session?.csrfToken,
                pathParams: { articleId: article.id },
                body: { task: 'embedding', reasonCode },
                idempotencyStore: mutation.idempotencyStore,
                idempotencyIntent: `embedding:${article.id}`,
              })
    const response = await mutation.run(
      request,
      action === 'status'
        ? 'Đã cập nhật trạng thái bài viết.'
        : action === 'summary'
          ? 'Đã xếp tác vụ tóm tắt.'
          : 'Đã xếp tác vụ vector.',
    )
    if (response) {
      setConfirmation(null)
      resource.reload()
    }
  }
  const rows = listItems(resource.data)
  return (
    <div className="admin-view admin-articles-view">
      <PageHeader
        eyebrow="Bài viết & chỉ mục AI"
        title="Quản lý bài viết"
        action={
          <AdminButton icon="refresh" onClick={resource.reload} disabled={mutation.busy}>
            Làm mới
          </AdminButton>
        }
      />
      <form className="admin-toolbar" onSubmit={applyFilters}>
        <label>
          <span>Trạng thái</span>
          <select
            value={draftQuery.status}
            onChange={(event) =>
              setDraftQuery((current) => ({ ...current, status: event.target.value }))
            }
          >
            <option value="">Tất cả</option>
            <option value="published">Đang hiển thị</option>
            <option value="hidden">Đã ẩn</option>
            <option value="review-needed">Cần xem xét</option>
            <option value="processing">Đang xử lý</option>
          </select>
        </label>
        <label>
          <span>Mã nguồn</span>
          <input
            value={draftQuery.sourceId}
            maxLength="128"
            onChange={(event) =>
              setDraftQuery((current) => ({ ...current, sourceId: event.target.value }))
            }
          />
        </label>
        <AdminButton type="submit" variant="secondary" icon="refresh">
          Lọc
        </AdminButton>
      </form>
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
      <Panel title="Chỉ mục bài viết" hint={`${rows.length} bản ghi trong trang hiện tại`}>
        <ResourceFrame resource={resource} loadingLabel="Đang tải bài viết…">
          <Table
            label="Danh sách bài viết"
            rows={rows}
            emptyTitle="Chưa có bài viết phù hợp."
            columns={[
              {
                key: 'id',
                label: 'Bài viết',
                render: (value, row) =>
                  row.status === 'removed' ? (
                    <div className="admin-cell-resource">
                      <strong className="admin-muted">Bài viết đã gỡ bỏ</strong>
                      <small className="admin-cell-sub">
                        <span>Bài viết: </span>
                        <CompactId id={value} label="Mã bài viết" length={8} />
                      </small>
                    </div>
                  ) : (
                    <div className="admin-cell-resource">
                      <div className="admin-cell-title-row">
                        <strong className="admin-cell-primary">
                          {row.titleOriginal || row.titleVi || 'Chưa có tiêu đề'}
                        </strong>
                        <button
                          type="button"
                          className="admin-btn-preview"
                          onClick={(event) => {
                            previewTriggerRef.current = event.currentTarget
                            setPreviewArticleId(value)
                          }}
                          title={`Xem nhanh bài viết ${value}`}
                          aria-label={`Xem nhanh bài viết ${value}`}
                        >
                          <Icon name="eye" size={13} />
                          <span>Xem</span>
                        </button>
                      </div>
                      <small className="admin-cell-sub">
                        <SourceBadge sourceId={row.sourceId} />
                        <span> · </span>
                        <CompactId id={value} label="Mã bài viết" length={8} />
                      </small>
                    </div>
                  ),
              },
              {
                key: 'status',
                label: 'Hiển thị',
                render: (value) => <StatusBadge value={value} />,
              },
              {
                key: 'summaryStatus',
                label: 'Tóm tắt',
                render: (value) => <StatusBadge value={value} />,
              },
              {
                key: 'embeddingStatus',
                label: 'Vector',
                render: (value) => <StatusBadge value={value} />,
              },
              {
                key: 'updatedAt',
                label: 'Cập nhật',
                render: (value) => <time dateTime={value}>{formatAdminDate(value)}</time>,
              },
            ]}
          >
            {(row) => <ArticleActions article={row} onAction={onAction} busy={mutation.busy} />}
          </Table>
        </ResourceFrame>
      </Panel>
      <AdminConfirmDialog
        open={Boolean(confirmation)}
        title={
          confirmation?.action === 'status'
            ? confirmation.next === 'hidden'
              ? 'Ẩn bài viết?'
              : 'Hiện bài viết?'
            : confirmation?.action === 'summary'
              ? 'Tạo tác vụ tóm tắt?'
              : 'Tạo tác vụ vector?'
        }
        consequence={
          confirmation?.action === 'status'
            ? 'Thay đổi trạng thái sẽ ghi kiểm toán và cập nhật khả năng hiển thị của bài viết.'
            : 'Máy chủ sẽ kiểm tra chính sách danh mục nguồn trước khi xếp tác vụ giới hạn.'
        }
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        returnFocusRef={confirmationTriggerRef}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmArticleAction}
      />
      <ArticlePreviewDialog
        open={Boolean(previewArticleId)}
        articleId={previewArticleId}
        api={api}
        onClose={() => setPreviewArticleId(null)}
        returnFocusRef={previewTriggerRef}
      />
    </div>
  )
}
