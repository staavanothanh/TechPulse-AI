import { useState } from 'react'
import { safeExternalUrl, safeMediaUrl } from '../safe-url.js'
import { articleTitle, formatDate, sourceDomain, sourceName, topicLabel } from './reader-format.js'

export function PageHeading({ id, eyebrow, title, copy, action = null }) {
  return (
    <header className="public-page-heading">
      <div>
        <p className="public-eyebrow">{eyebrow}</p>
        <h1 id={id}>{title}</h1>
        {copy ? <p>{copy}</p> : null}
      </div>
      {action}
    </header>
  )
}

export function StateCard({ eyebrow = 'Trạng thái', title, copy, action = null, role }) {
  return (
    <section className="public-state-card" role={role}>
      <p className="public-eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      {copy ? <p>{copy}</p> : null}
      {action}
    </section>
  )
}

export function ErrorState({ title, error, onRetry }) {
  const message = typeof error === 'string' ? error : error?.message
  return (
    <StateCard
      eyebrow="Không thể tải"
      title={title}
      copy={message || 'Thử lại sau khi kiểm tra kết nối.'}
      role="alert"
      action={
        <>
          {error?.requestId ? (
            <small className="public-form-note">Mã yêu cầu: {error.requestId}</small>
          ) : null}
          {onRetry ? (
            <button className="public-btn public-btn-secondary" type="button" onClick={onRetry}>
              Thử lại
            </button>
          ) : null}
        </>
      }
    />
  )
}

export function Skeleton({ label = 'Đang tải nội dung' }) {
  return (
    <div className="public-skeleton" aria-busy="true" aria-label={label}>
      <span />
      <span />
      <span />
    </div>
  )
}

export function Pagination({
  page = 1,
  hasNext = false,
  totalPages,
  onPrevious,
  onNext,
  onFirst,
  onLast,
  onPageChange,
  disabled = false,
  maxPage,
  canGoPrevious = true,
  label = 'Phân trang',
}) {
  const hasTotalPages = Number.isInteger(totalPages) && totalPages > 0
  const directPageLimit = Number.isInteger(maxPage) && maxPage > 0 ? maxPage : totalPages
  const hasDirectPageLimit = hasTotalPages && directPageLimit < totalPages

  if (page <= 1 && !hasNext) return null
  if (hasTotalPages) {
    const commitPage = (value, input) => {
      const parsedValue = Number.parseInt(value, 10)
      if (!Number.isInteger(parsedValue)) {
        if (input) input.value = String(page)
        return
      }
      const nextPage = Math.min(Math.max(parsedValue, 1), totalPages)
      if (nextPage > directPageLimit && nextPage !== totalPages) {
        if (input) input.value = String(page)
        return
      }
      if (nextPage !== page) onPageChange?.(nextPage)
      else if (input) input.value = String(page)
    }
    return (
      <nav className="public-pagination" aria-label={label}>
        <button
          className="public-btn public-btn-secondary"
          type="button"
          disabled={disabled || page <= 1}
          onClick={onFirst}
        >
          Đầu
        </button>
        <button
          className="public-btn public-btn-secondary"
          type="button"
          disabled={disabled || page <= 1 || !canGoPrevious}
          onClick={onPrevious}
        >
          Trước
        </button>
        <span aria-live="polite">Trang {page}/{totalPages}</span>
        <label className="public-pagination-jump">
          <span className="public-sr-only">Số trang</span>
          <input
            key={page}
            className="public-input public-pagination-input"
            type="number"
            min="1"
            max={totalPages}
            inputMode="numeric"
            defaultValue={page}
            disabled={disabled}
            aria-label="Số trang"
            aria-describedby={hasDirectPageLimit ? `${label.replaceAll(/\s+/g, '-').toLowerCase()}-page-limit` : undefined}
            onBlur={(event) => commitPage(event.currentTarget.value, event.currentTarget)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                commitPage(event.currentTarget.value, event.currentTarget)
              }
            }}
          />
        </label>
        <button
          className="public-btn public-btn-secondary"
          type="button"
          disabled={disabled || !hasNext || page >= totalPages}
          onClick={onNext}
        >
          Sau
        </button>
        <button
          className="public-btn public-btn-secondary"
          type="button"
          disabled={disabled || !hasNext || page >= totalPages}
          onClick={onLast}
        >
          Cuối
        </button>
        {hasDirectPageLimit ? (
          <span className="public-pagination-hint" id={`${label.replaceAll(/\s+/g, '-').toLowerCase()}-page-limit`}>
            Trang trung gian tối đa {directPageLimit}; dùng Đầu hoặc Cuối để di chuyển nhanh.
          </span>
        ) : null}
      </nav>
    )
  }
  return (
    <nav className="public-pagination" aria-label={label}>
      <button
        className="public-btn public-btn-secondary"
        type="button"
        disabled={disabled || page <= 1}
        onClick={onPrevious}
      >
        Trước
      </button>
      <span>Trang {page}</span>
      <button
        className="public-btn public-btn-secondary"
        type="button"
        disabled={disabled || !hasNext}
        onClick={onNext}
      >
        Sau
      </button>
    </nav>
  )
}

export function Summary({ article }) {
  if (article?.summaryStatus === 'pending' || article?.summaryStatus === 'processing')
    return (
      <div className="public-summary public-summary-pending" aria-busy="true">
        <span>Đang tạo tóm tắt...</span>
      </div>
    )
  if (article?.summaryStatus !== 'ready' || !article.summaryVi) return null
  const basis =
    article.summaryBasis === 'excerpt'
      ? 'đoạn trích nguồn'
      : article.summaryBasis === 'metadata'
        ? 'metadata nguồn'
        : null
  return (
    <div className="public-summary">
      <p>{article.summaryVi}</p>
      <span>{basis ? `AI tổng hợp từ ${basis}` : 'AI tổng hợp'}</span>
    </div>
  )
}

export function MediaImage({ src, alt = '', fallbackLabel = 'Ảnh nguồn không khả dụng', className = 'public-card-media' }) {
  const [failedSrc, setFailedSrc] = useState(null)
  const failed = failedSrc === src
  if (!src || failed) {
    return (
      <div className={`${className} ${className.includes('detail') ? 'public-detail-media-fallback' : 'public-card-media-placeholder'}`} role="img" aria-label={fallbackLabel}>
        <span>{fallbackLabel}</span>
      </div>
    )
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading="lazy"
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onError={() => setFailedSrc(src)}
    />
  )
}

export function ArticleCard({ article, busy = false, savedOverride, onOpenArticle, onSaveToggle }) {
  const saved = typeof savedOverride === 'boolean' ? savedOverride : Boolean(article?.isSaved)
  const sourceLabel = sourceName(article)
  const topics = Array.isArray(article?.topics)
    ? article.topics.filter((topic) => typeof topic === 'string' && topic.trim()).slice(0, 6)
    : []
  const media = article?.leadMedia || article?.media
  const mediaKind = media?.kind || media?.type
  const mediaUrl =
    mediaKind === 'image' && media?.displayMode === 'remote-preview'
      ? safeMediaUrl(media?.url, media?.allowedHosts)
      : null
  const videoUrl =
    mediaKind === 'video' && media?.displayMode === 'link-only'
      ? safeExternalUrl(media?.sourcePageUrl)
      : null
  return (
    <article
      className="public-article-card"
      data-od-id={article?.id ? `card-${article.id}` : undefined}
    >
      <div className="public-card-meta">
        <span>{sourceLabel}</span>
        {sourceDomain(article) ? <span>{sourceDomain(article)}</span> : null}
        {article?.publishedAt ? (
          <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>
        ) : null}
        {article?.sourceLanguage ? <span>{article.sourceLanguage}</span> : null}
      </div>
      {mediaUrl ? (
        <figure className="public-card-media-figure">
          <MediaImage src={mediaUrl} alt={media?.altText || ''} fallbackLabel={`Ảnh nguồn: ${sourceLabel}`} />
          {media?.attribution ? <figcaption>{media.attribution}</figcaption> : null}
        </figure>
      ) : videoUrl ? (
        <div className="public-video-link">
          <a
            className="public-media-link"
            href={videoUrl}
            target="_blank"
            rel="noopener noreferrer external"
          >
            Mở video nguồn
          </a>
          <span>Video nguồn chưa được AI phân tích.</span>
        </div>
      ) : (
        <div
          className="public-card-media public-card-media-placeholder"
          role="img"
          aria-label={`Ảnh nguồn: ${sourceLabel}`}
        >
          <span>{sourceLabel}</span>
        </div>
      )}
      <h2 className="public-article-title">
        <button type="button" onClick={() => onOpenArticle?.(article?.id, article)}>
          {articleTitle(article)}
        </button>
      </h2>
      {article?.titleVi && article?.titleOriginal ? (
        <p className="public-original-title">{article.titleOriginal}</p>
      ) : null}
      <Summary article={article} />
      {topics.length > 0 ? (
        <div className="public-topic-row" aria-label="Chủ đề">
          {topics.map((topic) => (
            <span key={topic}>{topicLabel(topic)}</span>
          ))}
        </div>
      ) : null}
      <div className="public-card-actions">
        <button
          className="public-icon-btn"
          type="button"
          aria-pressed={saved}
          disabled={busy}
          onClick={() => onSaveToggle?.(article, !saved)}
        >
          <svg
            viewBox="0 0 24 24"
            fill={saved ? 'currentColor' : 'none'}
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z" />
          </svg>
          <span>{busy ? 'Đang cập nhật...' : saved ? 'Bỏ lưu bài' : 'Lưu bài'}</span>
        </button>
        <button
          className="public-text-action"
          type="button"
          onClick={() => onOpenArticle?.(article?.id, article)}
        >
          Đọc chi tiết
        </button>
      </div>
    </article>
  )
}

export function FilterField({
  id,
  label,
  value,
  onChange,
  error,
  type = 'text',
  maxLength,
  placeholder,
}) {
  return (
    <label className="public-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        className="public-input"
        type={type}
        value={value ?? ''}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => onChange?.(event.target.value)}
        aria-invalid={Boolean(error)}
      />
      {error ? <small className="public-field-error">{error}</small> : null}
    </label>
  )
}
