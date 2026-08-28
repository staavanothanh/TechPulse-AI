import { forwardRef, useEffect, useRef, useState } from 'react'
import { listMeta, statusLabel, statusTone } from './admin-data.js'

const SOURCE_DICTIONARY = new Map()

export function registerSourceDictionary(sources = []) {
  if (!Array.isArray(sources)) return
  for (const source of sources) {
    if (source && source.id) {
      SOURCE_DICTIONARY.set(source.id, {
        id: source.id,
        name: source.name || source.title || source.id,
        operationalStatus: source.operationalStatus || source.status || 'unknown',
        connector: source.connector || source.type || 'rss',
        policyVersion: source.policyVersion,
      })
    }
  }
}

export function getSourceFromDictionary(sourceId) {
  if (!sourceId) return null
  return SOURCE_DICTIONARY.get(sourceId) || null
}

export function clearSourceDictionary() {
  SOURCE_DICTIONARY.clear()
}

const ARTICLE_PREVIEW_CACHE = new Map()

export function getCachedArticlePreview(id) {
  if (!id) return null
  return ARTICLE_PREVIEW_CACHE.get(String(id)) || null
}

export function cacheArticlePreview(id, data) {
  if (id && data) ARTICLE_PREVIEW_CACHE.set(String(id), data)
}

export function clearArticlePreviewCache() {
  ARTICLE_PREVIEW_CACHE.clear()
}
function Icon({ name, size = 18 }) {
  const paths = {
    activity: (
      <>
        <path d="M4 12h3l2-6 4 12 2-6h5" />
        <path d="M4 4v16M20 4v16" />
      </>
    ),
    archive: (
      <>
        <path d="M4 7h16v12H4z" />
        <path d="M3 4h18v3H3zM9 11h6" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h13" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    book: (
      <>
        <path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H20v18H7.5A2.5 2.5 0 0 0 5 22z" />
        <path d="M5 4.5v15M9 6h7M9 10h7" />
      </>
    ),
    check: (
      <>
        <path d="m5 12 4 4L19 6" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
      </>
    ),
    jobs: (
      <>
        <path d="M9 5h6M9 12h6M9 19h6" />
        <rect x="3" y="3" width="18" height="18" rx="2" />
      </>
    ),
    articles: <path d="M4 5h16M4 12h16M4 19h10" />,
    audit: (
      <>
        <path d="M12 3v18M5 6l14 12M19 6L5 18" />
        <circle cx="12" cy="12" r="9" />
      </>
    ),
    grid: (
      <>
        <path d="M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 11h6V4h-6z" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </>
    ),
    moon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
    pause: (
      <>
        <path d="M7 5v14M17 5v14" />
      </>
    ),
    play: <path d="m8 5 11 7-11 7z" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 0 0-14.8-4L3 10" />
        <path d="M3 5v5h5M4 13a8 8 0 0 0 14.8 4L21 14" />
        <path d="M21 19v-5h-5" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4.5" />
        <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M19.4 4.6l-1.8 1.8M6.4 17.6l-1.8 1.8" />
      </>
    ),
    user: (
      <>
        <circle cx="9" cy="8" r="4" />
        <path d="M3 21c0-4 2.7-6 6-6s6 2 6 6M16 4a4 4 0 0 1 0 8M19 15c2 1 3 2.8 3 6" />
      </>
    ),
    account: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </>
    ),
    eye: (
      <>
        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </>
    ),
    x: (
      <>
        <path d="m6 6 12 12M18 6 6 18" />
      </>
    ),
  }
  return (
    <svg
      className="admin-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.activity}
    </svg>
  )
}

export const AdminButton = forwardRef(function AdminButton(
  { children, variant = 'secondary', size = 'normal', icon, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`admin-btn admin-btn-${variant}${size === 'small' ? ' admin-btn-small' : ''}`}
      type="button"
      {...props}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      <span>{children}</span>
    </button>
  )
})

function StatusBadge({ value, label = statusLabel(value) }) {
  return (
    <span className={`admin-status admin-status-${statusTone(value)}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  )
}

function CompactId({
  id,
  label = 'ID',
  length = 12,
  copyable = true,
  showFull = false,
  className = '',
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  if (!id && id !== 0) return <span className="admin-muted">—</span>
  const strId = String(id)
  const displayText =
    showFull || strId.length <= length
      ? strId
      : strId.length > 16
        ? `${strId.slice(0, 7)}…${strId.slice(-4)}`
        : `${strId.slice(0, length)}…`

  async function handleCopy(event) {
    event.stopPropagation()
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(strId)
      }
      setCopied(true)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  if (!copyable) {
    return (
      <span className={`admin-compact-id ${className}`} title={strId}>
        <code className="admin-mono">{displayText}</code>
      </span>
    )
  }

  return (
    <span className={`admin-compact-id ${copied ? 'admin-compact-id-copied' : ''} ${className}`}>
      <code className="admin-mono" title={strId}>
        {displayText}
      </code>
      <button
        type="button"
        className="admin-compact-id-btn"
        onClick={handleCopy}
        title={copied ? `Đã sao chép ${label}` : `Sao chép ${label}: ${strId}`}
        aria-label={`Sao chép ${label}: ${strId}`}
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
      <span className="admin-sr-only" role="status" aria-live="polite">
        {copied ? `Đã sao chép ${label}` : ''}
      </span>
    </span>
  )
}

function SourceBadge({ sourceId, source, showId = false, className = '' }) {
  const resolved = source || (sourceId ? getSourceFromDictionary(sourceId) : null)
  if (!resolved && !sourceId) return <span className="admin-muted">—</span>

  const name = resolved?.name || sourceId
  return (
    <span className={`admin-source-badge ${className}`} title={`Nguồn: ${name} (${sourceId || resolved?.id})`}>
      <Icon name="globe" size={13} />
      <span className="admin-source-badge-name">{name}</span>
      {showId && sourceId ? <CompactId id={sourceId} label="Source ID" length={8} /> : null}
    </span>
  )
}

function PageHeader({ eyebrow, title, description, action = null }) {
  return (
    <header className="admin-page-header">
      <div>
        <p className="admin-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? <p className="admin-page-description">{description}</p> : null}
      </div>
      {action ? <div className="admin-page-actions">{action}</div> : null}
    </header>
  )
}

function Panel({ title, hint, children, className = '' }) {
  return (
    <section className={`admin-panel ${className}`}>
      <div className="admin-panel-heading">
        <div>
          {title ? <h2>{title}</h2> : null}
          {hint ? <p>{hint}</p> : null}
        </div>
      </div>
      {children}
    </section>
  )
}

function LoadingState({ label = 'Đang tải dữ liệu…' }) {
  return (
    <div className="admin-state admin-state-loading" aria-busy="true">
      <span className="admin-skeleton admin-skeleton-wide" />
      <span className="admin-skeleton" />
      <span className="admin-skeleton admin-skeleton-short" />
      <p>{label}</p>
    </div>
  )
}

function ErrorState({ message, onRetry }) {
  return (
    <div className="admin-state admin-state-error" role="alert">
      <div>
        <strong>Không thể tải dữ liệu</strong>
        <p>{message}</p>
      </div>
      {onRetry ? (
        <AdminButton variant="secondary" size="small" icon="refresh" onClick={onRetry}>
          Thử lại
        </AdminButton>
      ) : null}
    </div>
  )
}

function EmptyState({
  title = 'Chưa có bản ghi phù hợp.',
  description = 'Bộ lọc hiện tại chưa trả về dữ liệu.',
}) {
  return (
    <div className="admin-empty">
      <Icon name="archive" size={22} />
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  )
}

function Table({ label, columns, rows, emptyTitle, children }) {
  if (!rows.length) return <EmptyState title={emptyTitle} />
  return (
    <div className="admin-table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            {children ? (
              <th>
                <span className="admin-sr-only">Thao tác</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id ?? index}>
              {columns.map((column) => (
                <td key={column.key}>
                  {column.render
                    ? column.render(row[column.key], row)
                    : (row[column.key] ?? 'Chưa ghi nhận')}
                </td>
              ))}
              {children ? <td className="admin-table-actions">{children(row)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResourceFrame({ resource, children, loadingLabel }) {
  if (resource.state === 'loading') return <LoadingState label={loadingLabel} />
  if (resource.state === 'error')
    return <ErrorState message={resource.error} onRetry={resource.reload} />
  const meta = listMeta(resource.data)
  return (
    <>
      {children}
      {meta.hasNext && resource.loadMore ? (
        <div className="admin-pagination">
          <AdminButton
            variant="secondary"
            icon="arrow"
            onClick={resource.loadMore}
            disabled={resource.loadingMore}
          >
            {resource.loadingMore ? 'Đang tải thêm…' : 'Tải thêm'}
          </AdminButton>
        </div>
      ) : null}
    </>
  )
}

export function AdminConfirmDialog({
  open = false,
  title,
  consequence,
  reasonCode,
  busy = false,
  onCancel,
  onConfirm,
}) {
  const dialogRef = useRef(null)
  const cancelRef = useRef(null)
  useEffect(() => {
    if (open) cancelRef.current?.focus?.({ preventScroll: true })
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
      const focusables = [
        ...(dialogRef.current?.querySelectorAll?.('button:not([disabled])') ?? []),
      ]
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
    <div className="admin-confirm-scrim" role="presentation">
      <section
        className="admin-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        aria-describedby="admin-confirm-copy"
        ref={dialogRef}
      >
        <p className="admin-eyebrow">Xác nhận thao tác</p>
        <h2 id="admin-confirm-title">{title}</h2>
        <p id="admin-confirm-copy">{consequence}</p>
        <p className="admin-confirm-reason">
          <span>Reason code cố định</span>
          <code>{reasonCode}</code>
        </p>
        <div className="admin-confirm-actions">
          <AdminButton variant="secondary" onClick={onCancel} disabled={busy} ref={cancelRef}>
            Quay lại
          </AdminButton>
          <AdminButton variant="primary" onClick={onConfirm} disabled={busy}>
            {busy ? 'Đang xử lý…' : 'Xác nhận'}
          </AdminButton>
        </div>
      </section>
    </div>
  )
}

function ArticlePreviewDialog({
  open = false,
  articleId = null,
  api,
  onClose,
}) {
  const [loading, setLoading] = useState(false)
  const [article, setArticle] = useState(null)
  const [error, setError] = useState(null)
  const dialogRef = useRef(null)
  const closeRef = useRef(null)

  useEffect(() => {
    if (!open || !articleId) {
      setArticle(null)
      setError(null)
      setLoading(false)
      return undefined
    }

    const cached = getCachedArticlePreview(articleId)
    if (cached) {
      setArticle(cached)
      setError(null)
      setLoading(false)
      return undefined
    }

    if (!api?.getArticle && !api?.getAdminArticle) {
      setLoading(false)
      return undefined
    }

    let active = true
    setLoading(true)
    setError(null)

    const fetcher = api.getAdminArticle
      ? api.getAdminArticle({ pathParams: { articleId: String(articleId) }, credentials: 'same-origin' })
      : api.getArticle({ pathParams: { articleId: String(articleId) }, credentials: 'same-origin' })

    void Promise.resolve(fetcher)
      .then((res) => {
        if (!active) return
        const data = res?.data?.data ?? res?.data ?? null
        if (data) cacheArticlePreview(articleId, data)
        setArticle(data)
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        setError(err?.message || 'Không thể tải thông tin bài viết')
        setLoading(false)
      })

    return () => {
      active = false
    }
  }, [api, articleId, open])

  useEffect(() => {
    if (open) closeRef.current?.focus?.({ preventScroll: true })
  }, [open, loading])

  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose?.()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="admin-confirm-scrim" role="presentation" onClick={onClose}>
      <section
        className="admin-confirm-dialog admin-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-preview-title"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-preview-header">
          <div>
            <p className="admin-eyebrow">Xem nhanh bài viết</p>
            <h2 id="admin-preview-title">
              {loading
                ? 'Đang tải thông tin…'
                : article?.status === 'removed'
                  ? 'Bài viết đã gỡ bỏ (Tombstone)'
                  : article?.titleOriginal || article?.titleVi || `Bài viết #${articleId}`}
            </h2>
          </div>
          <button
            type="button"
            className="admin-preview-close"
            onClick={onClose}
            aria-label="Đóng xem trước"
            ref={closeRef}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {loading ? (
          <div className="admin-preview-loading" aria-busy="true">
            <span className="admin-skeleton admin-skeleton-wide" />
            <span className="admin-skeleton" />
          </div>
        ) : error ? (
          <div className="admin-preview-error" role="alert">
            <p>{error}</p>
          </div>
        ) : article?.status === 'removed' ? (
          <div className="admin-preview-body">
            <p className="admin-muted">
              Bài viết này đã được gỡ bỏ khỏi hệ thống theo quy trình takedown. Toàn bộ nội dung và metadata đã bị xóa an toàn.
            </p>
            <div className="admin-preview-meta">
              <span>Mã bài viết:</span>
              <CompactId id={articleId} label="Article ID" />
            </div>
          </div>
        ) : (
          <div className="admin-preview-body">
            {article?.topics && article.topics.length ? (
              <div className="admin-preview-topics">
                {article.topics.map((topic) => (
                  <span key={topic} className="admin-chip">{topic}</span>
                ))}
              </div>
            ) : null}

            {article?.summaryVi ? (
              <div className="admin-preview-section">
                <strong>Tóm tắt AI (Tiếng Việt)</strong>
                <p>{article.summaryVi}</p>
              </div>
            ) : article?.excerptOriginal ? (
              <div className="admin-preview-section">
                <strong>Trích đoạn gốc</strong>
                <p>{article.excerptOriginal}</p>
              </div>
            ) : null}

            <div className="admin-preview-grid">
              <div>
                <small>Nguồn tin</small>
                <SourceBadge sourceId={article?.sourceId} showId />
              </div>
              <div>
                <small>Trạng thái AI</small>
                <div className="admin-status-group">
                  <StatusBadge value={article?.summaryStatus || 'pending'} label={`Summary: ${article?.summaryStatus || 'pending'}`} />
                  <StatusBadge value={article?.embeddingStatus || 'pending'} label={`Embedding: ${article?.embeddingStatus || 'pending'}`} />
                </div>
              </div>
            </div>

            <div className="admin-preview-meta">
              <span>Mã bài viết:</span>
              <CompactId id={articleId} label="Article ID" />
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

export {
  Icon,
  StatusBadge,
  CompactId,
  SourceBadge,
  ArticlePreviewDialog,
  PageHeader,
  Panel,
  LoadingState,
  ErrorState,
  EmptyState,
  Table,
  ResourceFrame,
}
