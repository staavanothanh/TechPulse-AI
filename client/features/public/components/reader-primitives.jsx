import { safeExternalUrl, safeMediaUrl } from '../safe-url.js'
import { articleTitle, formatDate, sourceDomain, sourceName } from './reader-format.js'

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
  onPrevious,
  onNext,
  label = 'Phân trang',
}) {
  if (page <= 1 && !hasNext) return null
  return (
    <nav className="public-pagination" aria-label={label}>
      <button
        className="public-btn public-btn-secondary"
        type="button"
        disabled={page <= 1}
        onClick={onPrevious}
      >
        Trước
      </button>
      <span>Trang {page}</span>
      <button
        className="public-btn public-btn-secondary"
        type="button"
        disabled={!hasNext}
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

export function ArticleCard({ article, busy = false, savedOverride, onOpenArticle, onSaveToggle }) {
  const saved = typeof savedOverride === 'boolean' ? savedOverride : Boolean(article?.isSaved)
  const topics = Array.isArray(article?.topics)
    ? article.topics.filter((topic) => typeof topic === 'string' && topic.trim()).slice(0, 6)
    : []
  const media = article?.leadMedia || article?.media
  const mediaKind = media?.kind || media?.type
  const mediaUrl =
    mediaKind === 'image' && media?.displayMode === 'remote-preview'
      ? safeMediaUrl(media?.url)
      : null
  const videoUrl =
    mediaKind === 'video' && media?.displayMode === 'link-only' ? safeExternalUrl(media?.url) : null
  return (
    <article
      className="public-article-card"
      data-od-id={article?.id ? `card-${article.id}` : undefined}
    >
      <div className="public-card-meta">
        <span>{sourceName(article)}</span>
        {sourceDomain(article) ? <span>{sourceDomain(article)}</span> : null}
        {article?.publishedAt ? (
          <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>
        ) : null}
        {article?.sourceLanguage ? <span>{article.sourceLanguage}</span> : null}
      </div>
      {mediaUrl ? (
        <figure className="public-card-media-figure">
          <img
            className="public-card-media"
            src={mediaUrl}
            alt={media?.altText || ''}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
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
      ) : null}
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
            <span key={topic}>{topic}</span>
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
