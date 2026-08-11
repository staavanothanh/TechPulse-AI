import { useEffect, useState } from 'react'
import ArticleCard, { ContentErrorState, ContentSkeleton } from '../feed/ArticleCard.jsx'
import { validateSearchInput } from './search-validation.js'

const EMPTY_QUERY = Object.freeze({ q: '', mode: 'hybrid', topic: '', sourceId: '', publishedAfter: '', publishedBefore: '' })

function SearchMetaNotice({ meta }) {
  if (!meta) return null
  return (
    <aside className={`search-meta-notice ${meta.fallbackUsed ? 'degraded' : ''}`} aria-label="Chế độ tìm kiếm">
      <code>requestedMode={meta.requestedMode}</code>
      <code>effectiveMode={meta.effectiveMode}</code>
      <code>fallbackUsed={String(meta.fallbackUsed)}</code>
      <code>fallbackReason={meta.fallbackReason ?? 'null'}</code>
      <p>{meta.fallbackUsed ? 'Đang dùng tìm kiếm văn bản vì embedding chưa khả dụng.' : meta.effectiveMode === 'text' ? 'Kết quả được xếp hạng bằng tín hiệu văn bản.' : 'Kết quả kết hợp tín hiệu văn bản và semantic.'}</p>
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

export function SearchView({ state = 'initial', query = EMPTY_QUERY, errors = {}, results = [], meta, error, cooldown = 0, pendingArticleId, loadingMore = false, savedOverrides = {}, handlers = {} }) {
  const submitDisabled = cooldown > 0 || state === 'loading'
  return (
    <section className="content-screen" aria-labelledby="search-title">
      <header className="content-screen-header"><div><div className="content-eyebrow">Truy xuất có nguồn</div><h1 id="search-title">Tìm kiếm</h1><p>Keyword search vẫn hoạt động khi AI và embedding tắt.</p></div></header>
      <form className="search-form" onSubmit={handlers.onSubmit} noValidate>
        <SearchField id="search-q" label="Từ khóa" value={query.q ?? ''} onChange={(value) => handlers.onQueryChange?.('q', value)} error={errors.q} maxLength={300} />
        <label className="content-control" htmlFor="search-mode"><span>Chế độ yêu cầu</span><select id="search-mode" value={query.mode ?? 'hybrid'} onChange={(event) => handlers.onQueryChange?.('mode', event.target.value)}><option value="text">Văn bản</option><option value="hybrid">Hybrid</option></select></label>
        <SearchField id="search-topic" label="Chủ đề" value={query.topic ?? ''} onChange={(value) => handlers.onQueryChange?.('topic', value)} error={errors.topic} maxLength={64} />
        <SearchField id="search-sourceId" label="Nguồn" value={query.sourceId ?? ''} onChange={(value) => handlers.onQueryChange?.('sourceId', value)} error={errors.sourceId} maxLength={128} />
        <SearchField id="search-publishedAfter" label="Từ ngày" type="datetime-local" value={query.publishedAfter ?? ''} onChange={(value) => handlers.onQueryChange?.('publishedAfter', value)} error={errors.publishedAfter} />
        <SearchField id="search-publishedBefore" label="Đến ngày" type="datetime-local" value={query.publishedBefore ?? ''} onChange={(value) => handlers.onQueryChange?.('publishedBefore', value)} error={errors.publishedBefore} />
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
            <div className="search-scores"><code>score: {result.score.toFixed(3)}</code>{result.textScore !== null ? <code>textScore: {result.textScore.toFixed(3)}</code> : null}{result.semanticScore !== null ? <code>semanticScore: {result.semanticScore.toFixed(3)}</code> : null}</div>
            <ArticleCard article={result.article} savedOverride={savedOverrides[result.article.id]} busy={pendingArticleId === result.article.id} onSaveToggle={handlers.onSaveToggle} onOpenArticle={handlers.onOpenArticle} />
          </div>
        ))}
        {state === 'ready' && meta?.hasNext ? <button className="content-button content-load-more" type="button" onClick={handlers.onLoadMore} disabled={loadingMore} aria-busy={loadingMore || undefined}>{loadingMore ? 'Đang tải thêm…' : 'Tải thêm kết quả'}</button> : null}
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
  const [loadingMore, setLoadingMore] = useState(false)
  const [pendingArticleId, setPendingArticleId] = useState(null)

  useEffect(() => {
    if (cooldown <= 0) return undefined
    const timer = window.setInterval(() => setCooldown((current) => Math.max(0, current - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  async function run(nextQuery, { append = false, cursor = null } = {}) {
    if (append) setLoadingMore(true)
    else setState('loading')
    setError(null)
    try {
      const response = await api.searchArticles({ ...transportQuery(nextQuery), ...(cursor ? { cursor } : {}) })
      setResults((current) => append ? [...current, ...response.data] : response.data)
      setMeta(response.meta)
      setState('ready')
      announce?.(response.data.length === 0 ? 'Không tìm thấy bài phù hợp.' : `Tìm thấy ${response.data.length} kết quả.`)
    } catch (requestError) {
      if (requestError.status === 401) onSessionExpired?.('search')
      if (requestError.status === 429) setCooldown(requestError.retryAfter ?? 60)
      setError(requestError)
      setState('error')
    } finally {
      setLoadingMore(false)
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
    run(query)
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
    onRetry: () => submittedQuery && run(submittedQuery),
    onLoadMore: () => submittedQuery && run(submittedQuery, { append: true, cursor: meta?.nextCursor }),
    onSaveToggle: toggleSave,
    onOpenArticle,
  }
  return <SearchView state={state} query={query} errors={errors} results={results} meta={meta} error={error} cooldown={cooldown} pendingArticleId={pendingArticleId} loadingMore={loadingMore} savedOverrides={savedOverrides} handlers={handlers} />
}
