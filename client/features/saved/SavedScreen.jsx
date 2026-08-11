import { useEffect, useRef, useState } from 'react'
import ArticleCard, { ContentErrorState, ContentSkeleton } from '../feed/ArticleCard.jsx'
import ClearSavedDialog from './ClearSavedDialog.jsx'

export function SavedView({ state = 'loading', articles = [], meta = { hasNext: false, nextCursor: null }, error, pendingArticleId, loadingMore = false, clearOpen = false, clearBusy = false, handlers = {}, listRef, emptyHeadingRef, clearTriggerRef }) {
  return (
    <section className="content-screen" aria-labelledby="saved-title">
      <header className="content-screen-header">
        <div><div className="content-eyebrow">Tài khoản của bạn</div><h1 id="saved-title">Bài đã lưu</h1><p>Danh sách chỉ chứa bài còn hiển thị theo Source policy hiện hành.</p></div>
        {articles.length > 0 ? <button className="content-button content-button-danger" type="button" onClick={handlers.onOpenClear} ref={clearTriggerRef}>Xóa tất cả</button> : null}
      </header>
      <div className="content-results saved-results" role="region" aria-label="Danh sách bài đã lưu" aria-busy={state === 'loading' || Boolean(pendingArticleId) || loadingMore || clearBusy} tabIndex="-1" ref={listRef}>
        {state === 'loading' ? <><ContentSkeleton label="Đang tải bài đã lưu" /><ContentSkeleton label="Đang tải bài đã lưu" /></> : null}
        {state === 'error' ? <ContentErrorState error={error} onRetry={handlers.onRetry} title="Không thể tải bài đã lưu" /> : null}
        {state === 'ready' && articles.length === 0 ? <section className="content-state saved-empty"><div className="content-eyebrow">Danh sách trống</div><h2 tabIndex="-1" ref={emptyHeadingRef}>Chưa có bài đã lưu</h2><p>Lưu bài từ Feed, Search hoặc Article detail để xem lại tại đây.</p><button className="content-button content-button-primary" type="button" onClick={handlers.onOpenFeed}>Khám phá Feed</button></section> : null}
        {articles.map((article) => <ArticleCard key={article.id} article={{ ...article, isSaved: true }} savedOverride busy={pendingArticleId === article.id} savedContext onSaveToggle={(current) => handlers.onUnsave?.(current)} onOpenArticle={handlers.onOpenArticle} />)}
        {state === 'ready' && meta.hasNext ? <button className="content-button content-load-more" type="button" onClick={handlers.onLoadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>{loadingMore ? 'Đang tải thêm…' : 'Tải thêm bài đã lưu'}</button> : null}
      </div>
      <ClearSavedDialog open={clearOpen} busy={clearBusy} onCancel={handlers.onCancelClear} onConfirm={handlers.onConfirmClear} />
    </section>
  )
}

export default function SavedScreen({ api, csrfToken, onSavedChange, onOpenArticle, onOpenFeed, onSessionExpired, announce }) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [error, setError] = useState(null)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearBusy, setClearBusy] = useState(false)
  const listRef = useRef(null)
  const emptyHeadingRef = useRef(null)
  const clearTriggerRef = useRef(null)

  async function load({ append = false, cursor = null } = {}) {
    if (append) setLoadingMore(true)
    else setState('loading')
    setError(null)
    try {
      const response = await api.listSavedArticles({ limit: 100, ...(cursor ? { cursor } : {}) })
      setArticles((current) => append ? [...current, ...response.data] : response.data)
      setMeta(response.meta)
      for (const article of response.data) onSavedChange?.(article.id, true)
      setState('ready')
      announce?.(response.data.length === 0 ? 'Danh sách bài đã lưu hiện trống.' : `Có ${response.data.length} bài đã lưu.`)
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('saved')
      setError(requestError)
      setState('error')
    } finally { setLoadingMore(false) }
  }
  useEffect(() => {
    let active = true
    api.listSavedArticles({ limit: 100 }).then((response) => {
      if (!active) return
      setArticles(response.data)
      setMeta(response.meta)
      for (const article of response.data) onSavedChange?.(article.id, true)
      setState('ready')
      announce?.(response.data.length === 0 ? 'Danh sách bài đã lưu hiện trống.' : `Có ${response.data.length} bài đã lưu.`)
    }).catch((requestError) => {
      if (!active) return
      if (requestError.status === 401) onSessionExpired?.('saved')
      setError(requestError)
      setState('error')
    })
    return () => { active = false }
  }, [api, announce, onSavedChange, onSessionExpired])

  async function unsave(article) {
    if (!csrfToken) return
    setPendingArticleId(article.id)
    try {
      await api.unsaveArticle(article.id, csrfToken)
      setArticles((current) => current.filter((item) => item.id !== article.id))
      onSavedChange?.(article.id, false)
      announce?.('Đã bỏ lưu bài.')
      window.requestAnimationFrame(() => listRef.current?.focus())
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('saved')
      announce?.('Không thể bỏ lưu bài. Thử lại.')
    } finally { setPendingArticleId(null) }
  }

  function cancelClear() {
    setClearOpen(false)
    window.requestAnimationFrame(() => clearTriggerRef.current?.focus())
  }

  async function clear() {
    if (!csrfToken) return
    setClearBusy(true)
    try {
      await api.clearSavedArticles(csrfToken)
      for (const article of articles) onSavedChange?.(article.id, false)
      setArticles([])
      setMeta({ hasNext: false, nextCursor: null })
      setClearOpen(false)
      setState('ready')
      announce?.('Đã xóa tất cả bài đã lưu.')
      window.requestAnimationFrame(() => emptyHeadingRef.current?.focus())
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('saved')
      announce?.(requestError.status === 429 ? `Thử lại sau ${requestError.retryAfter ?? 60} giây.` : 'Không thể xóa danh sách đã lưu. Thử lại.')
    } finally { setClearBusy(false) }
  }

  return <SavedView state={state} articles={articles} meta={meta} error={error} pendingArticleId={pendingArticleId} loadingMore={loadingMore} clearOpen={clearOpen} clearBusy={clearBusy} listRef={listRef} emptyHeadingRef={emptyHeadingRef} clearTriggerRef={clearTriggerRef} handlers={{ onRetry: () => load(), onLoadMore: () => load({ append: true, cursor: meta.nextCursor }), onUnsave: unsave, onOpenClear: () => setClearOpen(true), onCancelClear: cancelClear, onConfirmClear: clear, onOpenArticle, onOpenFeed }} />
}
