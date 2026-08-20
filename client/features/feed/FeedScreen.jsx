import { useEffect, useRef, useState } from 'react'
import ArticleCard, { ContentErrorState, ContentSkeleton } from './ArticleCard.jsx'
import { validateFeedFilters } from './feed-validation.js'
import { useScrollToTop } from '../../theme/use-scroll.js'

const EMPTY_FILTERS = Object.freeze({ topic: '', sourceId: '', publishedAfter: '', publishedBefore: '' })
const PAGE_SIZE = 10

function transportFilters(filters) {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''))
}

function FilterField({ id, label, value, onChange, error, type = 'text', maxLength }) {
  const errorId = `${id}-error`
  return (
    <label className="content-control" htmlFor={id}>
      <span>{label}</span>
      <input id={id} name={id.replace('feed-', '')} type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} />
      {error ? <small className="content-field-error" id={errorId}>{error}</small> : null}
    </label>
  )
}

function PaginationBar({ page, canPrev, canNext, onPrev, onNext }) {
  if (!canPrev && !canNext) return null
  return (
    <nav className="pagination" aria-label="Phân trang feed">
      <button className="pg-btn" type="button" onClick={onPrev} disabled={!canPrev}>‹ Trước</button>
      <span className="pg-info">· Trang {page} ·</span>
      <button className="pg-btn" type="button" onClick={onNext} disabled={!canNext}>Sau ›</button>
    </nav>
  )
}

export function FeedView({ state = 'initial', articles = [], filters = EMPTY_FILTERS, errors = {}, error, meta = { hasNext: false, nextCursor: null }, page = 1, pendingArticleId, loadingMore = false, applying = false, savedOverrides = {}, handlers = {} }) {
  const hasFilters = Object.values(filters).some(Boolean)
  const canPrev = page > 1
  const canNext = state === 'ready' && Boolean(meta.hasNext)
  return (
    <section className="content-screen" aria-labelledby="feed-title">
      <header className="content-screen-header">
        <div><div className="content-eyebrow">Tín hiệu mới nhất</div><h1 id="feed-title">Feed công nghệ</h1><p>Tin công nghệ có provenance rõ ràng và luôn dẫn về nguồn gốc.</p></div>
        <button className="content-button content-button-primary content-search-shortcut" type="button" onClick={handlers.onOpenSearch}>Tìm kiếm</button>
      </header>
      <div className="content-feed-layout">
        <div className="content-results" id="feed-result-region" aria-busy={state === 'loading' || loadingMore}>
          {state === 'loading' ? <><ContentSkeleton label="Đang tải feed" /><ContentSkeleton label="Đang tải feed" /></> : null}
          {state === 'error' ? <ContentErrorState error={error} onRetry={handlers.onRetry} title="Không thể tải feed" /> : null}
          {state === 'ready' && articles.length === 0 ? (
            <section className="content-state">
              <div className="content-eyebrow">Feed trống</div>
              <h2>Không có bài phù hợp</h2>
              <p>{hasFilters ? 'Xóa một vài bộ lọc để mở rộng kết quả.' : 'Chưa có bài đã xuất bản từ nguồn đang hoạt động.'}</p>
              {hasFilters ? <button className="content-button" type="button" onClick={handlers.onClearFilters}>Xóa bộ lọc</button> : null}
            </section>
          ) : null}
          {articles.map((article) => <ArticleCard key={article.id} article={article} savedOverride={savedOverrides[article.id]} busy={pendingArticleId === article.id} onSaveToggle={handlers.onSaveToggle} onOpenArticle={handlers.onOpenArticle} />)}
          {state === 'ready' ? <PaginationBar page={page} canPrev={canPrev} canNext={canNext} onPrev={handlers.onPrevPage} onNext={handlers.onNextPage} /> : null}        </div>
        <aside className="content-filter-rail" aria-labelledby="feed-filter-title">
          <form onSubmit={handlers.onSubmit} noValidate aria-busy={applying || undefined}>
            <div className="content-filter-heading"><h2 id="feed-filter-title">Bộ lọc</h2>{hasFilters ? <button className="content-text-action" type="button" onClick={handlers.onClearFilters} disabled={applying}>Đặt lại</button> : null}</div>
            <FilterField id="feed-topic" label="Chủ đề" value={filters.topic ?? ''} onChange={(value) => handlers.onFilterChange?.('topic', value)} error={errors.topic} maxLength={64} />
            <FilterField id="feed-sourceId" label="Nguồn" value={filters.sourceId ?? ''} onChange={(value) => handlers.onFilterChange?.('sourceId', value)} error={errors.sourceId} maxLength={128} />
            <FilterField id="feed-publishedAfter" label="Từ ngày" value={filters.publishedAfter ?? ''} onChange={(value) => handlers.onFilterChange?.('publishedAfter', value)} error={errors.publishedAfter} type="datetime-local" />
            <FilterField id="feed-publishedBefore" label="Đến ngày" value={filters.publishedBefore ?? ''} onChange={(value) => handlers.onFilterChange?.('publishedBefore', value)} error={errors.publishedBefore} type="datetime-local" />
            <button className="content-button content-button-primary" type="submit" disabled={applying} aria-busy={applying || undefined}>{applying ? 'Đang áp dụng…' : 'Áp dụng bộ lọc'}</button>
          </form>
        </aside>
      </div>
    </section>
  )
}

export default function FeedScreen({ api, csrfToken, savedOverrides = {}, onSavedChange, onOpenArticle, onOpenSearch, onSessionExpired, announce }) {
  const [state, setState] = useState('loading')
  const [articles, setArticles] = useState([])
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS)
  const [errors, setErrors] = useState({})
  const [error, setError] = useState(null)
  const [meta, setMeta] = useState({ hasNext: false, nextCursor: null })
  const [page, setPage] = useState(1)
  const [cursorStack, setCursorStack] = useState([null])
  const [loadingPage, setLoadingPage] = useState(false)
  const [applyingFilters, setApplyingFilters] = useState(false)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const fieldRefs = useRef({})
  const scrollToTop = useScrollToTop()

  async function load({ nextFilters = appliedFilters, page: targetPage = 1, cursor = null, applying = false } = {}) {
    if (targetPage > 1) setLoadingPage(true)
    else setState('loading')
    if (applying) setApplyingFilters(true)
    setError(null)
    try {
      const response = await api.listArticles({ limit: PAGE_SIZE, ...transportFilters(nextFilters), ...(cursor ? { cursor } : {}) })
      setArticles(response.data)
      setMeta(response.meta)
      setPage(targetPage)
      setCursorStack((current) => {
        const next = current.slice(0, targetPage)
        next[targetPage - 1] = response.meta.nextCursor ?? null
        return next
      })
      setState('ready')
      announce?.(`Feed có ${response.data.length} bài ở trang ${targetPage}.`)
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('feed')
      setError(requestError)
      setState('error')
    } finally {
      setLoadingPage(false)
      if (applying) setApplyingFilters(false)
    }
  }

  useEffect(() => {
    let active = true
    api.listArticles({ limit: PAGE_SIZE }).then((response) => {
      if (!active) return
      setArticles(response.data)
      setMeta(response.meta)
      setPage(1)
      setCursorStack([response.meta.nextCursor ?? null])
      setState('ready')
      announce?.(`Feed có ${response.data.length} bài.`)
    }).catch((requestError) => {
      if (!active) return
      if (requestError.status === 401) onSessionExpired?.('feed')
      setError(requestError)
      setState('error')
    })
    return () => { active = false }
  }, [api, announce, onSessionExpired])

  function submit(event) {
    event.preventDefault()
    const validation = validateFeedFilters(filters)
    setErrors(validation.errors)
    if (!validation.valid) {
      document.getElementById(`feed-${validation.firstInvalid}`)?.focus()
      return
    }
    setAppliedFilters(filters)
    load({ nextFilters: filters, page: 1, applying: true })
  }

  function nextPage() {
    if (!meta.hasNext || loadingPage) return
    const cursor = cursorStack[page - 1]
    load({ nextFilters: appliedFilters, page: page + 1, cursor })
    scrollToTop()
  }

  function previousPage() {
    if (page <= 1 || loadingPage) return
    const cursor = page > 2 ? cursorStack[page - 2] : null
    load({ nextFilters: appliedFilters, page: page - 1, cursor })
    scrollToTop()
  }

  async function toggleSave(article, nextSaved) {
    if (!csrfToken) return
    setPendingArticleId(article.id)
    try {
      if (nextSaved) await api.saveArticle(article.id, csrfToken)
      else await api.unsaveArticle(article.id, csrfToken)
      onSavedChange?.(article.id, nextSaved)
      announce?.(nextSaved ? 'Đã lưu bài.' : 'Đã bỏ lưu bài.')
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('feed')
      announce?.('Không thể cập nhật bài đã lưu. Thử lại.')
    } finally {
      setPendingArticleId(null)
    }
  }

  const handlers = {
    onFilterChange: (field, value) => setFilters((current) => ({ ...current, [field]: value })),
    onSubmit: submit,
    onClearFilters: () => { setFilters(EMPTY_FILTERS); setAppliedFilters(EMPTY_FILTERS); setErrors({}); load({ nextFilters: EMPTY_FILTERS, page: 1 }) },
    onRetry: () => load({ nextFilters: appliedFilters, page, cursor: page > 1 ? cursorStack[page - 2] : null }),
    onPrevPage: previousPage,
    onNextPage: nextPage,
    onSaveToggle: toggleSave,
    onOpenArticle,
    onOpenSearch,
  }
  return <FeedView state={state} articles={articles} filters={filters} errors={errors} error={error} meta={meta} page={page} pendingArticleId={pendingArticleId} loadingMore={loadingPage} applying={applyingFilters} savedOverrides={savedOverrides} handlers={handlers} fieldRefs={fieldRefs} />
}
