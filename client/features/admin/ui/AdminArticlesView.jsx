import { useState } from 'react'
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
  if (article.status === 'removed') return <span className="admin-muted">Tombstone</span>
  return (
    <div className="admin-row-actions">
      <AdminButton
        size="small"
        variant="secondary"
        icon={article.status === 'published' ? 'archive' : 'play'}
        onClick={() => onAction(article, 'status')}
        disabled={busy}
      >
        {article.status === 'published' ? 'Ẩn bài' : 'Hiện bài'}
      </AdminButton>
      <AdminButton
        size="small"
        variant="secondary"
        icon="refresh"
        onClick={() => onAction(article, 'summary')}
        disabled={busy}
      >
        Regenerate summary
      </AdminButton>
      <AdminButton
        size="small"
        variant="secondary"
        icon="activity"
        onClick={() => onAction(article, 'embedding')}
        disabled={busy}
      >
        Regenerate embedding
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
  function applyFilters(event) {
    event.preventDefault()
    setAppliedQuery({ ...draftQuery })
  }
  function onAction(article, action) {
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
        ? 'Đã cập nhật trạng thái article.'
        : action === 'summary'
          ? 'Đã xếp job tóm tắt.'
          : 'Đã xếp job embedding.',
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
        eyebrow="Articles & AI index"
        title="Quản lý bài viết"
        description="Theo dõi trạng thái xuất bản, summary và embedding. Dữ liệu nguồn chỉ được xử lý theo Source Registry policy."
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
          <span>Source ID</span>
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
      <Panel title="Article index" hint={`${rows.length} bản ghi trong trang hiện tại`}>
        <ResourceFrame resource={resource} loadingLabel="Đang tải articles…">
          <Table
            label="Danh sách articles"
            rows={rows}
            emptyTitle="Chưa có article phù hợp."
            columns={[
              {
                key: 'id',
                label: 'Article',
                render: (value, row) =>
                  row.status === 'removed' ? (
                    <div className="admin-cell-resource">
                      <strong className="admin-muted">Bài viết đã gỡ bỏ (Tombstone)</strong>
                      <small className="admin-cell-sub">
                        <span>Article: </span>
                        <CompactId id={value} label="Article ID" length={8} />
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
                          onClick={() => setPreviewArticleId(value)}
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
                        <CompactId id={value} label="Article ID" length={8} />
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
                label: 'Summary',
                render: (value) => <StatusBadge value={value} />,
              },
              {
                key: 'embeddingStatus',
                label: 'Embedding',
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
              ? 'Ẩn article?'
              : 'Hiện article?'
            : confirmation?.action === 'summary'
              ? 'Tạo summary job?'
              : 'Tạo embedding job?'
        }
        consequence={
          confirmation?.action === 'status'
            ? 'Thay đổi trạng thái sẽ ghi audit và cập nhật khả năng hiển thị của article.'
            : 'Server sẽ kiểm tra Source Registry policy trước khi xếp bounded job.'
        }
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmArticleAction}
      />
      <ArticlePreviewDialog
        open={Boolean(previewArticleId)}
        articleId={previewArticleId}
        api={api}
        onClose={() => setPreviewArticleId(null)}
      />
    </div>
  )
}
