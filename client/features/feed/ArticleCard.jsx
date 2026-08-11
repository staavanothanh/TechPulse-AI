import LeadMediaView from '../article-detail/LeadMediaView.jsx'
import { contentErrorCopy, formatPublishedAt } from './content-format.js'
import SummaryRegion from './SummaryRegion.jsx'

export default function ArticleCard({ article, onSaveToggle, onOpenArticle, busy = false, savedOverride, savedContext = false, saveActionLabel, saveActionDisabled = false }) {
  const isSaved = savedOverride ?? article.isSaved
  const title = article.titleVi || article.titleOriginal
  return (
    <article className="content-card" data-article-id={article.id} aria-busy={busy || undefined}>
      <div className="content-meta">
        <span>{article.source.name}</span>
        <time dateTime={article.publishedAt}>{formatPublishedAt(article.publishedAt)}</time>
        <span>{article.sourceLanguage}</span>
        {article.source.authorityTier === 'community-signal' ? <span className="content-community">Tín hiệu cộng đồng</span> : null}
      </div>
      <h2 className="content-card-title">
        {onOpenArticle ? <button className="content-title-action" type="button" onClick={() => onOpenArticle(article.id)}>{title}</button> : title}
      </h2>
      {article.titleVi ? <p className="content-original-title">{article.titleOriginal}</p> : null}
      <LeadMediaView media={article.leadMedia} />
      <SummaryRegion article={article} />
      <div className="content-topics" aria-label="Chủ đề">{article.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
      <div className="content-card-actions">
        <button className="content-button" type="button" aria-pressed={isSaved} aria-busy={busy || undefined} disabled={busy || saveActionDisabled} onClick={() => onSaveToggle?.(article, !isSaved)}>
          {saveActionLabel ?? (busy ? 'Đang cập nhật…' : isSaved ? savedContext ? 'Bỏ lưu bài này' : 'Bỏ lưu bài' : 'Lưu bài')}
        </button>
        {onOpenArticle ? <button className="content-text-action" type="button" onClick={() => onOpenArticle(article.id)}>Đọc chi tiết</button> : null}
      </div>
    </article>
  )
}

export function ContentSkeleton({ label = 'Đang tải nội dung' }) {
  return (
    <article className="content-card content-skeleton" aria-busy="true">
      <span className="sr-only">{label}</span>
      <i /><i /><i /><i />
    </article>
  )
}

export function ContentErrorState({ error, onRetry, title = 'Không thể tải nội dung' }) {
  return (
    <section className="content-state content-state-error" role="alert">
      <div className="content-eyebrow">Yêu cầu chưa hoàn tất</div>
      <h2>{title}</h2>
      <p>{contentErrorCopy(error)}</p>
      {error?.requestId ? <code>requestId: {error.requestId}</code> : null}
      {onRetry ? <button className="content-button" type="button" onClick={onRetry}>Thử tải lại</button> : null}
    </section>
  )
}
