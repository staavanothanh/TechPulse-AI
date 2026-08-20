import { useEffect, useState } from 'react'
import ArticleCard, { ContentErrorState, ContentSkeleton } from '../feed/ArticleCard.jsx'
import { validateSearchInput } from './search-validation.js'
import { useScrollToTop } from '../../theme/use-scroll.js'

const EMPTY_QUERY = Object.freeze({ q: '', mode: 'hybrid', topic: '', sourceId: '', publishedAfter: '', publishedBefore: '' })
const PAGE_SIZE = 10

function SearchMetaNotice({ meta }) {
  if (!meta) return null
  const fallbackCopy = {
    'embedding-unavailable': 'Chỉ mục ngữ nghĩa chưa sẵn sàng. Kết quả văn bản vẫn đầy đủ.',
    'no-compatible-vectors': 'Không có vector tương thích với phiên bản truy vấn hiện tại. Kết quả văn bản vẫn khả dụng.',
    'provider-timeout': 'Dịch vụ ngữ nghĩa tạm gián đoạn; kết quả từ khóa vẫn khả dụng.',
  }
  const copy = meta.fallbackUsed
    ? fallbackCopy[meta.fallbackReason] ?? 'Tìm kiếm ngữ nghĩa tạm gián đoạn; kết quả từ khóa vẫn khả dụng.'
    : meta.effectiveMode === 'hybrid' ? 'Tìm kiếm hybrid đang kết hợp tín hiệu từ khóa và ngữ nghĩa.' : 'Kết quả được xếp hạng bằng tín hiệu văn bản.'
  return (
    <aside className={`search-meta-notice ${meta.fallbackUsed ? 'degraded' : ''}`} aria-label="Chế độ tìm kiếm">
      <strong>{meta.effectiveMode === 'hybrid' ? 'Tìm kiếm hybrid' : 'Tìm kiếm văn bản'}</strong>
      <p>{copy}</p>
    </aside>
  )
}

function SearchField({ id, label, value, onChange, error, type = 'text', maxLength }) {
  return (
    <label className="content-control" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} />
      {error ? <small className="content-field-error" id={`${id}-error`}>{error}</small> : null}
    </label>
  )
}

function PaginationBar({ page, canPrev, canNext, onPrev, onNext }) {
  if (!canPrev && !canNext) return null
  return (
    <nav className="pagination" aria-label="Phân trang kết quả tìm kiếm">
      <button className="pg-btn" type="button" onClick={onPrev} disabled={!canPrev}>‹ Trước</button>
      <span className="pg-info">· Trang {page} ·</span>
      <button className="pg-btn" type="button" onClick={onNext} disabled={!canNext}>Sau ›</button>
    </nav>
  )
}

export function SearchView({ state = 'initial', query = EMPTY_QUERY, errors = {}, results = [], meta, error, cooldown = 0, page = 1, pendingArticleId, loadingMore = false, savedOverrides = {}, handlers = {} }) {
  const submitDisabled = cooldown > 0 || state === 'loading'
  const canNext = state === 'ready' && Boolean(meta?.hasNext)
  return (
    <section className="content-screen" aria-labelledby="search-title">
      <header className="content-screen-header"><div><div className="content-eyebrow">Truy xuất có nguồn</div><h1 id="search-title">Tìm kiếm</h1><p>Keyword search vẫn hoạt động khi AI và embedding tắt.</p></div></header>
      <form className="search-form" onSubmit={handlers.onSubmit} noValidate>
        <SearchField id="search-q" label="Từ khóa" value={query.q ?? ''} onChange={(value) => handlers.onQueryChange?.('q', value)} error={errors.q} maxLength={300} />
        <div className="search-filters">
          <label className="content-control" htmlFor="search-mode"><span>Chế độ yêu cầu</span><select id="search-mode" value={query.mode ?? 'hybrid'} onChange={(event) => handlers.onQueryChange?.('mode', event.target.value)}><option value="text">Văn bản</option><option value="hybrid">Hybrid</option></select></label>
          <SearchField id="search-topic" label="Chủ đề" value={query.topic ?? ''} onChange={(value) => handlers.onQueryChange?.('topic', value)} error={errors.topic} maxLength={64} />
          <SearchField id="search-sourceId" label="Nguồn" value={query.sourceId ?? ''} onChange={(value) => handlers.onQueryChange?.('sourceId', value)} error={errors.sourceId} maxLength={128} />
          <SearchField id="search-publishedAfter" label="Từ ngày" type="datetime-local" value={query.publishedAfter ?? ''} onChange={(value) => handlers.onQueryChange?.('publishedAfter', value)} error={errors.publishedAfter} />
        </div>
        <button className="content-button content-button-primary" type="submit" disabled={submitDisabled} aria-busy={state === 'loading' || undefined}>{cooldown > 0 ? `Thử lại sau ${cooldown}s` : state === 'loading' ? 'Đang tìm…' : 'Tìm bài'}</button>
      </form>
      <SearchMetaNotice meta={meta} />
      <div className="content-results search-results" id="search-result-region" aria-busy={state === 'loading' || loadingMore}>
        {state === 'initial' ? <section className="content-state"><div className="content-eyebrow">Sẵn sàng tìm</div><h2>Nhập từ khóa để bắt đầu</h2><p>Dùng ít nhất hai ký tự. Có thể kết hợp chủ đề, nguồn và thời gian.</p></section> : null}
        {state === 'loading' ? <><ContentSkeleton label="Đang tìm bài" /><ContentSkeleton label="Đang tìm bài" /></> : null}
        {state === 'error' ? <ContentErrorState error={error} onRetry={cooldown > 0 ? null : handlers.onRetry} title="Không thể hoàn tất tìm kiếm" /> : null}
        {state === 'ready' && results.length === 0 ? <section className="content-state"><div className="content-eyebrow">Không có kết quả</div><h2>Không tìm thấy bài phù hợp</h2><p>Thử từ khóa ngắn hơn hoặc bỏ bớt bộ lọc.</p></section> : null}
        {results.map((result) => (
          <div className="search-result" key={result.article.id}>
            <ArticleCard article={result.article} savedOverride={savedOverrides[result.article.id]} busy={pendingArticleId === result.article.id} onSaveToggle={handlers.onSaveToggle} onOpenArticle={handlers.onOpenArticle} />
          </div>
        ))}
        {state === 'ready' ? <PaginationBar page={page} canPrev={page > 1} canNext={canNext} onPrev={handlers.onPrevPage} onNext={handlers.onNextPage} /> : null}
      </div>
    </section>
  )
}

function transportQuery(query) {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ''))
}

export default function SearchScreen({ api, csrfToken, savedOverrides = {}, onSavedChange, onOpenArticle, onSessionExpired, announce }) {
  const [query, setQuery] = useState(EMPTY_QUERY)
  const [submittedQuery, setSubmittedQuery] = useState(null)
  const [errors, setErrors] = useState({})
  const [state, setState] = useState('initial')
  const [results, setResults] = useState([])
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState(null)
  const [cooldown, setCooldown] = useState(0)
  const [page, setPage] = useState(1)
  const [cursorStack, setCursorStack] = useState([null])
  const [loadingPage, setLoadingPage] = useState(false)
  const [pendingArticleId, setPendingArticleId] = useState(null)
  const scrollToTop = useScrollToTop()

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = window.setInterval(() => setCooldown((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  async function run(nextQuery, { cursor = null, page: targetPage = 1 } = {}) {
    if (targetPage > 1) setLoadingPage(true)
    else setState('loading')
    setError(null)
    try {
      const response = await api.searchArticles({ limit: PAGE_SIZE, ...transportQuery(nextQuery), ...(cursor ? { cursor } : {}) })
      setResults(response.data)
      setMeta(response.meta)
      setPage(targetPage)
      setCursorStack((current) => {
        const next = current.slice(0, targetPage)
        next[targetPage - 1] = response.meta?.nextCursor ?? null
        return next
      })
      setState('ready')
      announce?.(response.data.length === 0 ? 'Không tìm thấy bài phù hợp.' : `Tìm thấy ${response.data.length} kết quả.`)
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('search')
      if (requestError.status === 429) setCooldown(requestError.retryAfter ?? 60)
      setError(requestError)
      setState('error')
    } finally {
      setLoadingPage(false)
    }
  }

  function submit(event) {
    event.preventDefault()
    const validation = validateSearchInput(query)
    setErrors(validation.errors)
    if (!validation.valid) {
      document.getElementById(`search-${validation.firstInvalid}`)?.focus()
      return
    }
    setSubmittedQuery(query)
    run(query, { page: 1 })
  }

  function nextPage() {
    if (!meta?.hasNext || loadingPage || !submittedQuery) return
    const cursor = cursorStack[page - 1]
    run(submittedQuery, { page: page + 1, cursor })
    scrollToTop()
  }

  function previousPage() {
    if (page <= 1 || loadingPage || !submittedQuery) return
    const cursor = page > 2 ? cursorStack[page - 2] : null
    run(submittedQuery, { page: page - 1, cursor })
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
      if (requestError.status === 401) onSessionExpired?.('search')
      announce?.('Không thể cập nhật bài đã lưu. Thử lại.')
    } finally { setPendingArticleId(null) }
  }

  const handlers = {
    onQueryChange: (field, value) => setQuery((current) => ({ ...current, [field]: value })),
    onSubmit: submit,
    onRetry: () => submittedQuery && run(submittedQuery, { page: 1 }),
    onPrevPage: previousPage,
    onNextPage: nextPage,
    onSaveToggle: toggleSave,
    onOpenArticle,
  }
  return <SearchView state={state} query={query} errors={errors} results={results} meta={meta} error={error} cooldown={cooldown} page={page} pendingArticleId={pendingArticleId} loadingMore={loadingPage} savedOverrides={savedOverrides} handlers={handlers} />
}
