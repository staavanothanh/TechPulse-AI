import { useState } from 'react'
import { normalizeAdminFailure } from './admin-utils.js'
import {
  AdminConfirmationDialog,
  AdminListControls,
  FailureNotice,
  LoadingState,
  RecordTable,
} from './admin-shared.jsx'
import { formatDate, idempotencyKey, statusLabel, useRetryAfterCooldown } from './admin-helpers.js'

export default function AdminArticles({ data, state, failure, onRetry, adminApi, readApi, csrfToken, query, onQueryChange, loadingMore, onLoadMore, onNotice }) {
  const [selected, setSelected] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [detailFailure, setDetailFailure] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const [intentKeys] = useState(() => new Map())
  const rows = data?.data ?? []
  const submit = async () => {
    if (!dialog || !csrfToken || !adminApi) return
    let mutationBody = dialog.body
    if (dialog.kind === 'topics') {
      const tokens = String(dialog.value ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
      const topics = [...new Set(tokens)]
      if (tokens.length !== topics.length || topics.length < 1 || topics.length > 20 || topics.some((value) => value.length > 64)) {
        setDialogError('Nhập từ 1 đến 20 topic duy nhất, mỗi topic không quá 64 ký tự.')
        globalThis.document?.getElementById?.('admin-article-topics')?.focus?.({ preventScroll: true })
        return
      }
      mutationBody = { topics, reasonCode: 'article_topics_changed' }
    }
    if (dialog.kind === 'merge') {
      const tokens = String(dialog.value ?? '')
        .split(/[\s,]+/)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
      const duplicateArticleIds = [...new Set(tokens)]
      if (tokens.length !== duplicateArticleIds.length || duplicateArticleIds.length < 1 || duplicateArticleIds.length > 20 || duplicateArticleIds.includes(dialog.article.id.toLowerCase()) || duplicateArticleIds.some((value) => !/^[a-f0-9]{24}$/.test(value))) {
        setDialogError('Nhập từ 1 đến 20 Article ID hợp lệ, duy nhất và khác canonical ID.')
        globalThis.document?.getElementById?.('admin-duplicate-ids')?.focus?.({ preventScroll: true })
        return
      }
      mutationBody = {
        canonicalArticleId: dialog.article.id,
        duplicateArticleIds,
        reasonCode: 'duplicate_merge_confirmed',
      }
    }
    setDialogError(null)
    setBusy(true)
    onNotice?.('')
    const requiresKey = ['summary', 'indexing', 'merge'].includes(dialog.kind)
    const intent = `${dialog.kind}:${dialog.article.id}`
    const key = requiresKey ? (intentKeys.get(intent) ?? idempotencyKey(intent)) : null
    if (key) intentKeys.set(intent, key)
    const method = dialog.kind === 'summary' ? adminApi.createSummaryJob : dialog.kind === 'indexing' ? adminApi.createIndexingJob : dialog.kind === 'merge' ? adminApi.mergeDuplicateArticles : adminApi.updateAdminArticle
    if (typeof method !== 'function') {
      setDialogError('Dịch vụ thao tác article hiện không khả dụng.')
      setBusy(false)
      return
    }
    const operation =
      dialog.kind === 'summary'
        ? method({
            pathParams: { articleId: dialog.article.id },
            headers: {
              'Content-Type': 'application/json',
              'X-CSRF-Token': csrfToken,
              'Idempotency-Key': key,
            },
            credentials: 'same-origin',
            body: JSON.stringify({ reasonCode: 'artifact_regeneration_requested' }),
          })
        : dialog.kind === 'indexing'
          ? method({
              pathParams: { articleId: dialog.article.id },
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
                'Idempotency-Key': key,
              },
              credentials: 'same-origin',
              body: JSON.stringify({
                task: 'embedding',
                reasonCode: 'artifact_regeneration_requested',
              }),
            })
          : dialog.kind === 'merge'
            ? method({
                headers: {
                  'Content-Type': 'application/json',
                  'X-CSRF-Token': csrfToken,
                  'Idempotency-Key': key,
                },
                credentials: 'same-origin',
                body: JSON.stringify(mutationBody),
              })
            : method({
                pathParams: { articleId: dialog.article.id },
                headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
                credentials: 'same-origin',
                body: JSON.stringify(mutationBody),
              })
    try {
      await operation
      if (key) intentKeys.delete(intent)
      onNotice?.('Đã gửi thao tác article.')
      setDialog(null)
    } catch (error) {
      setRetryAfter(Number.isSafeInteger(error?.retryAfter) ? error.retryAfter : 0)
      onNotice?.(normalizeAdminFailure(error).message)
    } finally {
      setBusy(false)
    }
  }
  const openDetail = async (article, trigger) => {
    setSelected({ ...article, trigger })
    setDetailFailure(null)
    if (!readApi?.getAdminArticle) {
      setDetailState('ready')
      return
    }
    setDetailState('loading')
    try {
      const response = await readApi.getAdminArticle({ pathParams: { articleId: article.id } })
      setSelected({ ...(response?.data ?? response), trigger })
      setDetailState('ready')
    } catch (error) {
      setDetailFailure(normalizeAdminFailure(error))
      setDetailState('error')
    }
  }
  if (state === 'loading') return <LoadingState label="Đang tải articles…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">ART-005 · SAFE ARTICLE OPERATIONS</span>
          <h1>Articles & AI index</h1>
          <p>Chỉ hiển thị identity, lifecycle và trạng thái artifact allowlist.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls
          query={query}
          fields={[
            ['status', 'Trạng thái', ['published', 'hidden', 'reviewing']],
            ['summaryStatus', 'Summary', ['ready', 'pending', 'failed']],
            ['embeddingStatus', 'Embedding', ['ready', 'pending', 'failed']],
            ['sourceId', 'Source ID'],
          ]}
          onApply={onQueryChange}
          data={data}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
        <RecordTable
          rows={rows}
          label="Danh sách article quản trị"
          columns={[
            ['id', 'Article ID', (value) => <code>{value}</code>],
            ['sourceId', 'Source ID', (value) => <code>{value}</code>],
            ['titleOriginal', 'Tiêu đề', (value) => <strong>{value}</strong>],
            ['status', 'Trạng thái', statusLabel],
            ['summaryStatus', 'Summary', statusLabel],
            ['embeddingStatus', 'Embedding', statusLabel],
            ['updatedAt', 'Cập nhật', formatDate],
          ]}
        />
        {rows.length ? (
          <div className="admin-record-actions">
            {rows.map((article) => (
              <button
                type="button"
                className="admin-button"
                key={article.id}
                onClick={(event) => {
                  void openDetail(article, event.currentTarget)
                }}
              >
                Mở {article.id}
              </button>
            ))}
          </div>
        ) : null}
      </section>
      {selected ? (
        <section className="admin-panel" aria-labelledby="admin-article-detail">
          <div className="admin-panel-head">
            <div>
              <h2 id="admin-article-detail" tabIndex="-1">
                Article {selected.id}
              </h2>
              <p>{selected.status === 'removed' ? 'Metadata của article đã được xóa theo takedown.' : selected.titleOriginal}</p>
            </div>
            <button
              type="button"
              className="admin-button"
              onClick={() => {
                setSelected(null)
                selected.trigger?.focus?.({ preventScroll: true })
              }}
            >
              Đóng
            </button>
          </div>
          {detailState === 'loading' ? <LoadingState label="Đang tải chi tiết article…" /> : null}
          <FailureNotice failure={detailFailure} />
          {detailState !== 'loading' && !detailFailure ? (
            selected.status === 'removed' ? (
              <>
                <dl className="admin-facts">
                  <div><dt>Source ID</dt><dd><code>{selected.sourceId}</code></dd></div>
                  <div><dt>Trạng thái</dt><dd>{statusLabel(selected.status)}</dd></div>
                  <div><dt>Policy version khi xóa</dt><dd>{selected.removalPolicyVersion}</dd></div>
                  <div><dt>Đã xóa lúc</dt><dd>{formatDate(selected.removedAt)}</dd></div>
                </dl>
                <p className="admin-muted">Tombstone không giữ title, URL, author, provenance, media hoặc AI artifacts. Không có mutation control cho article này.</p>
              </>
            ) : (
              <>
              <dl className="admin-facts">
                <div>
                  <dt>Source ID</dt>
                  <dd>
                    <code>{selected.sourceId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Topics</dt>
                  <dd>{selected.topics?.join(', ') || '—'}</dd>
                </div>
                <div>
                  <dt>Media</dt>
                  <dd>{selected.leadMediaStatus}</dd>
                </div>
                <div>
                  <dt>Embedding model/version</dt>
                  <dd>
                    <code>
                      {selected.embeddingModel ?? '—'} / {selected.embeddingVersion ?? '—'}
                    </code>
                  </dd>
                </div>
              </dl>
              <div className="admin-record-actions">
                <button
                  type="button"
                  className="admin-button admin-button-danger"
                  onClick={(event) =>
                    setDialog({
                      article: selected,
                      trigger: event.currentTarget,
                      body: {
                        status: selected.status === 'hidden' ? 'published' : 'hidden',
                        reasonCode: 'article_status_changed',
                      },
                    })
                  }
                >
                  {selected.status === 'hidden' ? 'Hiện article' : 'Ẩn article'}
                </button>
                {selected.leadMediaStatus === 'none' ? (
                  <span className="admin-muted">Article không có lead media để đổi hiển thị.</span>
                ) : (
                  <button
                    type="button"
                    className="admin-button"
                    onClick={(event) =>
                      setDialog({
                        article: selected,
                        trigger: event.currentTarget,
                        body: {
                          leadMediaStatus: selected.leadMediaStatus === 'hidden' ? 'available' : 'hidden',
                          reasonCode: 'article_media_visibility_changed',
                        },
                      })
                    }
                  >
                    Đổi hiển thị media
                  </button>
                )}
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) =>
                    setDialog({
                      article: selected,
                      trigger: event.currentTarget,
                      kind: 'topics',
                      value: selected.topics?.join(', ') ?? '',
                    })
                  }
                >
                  Sửa topics
                </button>
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) =>
                    setDialog({
                      article: selected,
                      trigger: event.currentTarget,
                      kind: 'summary',
                      body: {},
                    })
                  }
                >
                  Tạo summary job
                </button>
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) =>
                    setDialog({
                      article: selected,
                      trigger: event.currentTarget,
                      kind: 'indexing',
                      body: {},
                    })
                  }
                >
                  Tạo indexing job
                </button>
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) =>
                    setDialog({
                      article: selected,
                      trigger: event.currentTarget,
                      kind: 'merge',
                      value: '',
                    })
                  }
                >
                  Gộp duplicate
                </button>
              </div>
              </>
            )
          ) : null}
        </section>
      ) : null}
      <AdminConfirmationDialog
        open={Boolean(dialog)}
        trigger={dialog?.trigger}
        title={dialog?.kind === 'summary' ? 'Tạo summary job?' : dialog?.kind === 'indexing' ? 'Tạo indexing job?' : dialog?.kind === 'topics' ? 'Cập nhật topics?' : dialog?.kind === 'merge' ? 'Gộp duplicate article?' : dialog?.body.status ? 'Đổi trạng thái article?' : 'Đổi hiển thị media?'}
        consequence="Server sẽ kiểm tra policy, quyền và trạng thái hiện tại trước khi commit."
        reasonCode={dialog?.kind === 'merge' ? 'duplicate_merge_confirmed' : dialog?.kind === 'topics' ? 'article_topics_changed' : dialog?.kind ? 'artifact_regeneration_requested' : dialog?.body.reasonCode}
        retryAfter={retryAfter}
        busy={busy}
        error={dialogError}
        onCancel={() => {
          setDialog(null)
          setDialogError(null)
        }}
        onConfirm={submit}
      >
        {dialog?.kind === 'topics' ? (
          <label htmlFor="admin-article-topics">
            <span>Topics, phân tách bằng dấu phẩy</span>
            <input id="admin-article-topics" value={dialog.value} aria-invalid={Boolean(dialogError)} onChange={(event) => setDialog((current) => ({ ...current, value: event.target.value }))} />
          </label>
        ) : null}
        {dialog?.kind === 'merge' ? (
          <label htmlFor="admin-duplicate-ids">
            <span>Duplicate Article IDs</span>
            <input id="admin-duplicate-ids" value={dialog.value} aria-invalid={Boolean(dialogError)} onChange={(event) => setDialog((current) => ({ ...current, value: event.target.value }))} />
          </label>
        ) : null}
      </AdminConfirmationDialog>
    </>
  )
}
