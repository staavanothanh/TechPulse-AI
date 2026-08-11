import { useEffect, useState } from 'react'
import CitationPanel from '../../components/citation/CitationPanel.jsx'
import { ContentErrorState, ContentSkeleton } from '../feed/ArticleCard.jsx'
import { formatPublishedAt } from '../feed/content-format.js'
import SummaryRegion from '../feed/SummaryRegion.jsx'
import LeadMediaView from './LeadMediaView.jsx'
import { safeHttpsUrl } from './safe-url.js'

export function ArticleDetailView({ state = 'loading', article, error, pendingSave = false, savedOverride, handlers = {} }) {
  if (state === 'loading') return <section className="content-screen" aria-labelledby="detail-loading-title"><h1 className="sr-only" id="detail-loading-title">Đang tải bài viết</h1><ContentSkeleton label="Đang tải bài viết" /></section>
  if (state === 'not-found') return <section className="content-screen content-state"><div className="content-eyebrow">404 · Bài không khả dụng</div><h1>Bài không còn khả dụng</h1><p>Nguồn hoặc bài viết có thể đã thay đổi trạng thái. Quay lại Feed để tiếp tục.</p><button className="content-button content-button-primary" type="button" onClick={handlers.onBack}>Quay lại Feed</button></section>
  if (state === 'error') return <section className="content-screen"><ContentErrorState error={error} onRetry={handlers.onRetry} title="Không thể tải bài viết" /><button className="content-text-action" type="button" onClick={handlers.onBack}>Quay lại Feed</button></section>
  if (!article) return null
  const originalUrl = safeHttpsUrl(article.originalUrl)
  const isSaved = savedOverride ?? article.isSaved
  return (
    <article className="content-screen article-detail" aria-labelledby="article-detail-title">
      <header className="article-detail-header">
        <button className="content-text-action" type="button" onClick={handlers.onBack}>Quay lại Feed</button>
        <div className="content-meta"><span>{article.source.name}</span><time dateTime={article.publishedAt}>{formatPublishedAt(article.publishedAt)}</time><span>{article.sourceLanguage}</span>{article.author ? <span>{article.author}</span> : null}</div>
        <h1 id="article-detail-title">{article.titleVi || article.titleOriginal}</h1>
        {article.titleVi ? <p className="article-original-title">{article.titleOriginal}</p> : null}
        <div className="article-detail-actions">
          <button className="content-button" type="button" aria-pressed={isSaved} disabled={pendingSave} aria-busy={pendingSave || undefined} onClick={() => handlers.onSaveToggle?.(article, !isSaved)}>{pendingSave ? 'Đang cập nhật…' : isSaved ? 'Bỏ lưu bài' : 'Lưu bài'}</button>
        </div>
      </header>
      <div className="article-detail-grid">
        <div className="article-detail-body">
          <LeadMediaView media={article.leadMedia} />
          <SummaryRegion article={article} detail />
          <div className="content-topics" aria-label="Chủ đề">{article.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>
        </div>
        <CitationPanel citation={article.citation} showSourceAction={false} />
      </div>
      {originalUrl ? <aside className="content-verification-band" aria-labelledby="verification-band-title"><div><div className="content-eyebrow">Kiểm chứng với nguồn gốc</div><h2 id="verification-band-title">Đọc bản gốc trước khi kết luận</h2><p>TechPulse chỉ tổng hợp từ dữ liệu được phép; nguồn gốc là điểm kiểm chứng cuối cùng.</p></div><a className="content-button" href={originalUrl} target="_blank" rel="noopener noreferrer external">Mở nguồn gốc</a></aside> : null}
    </article>
  )
}

export default function ArticleDetailScreen({ api, articleId, csrfToken, savedOverrides = {}, onSavedChange, onBack, onSessionExpired, announce }) {
  const [state, setState] = useState('loading')
  const [article, setArticle] = useState(null)
  const [error, setError] = useState(null)
  const [pendingSave, setPendingSave] = useState(false)

  async function load() {
    setState('loading')
    setError(null)
    try {
      const response = await api.getArticle(articleId)
      setArticle(response.data)
      setState('ready')
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('article')
      setError(requestError)
      setState(requestError.status === 404 ? 'not-found' : 'error')
    }
  }
  useEffect(() => {
    let active = true
    api.getArticle(articleId).then((response) => {
      if (!active) return
      setArticle(response.data)
      setState('ready')
    }).catch((requestError) => {
      if (!active) return
      if (requestError.status === 401) onSessionExpired?.('article')
      setError(requestError)
      setState(requestError.status === 404 ? 'not-found' : 'error')
    })
    return () => { active = false }
  }, [api, articleId, onSessionExpired])

  async function toggleSave(current, nextSaved) {
    if (!csrfToken) return
    setPendingSave(true)
    try {
      if (nextSaved) await api.saveArticle(current.id, csrfToken)
      else await api.unsaveArticle(current.id, csrfToken)
      onSavedChange?.(current.id, nextSaved)
      announce?.(nextSaved ? 'Đã lưu bài.' : 'Đã bỏ lưu bài.')
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('article')
      announce?.('Không thể cập nhật bài đã lưu. Thử lại.')
    } finally { setPendingSave(false) }
  }

  return <ArticleDetailView state={state} article={article} error={error} pendingSave={pendingSave} savedOverride={article ? savedOverrides[article.id] : undefined} handlers={{ onRetry: load, onBack, onSaveToggle: toggleSave }} />
}
