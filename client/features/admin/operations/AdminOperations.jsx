import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizeAdminFailure, projectTakedownDetail } from './admin-utils.js'
import { createAdminReadApi } from './admin-api.js'

const NAV_ITEMS = Object.freeze([
  { id: 'overview', label: 'Tổng quan' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'articles', label: 'Articles & AI index' },
  { id: 'governance', label: 'Governance' },
  { id: 'users', label: 'Người dùng' },
  { id: 'audit', label: 'Audit bất biến' },
  { id: 'states', label: 'States' },
])

const OVERVIEW_FIELDS = Object.freeze([
  ['failedJobs', 'Job lỗi', 'exception'],
  ['failedIndexes', 'Index lỗi', 'exception'],
  ['openTakedowns', 'Takedown đang mở', 'warning'],
  ['failedAccountDeletions', 'Xóa tài khoản lỗi', 'exception'],
  ['sourcesNeedingReview', 'Nguồn cần duyệt', 'warning'],
  ['articlesNeedingReview', 'Article cần duyệt', 'warning'],
  ['queuedJobs', 'Job đang chờ', 'quiet'],
  ['activeSources', 'Nguồn đang hoạt động', 'quiet'],
  ['pausedSources', 'Nguồn tạm dừng', 'quiet'],
])

const DELETION_FLAGS = Object.freeze(['sessionsRevoked', 'sessionsDeleted', 'savedArticlesDeleted', 'chatSessionsDeleted', 'answerAttemptsDeleted', 'userQuotaDataDeleted', 'identityAnonymized'])
const TERMINAL_WORKFLOW_STATES = new Set(['completed', 'failed', 'rejected', 'cancelled'])

function idempotencyKey(intent) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `admin-${intent}-${suffix}`
}

function useRetryAfterCooldown() {
  const [retryAfter, setRetryAfter] = useState(0)
  useEffect(() => {
    if (retryAfter <= 0) return undefined
    const timer = globalThis.setTimeout(() => setRetryAfter((current) => Math.max(0, current - 1)), 1_000)
    return () => globalThis.clearTimeout(timer)
  }, [retryAfter])
  return [retryAfter, setRetryAfter]
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function statusLabel(value) {
  const labels = {
    published: 'Đang hiển thị',
    hidden: 'Đã ẩn',
    approved: 'Đã duyệt',
    reviewing: 'Đang xem xét',
    rejected: 'Từ chối',
    completed: 'Hoàn tất',
    received: 'Đã tiếp nhận',
    active: 'Đang hoạt động',
    suspended: 'Tạm dừng',
    deleted: 'Đã xóa',
    queued: 'Đang chờ',
    running: 'Đang chạy',
    failed: 'Lỗi',
  }
  return labels[value] ?? value ?? '—'
}

function FailureNotice({ failure, onRetry }) {
  if (!failure) return null
  return (
    <div className="admin-notice admin-notice-error" role="alert">
      <p>{failure.message}</p>
      {onRetry ? (
        <button type="button" className="admin-button" onClick={onRetry}>
          Thử lại
        </button>
      ) : null}
    </div>
  )
}

function EmptyState({ title = 'Không có bản ghi phù hợp.', description = 'Bộ lọc hiện tại chưa trả về dữ liệu.' }) {
  return (
    <div className="admin-empty">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

function LoadingState({ label = 'Đang tải dữ liệu…' }) {
  return (
    <div className="admin-empty" aria-busy="true">
      <p>{label}</p>
    </div>
  )
}

function RecordTable({ rows, columns, label }) {
  if (!rows.length) return <EmptyState />
  return (
    <div className="admin-records" role="region" aria-label={label}>
      {rows.map((row, index) => (
        <article className="admin-record" key={row.id ?? index}>
          {columns.map(([key, heading, render]) => (
            <div className="admin-record-field" key={key} data-label={heading}>
              <span className="admin-record-label">{heading}</span>
              <span className="admin-record-value">{render ? render(row[key], row) : (row[key] ?? '—')}</span>
            </div>
          ))}
        </article>
      ))}
    </div>
  )
}

function AdminListControls({ query, fields, onApply, data, loadingMore, onLoadMore }) {
  const [draft, setDraft] = useState(query ?? {})
  const [errors, setErrors] = useState({})
  const apply = (event) => {
    event.preventDefault()
    const nextErrors = Object.fromEntries(fields.flatMap(([key]) => (String(draft[key] ?? '').length > 128 ? [[key, 'Giá trị không được dài quá 128 ký tự.']] : [])))
    setErrors(nextErrors)
    const firstInvalid = fields.find(([key]) => nextErrors[key])?.[0]
    if (firstInvalid) {
      globalThis.document?.getElementById?.(`admin-filter-${firstInvalid}`)?.focus?.({ preventScroll: true })
      return
    }
    onApply(Object.fromEntries(Object.entries(draft).filter(([, value]) => value)))
  }
  return (
    <>
      <form className="admin-list-controls" onSubmit={apply}>
        {fields.map(([key, label, options]) => (
          <label key={key} htmlFor={`admin-filter-${key}`}>
            <span>{label}</span>
            {options ? (
              <select id={`admin-filter-${key}`} value={draft[key] ?? ''} aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `admin-filter-${key}-error` : undefined} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))}>
                <option value="">Tất cả</option>
                {options.map((option) => (
                  <option key={option} value={option}>
                    {statusLabel(option)}
                  </option>
                ))}
              </select>
            ) : (
              <input id={`admin-filter-${key}`} value={draft[key] ?? ''} maxLength="128" aria-invalid={Boolean(errors[key])} aria-describedby={errors[key] ? `admin-filter-${key}-error` : undefined} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} />
            )}
            {errors[key] ? (
              <small id={`admin-filter-${key}-error`} className="admin-field-error" role="alert">
                {errors[key]}
              </small>
            ) : null}
          </label>
        ))}
        <button type="submit" className="admin-button">
          Áp dụng bộ lọc
        </button>
      </form>
      {data?.meta?.hasNext ? (
        <div className="admin-record-actions">
          <button type="button" className="admin-button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Đang tải thêm…' : 'Tải thêm'}
          </button>
        </div>
      ) : null}
    </>
  )
}

export function AdminConfirmationDialog({ open = false, title, consequence, reasonCode, busy = false, retryAfter = 0, error = null, trigger = null, onCancel, onConfirm, children = null }) {
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  const confirmRef = useRef(null)
  const wasOpen = useRef(false)
  const triggerRef = useRef(null)
  useEffect(() => {
    if (open && trigger) triggerRef.current = trigger
  }, [open, trigger])
  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])
  useEffect(() => {
    if (!open && wasOpen.current && triggerRef.current?.isConnected) {
      triggerRef.current.focus({ preventScroll: true })
      triggerRef.current = null
    }
    wasOpen.current = open
  }, [open])
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel?.()
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel, open])
  if (!open) return null
  return (
    <div className="admin-dialog-scrim" role="presentation">
      <section className="admin-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-confirm-title" aria-describedby="admin-confirm-copy" ref={dialogRef}>
        <div className="admin-dialog-body">
          <span className="admin-eyebrow">Xác nhận thao tác</span>
          <h2 id="admin-confirm-title">{title}</h2>
          <p id="admin-confirm-copy">{consequence}</p>
          <p className="admin-fixed-reason">
            <span>Lý do cố định</span>
            <code>{reasonCode}</code>
          </p>
          {children}
          {error ? (
            <p className="admin-field-error" role="alert">
              {error}
            </p>
          ) : null}
          <p className="admin-sr-only">Có thể nhấn Escape để đóng.</p>
        </div>
        <div className="admin-dialog-actions">
          <button type="button" className="admin-button" ref={cancelRef} onClick={onCancel} disabled={busy}>
            Quay lại
          </button>
          <button type="button" className="admin-button admin-button-primary" ref={confirmRef} onClick={onConfirm} disabled={busy || retryAfter > 0} aria-busy={busy || undefined}>
            {busy ? 'Đang xử lý…' : retryAfter > 0 ? `Thử lại sau ${retryAfter} giây` : 'Xác nhận'}
          </button>
        </div>
      </section>
    </div>
  )
}

function Overview({ data, state, failure, onRetry }) {
  if (state === 'loading') return <LoadingState label="Đang tải tổng quan…" />
  if (failure) return <FailureNotice failure={failure} onRetry={onRetry} />
  const overview = data ?? {}
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">ADMIN-001 · EXCEPTION FIRST</span>
          <h1>Việc cần xử lý</h1>
          <p>Ưu tiên workflow lỗi hoặc bị dừng; bộ đếm khỏe vẫn giữ trong cùng information architecture.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <section className="admin-metrics" aria-label="Bộ đếm vận hành">
        {OVERVIEW_FIELDS.map(([key, label, tone]) => (
          <article className={`admin-metric ${tone}`} key={key}>
            <strong>{overview[key] ?? 0}</strong>
            <span>{key}</span>
            <small>{label}</small>
          </article>
        ))}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-head">
          <div>
            <h2>Ingestion gần nhất</h2>
            <p>
              <code>lastSuccessfulIngestionAt</code> có thể null.
            </p>
          </div>
          <span className={`admin-status ${overview.lastSuccessfulIngestionAt ? 'ok' : 'warning'}`}>{overview.lastSuccessfulIngestionAt ? formatDate(overview.lastSuccessfulIngestionAt) : 'Chưa có lần thành công'}</span>
        </div>
        <p className="admin-muted">Browser chỉ hiển thị trạng thái; không có control chạy maintenance task.</p>
      </section>
    </>
  )
}

function States({ state, failure, onRetry }) {
  if (state === 'loading') return <LoadingState label="Đang tải trạng thái UI…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">STATES · READ ONLY</span>
          <h1>Trạng thái vận hành</h1>
          <p>Ma trận hiển thị rõ loading, empty, error, permission và retry mà không tạo maintenance control.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-state-grid">
        <article className="admin-panel">
          <h2>Đang tải</h2>
          <LoadingState label="Skeleton giữ bố cục ổn định." />
        </article>
        <article className="admin-panel">
          <h2>Trống</h2>
          <EmptyState />
        </article>
        <article className="admin-panel">
          <h2>Lỗi / quyền</h2>
          <p className="admin-muted">401/403 không tiết lộ bản ghi; 500/503 cho phép retry.</p>
        </article>
      </section>
    </>
  )
}

function Articles({ data, state, failure, onRetry, adminApi, readApi, csrfToken, query, onQueryChange, loadingMore, onLoadMore, onNotice }) {
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
              <p>{selected.titleOriginal}</p>
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

const TAKEDOWN_TRANSITIONS = Object.freeze({
  received: [{ status: 'reviewing', reasonCode: 'takedown_review_started', label: 'Bắt đầu review' }],
  reviewing: [
    { status: 'approved', reasonCode: 'takedown_approved', label: 'Phê duyệt' },
    { status: 'rejected', reasonCode: 'takedown_rejected', label: 'Từ chối' },
  ],
  approved: [
    {
      status: 'completed',
      reasonCode: 'takedown_completed',
      label: 'Hoàn tất takedown',
      requiresCompletionProof: true,
    },
  ],
})

const TAKEDOWN_SCOPE_FLAGS = Object.freeze({
  metadata: 'metadataRemoved',
  'media-metadata': 'mediaMetadataRemoved',
  summary: 'summaryRemoved',
  embedding: 'embeddingRemoved',
})

function isTakedownCompletionEligible(detail) {
  if (!detail || detail.status !== 'approved' || detail.completion?.hidden !== true || detail.completion?.historicalChatCitationsRedacted !== true) return false
  return (detail.requestedScope ?? []).every((scope) => detail.completion?.[TAKEDOWN_SCOPE_FLAGS[scope]] === true)
}

function Governance({ data, state, failure, onRetry, readApi, adminApi, csrfToken, onNotice, query, onQueryChange, loadingMore, onLoadMore }) {
  const rows = data?.data ?? []
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [transition, setTransition] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const detailSelectionRef = useRef(null)
  const detailRequestRef = useRef(0)
  const detailInFlightRef = useRef(false)
  const pendingDetailRef = useRef(null)
  const openDetail = useCallback(
    (item) => {
      detailSelectionRef.current = item.id
      setSelected(item)
      setDetailState('loading')
      if (detailInFlightRef.current) {
        pendingDetailRef.current = item
        return
      }
      const fetchDetail = async (target) => {
        detailInFlightRef.current = true
        const requestId = ++detailRequestRef.current
        try {
          const response = await readApi?.getTakedownRequest?.({
            pathParams: { takedownRequestId: target.id },
          })
          if (requestId !== detailRequestRef.current || detailSelectionRef.current !== target.id) return
          setDetail(projectTakedownDetail(response))
          setDetailState('ready')
        } catch {
          if (requestId === detailRequestRef.current && detailSelectionRef.current === target.id) {
            setDetail(null)
            setDetailState('error')
          }
        } finally {
          detailInFlightRef.current = false
          const pending = pendingDetailRef.current
          if (pending && pending.id === detailSelectionRef.current && pending.id !== target.id) {
            pendingDetailRef.current = null
            void fetchDetail(pending)
          } else pendingDetailRef.current = null
        }
      }
      void fetchDetail(item)
    },
    [readApi],
  )
  useEffect(() => {
    if (!selected || !detail || TERMINAL_WORKFLOW_STATES.has(detail.status)) return undefined
    const canPoll = () => globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false
    let timer
    const schedule = () => {
      if (canPoll() && !detailInFlightRef.current) timer = globalThis.setTimeout(() => openDetail(selected), 5_000)
    }
    const resume = () => {
      if (canPoll() && !detailInFlightRef.current) openDetail(selected)
    }
    schedule()
    globalThis.document?.addEventListener?.('visibilitychange', resume)
    globalThis.window?.addEventListener?.('online', resume)
    return () => {
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', resume)
      globalThis.window?.removeEventListener?.('online', resume)
    }
  }, [detail, openDetail, selected])
  const submitTransition = async () => {
    if (!transition || !adminApi?.updateTakedownRequest || !csrfToken) return
    setBusy(true)
    setMutationError(null)
    try {
      await adminApi.updateTakedownRequest({
        pathParams: { takedownRequestId: transition.item.id },
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ status: transition.status, reasonCode: transition.reasonCode }),
      })
      setTransition(null)
      onNotice?.(`Đã chuyển workflow sang ${statusLabel(transition.status)}.`)
      openDetail(transition.item)
    } catch (error) {
      setRetryAfter(Number.isSafeInteger(error?.retryAfter) ? error.retryAfter : 0)
      setMutationError(normalizeAdminFailure(error).message)
    } finally {
      setBusy(false)
    }
  }
  if (state === 'loading') return <LoadingState label="Đang tải governance…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">GOVERNANCE · HIDE FIRST</span>
          <h1>Takedown workflows</h1>
          <p>Workflow pre-purge có review, quyết định all-or-nothing và tiến độ cleanup server.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls query={query} fields={[['status', 'Trạng thái', ['received', 'reviewing', 'approved', 'rejected', 'completed']]]} onApply={onQueryChange} data={data} loadingMore={loadingMore} onLoadMore={onLoadMore} />
        <RecordTable
          rows={rows}
          label="Danh sách takedown"
          columns={[
            ['id', 'Workflow ID', (value) => <code>{value}</code>],
            ['status', 'Trạng thái', statusLabel],
            ['targetType', 'Loại đích'],
            ['targetIds', 'Target IDs', (value) => <code>{value?.join(', ')}</code>],
            ['requestedScope', 'Scope', (value) => <code>{value?.join(', ')}</code>],
            ['updatedAt', 'Cập nhật', formatDate],
          ]}
        />
        {rows.map((item) => (
          <div className="admin-progress" key={`progress-${item.id}`}>
            <div className="admin-panel-head">
              <h2>Workflow {item.id}</h2>
              <span className="admin-status warning">{statusLabel(item.status)}</span>
            </div>
            <ol className="admin-steps">
              <li className={['reviewing', 'approved', 'completed'].includes(item.status) ? 'done' : ''}>Review</li>
              <li className={['approved', 'completed'].includes(item.status) ? 'done' : 'current'}>Hide trước</li>
              <li className={item.status === 'completed' ? 'done' : ''}>Cleanup + citation redaction</li>
            </ol>
            <p className="admin-muted">
              Completion chỉ hợp lệ khi server xác nhận hidden, <code>historicalChatCitationsRedacted</code> và mọi cờ scope.
            </p>
            <div className="admin-record-actions">
              <button type="button" className="admin-button" onClick={() => openDetail(item)}>
                Mở trạng thái an toàn
              </button>
              {(TAKEDOWN_TRANSITIONS[item.status] ?? []).map((next) => {
                const proofReady = !next.requiresCompletionProof || isTakedownCompletionEligible(detail?.id === item.id ? detail : null)
                return (
                  <button
                    type="button"
                    className={`admin-button${next.status === 'rejected' ? ' admin-button-danger' : ''}`}
                    key={next.status}
                    disabled={!proofReady}
                    aria-describedby={!proofReady && next.requiresCompletionProof ? `takedown-completion-${item.id}-proof` : undefined}
                    onClick={(event) => {
                      setMutationError(null)
                      setTransition({ ...next, item, trigger: event.currentTarget })
                    }}
                  >
                    {next.label}
                  </button>
                )
              })}
            </div>
            {item.status === 'approved' && !isTakedownCompletionEligible(detail?.id === item.id ? detail : null) ? (
              <p className="admin-muted" id={`takedown-completion-${item.id}-proof`}>
                Chờ detail proof: hidden, historical citations redacted và mọi scope flag phải true.
              </p>
            ) : null}
          </div>
        ))}
      </section>
      {selected ? (
        <section className="admin-panel" aria-live="off">
          <h2>Workflow {selected.id} detail</h2>
          {detailState === 'loading' ? (
            <LoadingState label="Đang tải trạng thái workflow…" />
          ) : detailState === 'error' || !detail ? (
            <p className="admin-muted">Chi tiết không còn khả dụng; không hiển thị requester/case.</p>
          ) : (
            <>
              <p className="admin-muted">Trạng thái server: {statusLabel(detail.status)}</p>
              {detail.status === 'completed' ? <p className="admin-muted">Workflow terminal; UI không mở branch sau retention purge.</p> : null}
            </>
          )}
        </section>
      ) : null}
      <AdminConfirmationDialog open={Boolean(transition)} trigger={transition?.trigger} title={`${transition?.label ?? 'Cập nhật'}?`} consequence="Server sẽ kiểm tra quyền, lifecycle và completion fence trước khi commit." reasonCode={transition?.reasonCode} retryAfter={retryAfter} busy={busy} error={mutationError} onCancel={() => setTransition(null)} onConfirm={submitTransition} />
    </>
  )
}

function Users({ data, state, failure, onRetry, adminApi, csrfToken, onNavigate, query, onQueryChange, loadingMore, onLoadMore }) {
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

function Deletions({ data, state, failure, onRetry, adminApi, csrfToken, query, onQueryChange, loadingMore, onLoadMore }) {
  const rows = data?.data ?? []
  const [busyId, setBusyId] = useState(null)
  const intentKeys = useRef(new Map())
  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [detail, setDetail] = useState(null)
  const detailSelectionRef = useRef(null)
  const detailRequestRef = useRef(0)
  const detailInFlightRef = useRef(false)
  const pendingDetailRef = useRef(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const retry = async () => {
    const item = confirmation?.item
    if (!adminApi?.retryAccountDeletionRequest || !csrfToken) return
    const intent = `deletion-retry-${item.id}`
    const key = intentKeys.current.get(intent) ?? idempotencyKey(intent)
    intentKeys.current.set(intent, key)
    setBusyId(item.id)
    try {
      await adminApi.retryAccountDeletionRequest({
        pathParams: { deletionRequestId: item.id },
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': key,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ reasonCode: 'account_deletion_retry_requested' }),
      })
      intentKeys.current.delete(intent)
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
  const openDetail = useCallback(
    (item) => {
      detailSelectionRef.current = item.id
      setSelectedItem(item)
      setDetailState('loading')
      if (detailInFlightRef.current) {
        pendingDetailRef.current = item
        return
      }
      const fetchDetail = async (target) => {
        detailInFlightRef.current = true
        const requestId = ++detailRequestRef.current
        try {
          const response = await adminApi?.getAccountDeletionRequest?.({
            pathParams: { deletionRequestId: target.id },
          })
          const payload = response?.data ?? response
          if (requestId !== detailRequestRef.current || detailSelectionRef.current !== target.id) return
          setSelectedItem(payload)
          setDetail(payload)
          setDetailState('ready')
        } catch {
          if (requestId === detailRequestRef.current && detailSelectionRef.current === target.id) {
            setDetail(null)
            setDetailState('error')
          }
        } finally {
          detailInFlightRef.current = false
          const pending = pendingDetailRef.current
          if (pending && pending.id === detailSelectionRef.current && pending.id !== target.id) {
            pendingDetailRef.current = null
            void fetchDetail(pending)
          } else pendingDetailRef.current = null
        }
      }
      void fetchDetail(item)
    },
    [adminApi],
  )
  useEffect(() => {
    if (!selectedItem || !detail || TERMINAL_WORKFLOW_STATES.has(detail.status)) return undefined
    const canPoll = () => globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false
    let timer
    const schedule = () => {
      if (canPoll() && !detailInFlightRef.current) timer = globalThis.setTimeout(() => openDetail(selectedItem), 5_000)
    }
    const resume = () => {
      if (canPoll() && !detailInFlightRef.current) openDetail(selectedItem)
    }
    schedule()
    globalThis.document?.addEventListener?.('visibilitychange', resume)
    globalThis.window?.addEventListener?.('online', resume)
    return () => {
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', resume)
      globalThis.window?.removeEventListener?.('online', resume)
    }
  }, [detail, openDetail, selectedItem])
  if (state === 'loading') return <LoadingState label="Đang tải workflow xóa tài khoản…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">AUTH-006 · AUTOMATIC CLEANUP</span>
          <h1>Xóa tài khoản</h1>
          <p>Admin không phê duyệt deletion; chỉ theo dõi tiến độ và retry request failed.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls query={query} fields={[['status', 'Trạng thái', ['queued', 'running', 'failed', 'completed']]]} onApply={onQueryChange} data={data} loadingMore={loadingMore} onLoadMore={onLoadMore} />
        <RecordTable
          rows={rows}
          label="Danh sách workflow xóa tài khoản"
          columns={[
            ['id', 'Workflow ID', (value) => <code>{value}</code>],
            ['status', 'Trạng thái', statusLabel],
            ['priority', 'Priority'],
            ['attempt', 'Attempt'],
            ['requestedAt', 'Yêu cầu lúc', formatDate],
            ['completedAt', 'Hoàn tất lúc', formatDate],
            ['error', 'SafeError', (value) => value?.message ?? '—'],
          ]}
        />
        {rows.map((item) => (
          <div className="admin-progress" key={`deletion-${item.id}`}>
            <div className="admin-panel-head">
              <h2>Workflow {item.id}</h2>
              <span className="admin-status">{statusLabel(item.status)}</span>
            </div>
            <div className="admin-flags">
              {DELETION_FLAGS.map((flag) => (
                <span key={flag} className={item.completion?.[flag] ? 'true' : 'false'}>
                  {flag}: {item.completion?.[flag] ? 'đã xong' : 'chưa xong'}
                </span>
              ))}
            </div>
            <div className="admin-record-actions">
              <button
                type="button"
                className="admin-button"
                onClick={() => {
                  void openDetail(item)
                }}
              >
                Mở trạng thái workflow
              </button>
              {item.status === 'failed' ? (
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) => {
                    setConfirmationError(null)
                    setConfirmation({ item, trigger: event.currentTarget })
                  }}
                  disabled={busyId === item.id}
                >
                  {busyId === item.id ? 'Đang retry…' : 'Thử lại xóa dữ liệu'}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      {selectedItem ? (
        <section className="admin-panel">
          <h2>Deletion detail</h2>
          {detailState === 'loading' ? <LoadingState label="Đang tải deletion detail…" /> : detailState === 'error' ? <p className="admin-muted">Chi tiết không còn khả dụng.</p> : <p className="admin-muted">Trạng thái server: {statusLabel(selectedItem.status)}</p>}
        </section>
      ) : null}
      <AdminConfirmationDialog
        open={Boolean(confirmation)}
        trigger={confirmation?.trigger}
        title="Retry workflow xóa dữ liệu?"
        consequence="Server sẽ tiếp tục các completion flag còn thiếu; các flag đã hoàn tất được giữ nguyên."
        reasonCode="account_deletion_retry_requested"
        retryAfter={retryAfter}
        busy={Boolean(busyId)}
        error={confirmationError}
        onCancel={() => {
          setConfirmation(null)
          setConfirmationError(null)
        }}
        onConfirm={retry}
      />
    </>
  )
}

function Audit({ data, state, failure, onRetry, query, onQueryChange, loadingMore, onLoadMore }) {
  if (state === 'loading') return <LoadingState label="Đang tải audit…" />
  const rows = data?.data ?? []
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">NFR-017 · READ ONLY</span>
          <h1>Audit bất biến</h1>
          <p>Chỉ structured fields allowlist; không có mutation control hoặc raw export.</p>
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
            ['actorType', 'Actor type'],
            ['actorId', 'Actor ID'],
            ['targetType', 'Target type'],
            ['targetId', 'Target ID'],
          ]}
          onApply={onQueryChange}
          data={data}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
        <RecordTable
          rows={rows}
          label="Danh sách audit"
          columns={[
            ['id', 'Event ID', (value) => <code>{value}</code>],
            ['actorType', 'Actor type'],
            ['actorId', 'Actor ID', (value) => <code>{value}</code>],
            ['action', 'Action', (value) => <code>{value}</code>],
            ['targetType', 'Target type'],
            ['targetId', 'Target ID', (value) => <code>{value}</code>],
            ['changedFields', 'Changed fields', (value) => <code>{value?.join(', ')}</code>],
            ['reasonCode', 'Reason code', (value) => <code>{value}</code>],
            ['result', 'Kết quả'],
            ['createdAt', 'Thời điểm', formatDate],
          ]}
        />
      </section>
    </>
  )
}

export default function AdminOperations({ api, csrfToken, route = 'overview', onNavigate, onSessionExpired, initialData = null }) {
  const [state, setState] = useState(initialData ? 'ready' : 'loading')
  const [data, setData] = useState(initialData)
  const [failure, setFailure] = useState(null)
  const [query, setQuery] = useState({})
  const [loadingMore, setLoadingMore] = useState(false)
  const [adminLive, setAdminLive] = useState('')
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const moreTriggerRef = useRef(null)
  const moreDialogRef = useRef(null)
  const wasMoreOpen = useRef(false)
  const requestId = useRef(0)
  const queryRef = useRef({})
  const operationFor = useMemo(
    () =>
      ({
        overview: 'getAdminOverview',
        articles: 'listAdminArticles',
        governance: 'listTakedownRequests',
        users: 'listAdminUsers',
        deletions: 'listAccountDeletionRequests',
        audit: 'listAuditLogs',
      })[route] ?? null,
    [route],
  )
  const readApi = useMemo(() => createAdminReadApi(api), [api])
  const load = useCallback(
    async ({ nextQuery = queryRef.current, append = false } = {}) => {
      if (!operationFor || !readApi?.[operationFor]) {
        setState('ready')
        return
      }
      queryRef.current = nextQuery
      const current = ++requestId.current
      if (!append) setState('loading')
      else setLoadingMore(true)
      setFailure(null)
      try {
        const response = await readApi[operationFor]({
          credentials: 'same-origin',
          query: nextQuery,
        })
        if (current !== requestId.current) return
        const payload = operationFor === 'getAdminOverview' ? (response?.data ?? response) : response
        if (append && Array.isArray(payload?.data))
          setData((previous) => ({
            ...payload,
            data: [...(previous?.data ?? []), ...payload.data],
          }))
        else setData(payload)
        setState('ready')
      } catch (error) {
        if (current !== requestId.current) return
        if (error.status === 401) onSessionExpired?.('Phiên đăng nhập đã hết hạn khi mở admin workspace.')
        setFailure(normalizeAdminFailure(error))
        if (!append) setState('error')
      } finally {
        if (append) setLoadingMore(false)
      }
    },
    [onSessionExpired, operationFor, readApi],
  )
  useEffect(() => {
    if (initialData) return undefined
    const timer = globalThis.setTimeout(() => {
      void load()
    }, 0)
    return () => globalThis.clearTimeout(timer)
  }, [initialData, load])
  useEffect(() => {
    if (!mobileMoreOpen) {
      if (wasMoreOpen.current) moreTriggerRef.current?.focus?.({ preventScroll: true })
      wasMoreOpen.current = false
      return undefined
    }
    wasMoreOpen.current = true
    moreDialogRef.current?.querySelector?.('button:not([disabled])')?.focus?.({ preventScroll: true })
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileMoreOpen(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusables = [...(moreDialogRef.current?.querySelectorAll?.('button:not([disabled])') ?? [])]
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mobileMoreOpen])
  const applyQuery = useCallback(
    (nextQuery) => {
      setQuery(nextQuery)
      void load({ nextQuery })
    },
    [load],
  )
  const loadMore = useCallback(() => {
    const cursor = data?.meta?.nextCursor
    if (cursor) void load({ nextQuery: { ...queryRef.current, cursor }, append: true })
  }, [data, load])
  const common = {
    data,
    state,
    failure,
    onRetry: () => load(),
    query,
    onQueryChange: applyQuery,
    loadingMore,
    onLoadMore: loadMore,
    onNotice: setAdminLive,
    onNavigate,
  }
  const mobilePrimary = NAV_ITEMS.slice(0, 3)
  const mobileMore = NAV_ITEMS.slice(3)
  return (
    <section className="admin-operations" aria-label="Điều hành quản trị">
      <p id="admin-live-region" className="admin-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {failure?.message ?? adminLive}
      </p>
      <div className="admin-mobile-nav" aria-label="Điều hướng quản trị mobile">
        {mobilePrimary.map((item) => (
          <button
            type="button"
            key={item.id}
            aria-current={route === item.id ? 'page' : undefined}
            onClick={() => {
              setMobileMoreOpen(false)
              onNavigate?.(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
        <button type="button" ref={moreTriggerRef} aria-expanded={mobileMoreOpen} aria-controls="admin-mobile-more" onClick={() => setMobileMoreOpen((open) => !open)}>
          Thêm
        </button>
      </div>
      {mobileMoreOpen ? (
        <div
          className="admin-mobile-more-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setMobileMoreOpen(false)
          }}
        >
          <div id="admin-mobile-more" ref={moreDialogRef} className="admin-mobile-more" role="dialog" aria-modal="true" aria-label="Điều hướng quản trị thêm">
            {mobileMore.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={route === item.id ? 'page' : undefined}
                onClick={() => {
                  setMobileMoreOpen(false)
                  onNavigate?.(item.id)
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {route === 'overview' ? <Overview {...common} /> : null}
      {route === 'articles' ? <Articles {...common} adminApi={readApi} readApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'governance' ? <Governance {...common} readApi={readApi} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'users' ? <Users {...common} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'deletions' ? <Deletions {...common} adminApi={readApi} csrfToken={csrfToken} /> : null}
      {route === 'audit' ? <Audit {...common} /> : null}
      {route === 'states' ? <States {...common} /> : null}
    </section>
  )
}
