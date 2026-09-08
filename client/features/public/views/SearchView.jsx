import {
  ArticleCard,
  ErrorState,
  FilterField,
  PageHeading,
  Pagination,
  SaveErrorNotice,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'
import { TOPICS } from '../components/reader-format.js'

function sourceOption(source) {
  if (typeof source === 'string') {
    const id = source.trim()
    return id ? { id, name: id } : null
  }
  if (!source || typeof source !== 'object') return null
  const id = typeof source.id === 'string' && source.id.trim()
    ? source.id.trim()
    : typeof source.sourceId === 'string' && source.sourceId.trim()
      ? source.sourceId.trim()
      : ''
  if (!id) return null
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim()
    : typeof source.sourceName === 'string' && source.sourceName.trim()
      ? source.sourceName.trim()
      : id
  return { id, name }
}

function articleSource(item) {
  const article = item?.article || item
  if (!article || typeof article !== 'object') return null
  if (article.source) return article.source
  if (article.sourceId || article.sourceName) {
    return { sourceId: article.sourceId, sourceName: article.sourceName }
  }
  return null
}

function collectSourceItems(sources, results) {
  const candidates = [
    ...(Array.isArray(sources) ? sources : []),
    ...(Array.isArray(results) ? results.map(articleSource) : []),
  ]
  return Array.from(
    new Map(
      candidates
        .map(sourceOption)
        .filter(Boolean)
        .map((source) => [source.id, source]),
    ).values(),
  )
}

export default function SearchView({
  state = 'initial',
  query = {},
  results = [],
  meta = {},
  errors = {},
  error,
  page = 1,
  pendingArticleId,
  savedOverrides = {},
  saveError = null,
  handlers = {},
  topics = TOPICS,
  sources = [],
}) {
  const current = {
    q: '',
    mode: 'hybrid',
    topic: '',
    sourceId: '',
    publishedAfter: '',
    publishedBefore: '',
    ...query,
  }
  const sourceItems = collectSourceItems(sources, results)
  return (
    <section
      className="public-view public-search-view"
      aria-labelledby="public-search-title"
      data-od-id="search"
    >
      <PageHeading
        id="public-search-title"
        eyebrow="Truy xuất có nguồn"
        title="Tìm kiếm"
        copy="Tìm kiếm văn bản vẫn hoạt động khi AI hoặc embedding tạm thời không sẵn sàng."
      />
      <form className="public-search-bar" onSubmit={handlers.onSubmit} noValidate>
        <FilterField
          id="public-search-q"
          label="Từ khóa"
          value={current.q}
          onChange={(value) => handlers.onQueryChange?.('q', value)}
          error={errors.q}
          maxLength={300}
          placeholder="Nhập ít nhất 2 ký tự"
        />
        <button
          className="public-btn public-btn-primary"
          type="submit"
          disabled={state === 'loading'}
          aria-busy={state === 'loading' || undefined}
        >
          {state === 'loading' ? 'Đang tìm...' : 'Tìm bài'}
        </button>
      </form>
      <div className="public-search-filters">
        <label className="public-field" htmlFor="public-search-mode">
          <span>Chế độ</span>
          <select
            id="public-search-mode"
            className="public-input"
            value={current.mode}
            onChange={(event) => handlers.onQueryChange?.('mode', event.target.value)}
          >
            <option value="hybrid">Hybrid</option>
            <option value="text">Văn bản</option>
          </select>
        </label>
        <label className="public-field" htmlFor="public-search-topic">
          <span>Chủ đề</span>
          <select
            id="public-search-topic"
            className="public-input"
            value={current.topic}
            onChange={(event) => handlers.onQueryChange?.('topic', event.target.value)}
          >
            <option value="">Tất cả chủ đề</option>
            {topics.map((topic) => (
              <option key={topic} value={topic}>
                {topic}
              </option>
            ))}
          </select>
        </label>
        <label className="public-field" htmlFor="public-search-source">
          <span>Nguồn</span>
          <select
            id="public-search-source"
            className="public-input"
            value={current.sourceId}
            onChange={(event) => handlers.onQueryChange?.('sourceId', event.target.value)}
          >
            <option value="">Tất cả nguồn</option>
            {sourceItems.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name || source.id}
              </option>
            ))}
          </select>
        </label>
        <FilterField
          id="public-search-after"
          label="Từ ngày"
          value={current.publishedAfter}
          onChange={(value) => handlers.onQueryChange?.('publishedAfter', value)}
          error={errors.publishedAfter}
          type="datetime-local"
        />
        <FilterField
          id="public-search-before"
          label="Đến ngày"
          value={current.publishedBefore}
          onChange={(value) => handlers.onQueryChange?.('publishedBefore', value)}
          error={errors.publishedBefore}
          type="datetime-local"
        />
      </div>
      <SearchMeta meta={meta} mode={current.mode} visible={state === 'ready'} />
      <div
        className="public-results"
        id="public-search-results"
        aria-busy={state === 'loading' ? 'true' : 'false'}
      >
        <SaveErrorNotice
          error={saveError}
          onRetry={handlers.onSaveRetry}
          onDismiss={handlers.onDismissSaveError}
        />
        {state === 'initial' ? (
          <StateCard
            eyebrow="Sẵn sàng tìm"
            title="Nhập từ khóa để bắt đầu"
            copy="Dùng ít nhất hai ký tự. Có thể kết hợp chủ đề, nguồn và thời gian."
          />
        ) : null}
        {state === 'loading' ? (
          <>
            <Skeleton label="Đang tìm bài" />
            <Skeleton label="Đang tìm bài" />
          </>
        ) : null}
        {state === 'error' ? (
          <ErrorState
            title="Không thể hoàn tất tìm kiếm"
            error={error}
            onRetry={handlers.onRetry}
          />
        ) : null}
        {state === 'ready' && results.length === 0 ? (
          <StateCard
            eyebrow="Không có kết quả"
            title="Không tìm thấy bài phù hợp"
            copy="Thử từ khóa ngắn hơn hoặc bỏ bớt bộ lọc."
          />
        ) : null}
        {state === 'ready'
          ? results.map((item) => {
              const value = item?.article || item
              return (
                <ArticleCard
                  key={value.id}
                  article={value}
                  savedOverride={savedOverrides[value.id]}
                  busy={pendingArticleId === value.id}
                  onSaveToggle={handlers.onSaveToggle}
                  onOpenArticle={handlers.onOpenArticle}
                  onAskAboutArticle={handlers.onAskAboutArticle}
                />
              )
            })
          : null}
        <Pagination
          page={page}
          hasNext={Boolean(meta?.hasNext)}
          onPrevious={handlers.onPreviousPage}
          onNext={handlers.onNextPage}
          label="Phân trang kết quả tìm kiếm"
        />
      </div>
    </section>
  )
}

function SearchMeta({ meta, mode = 'hybrid', visible = false }) {
  if (!visible && (!meta || (!meta.effectiveMode && !meta.fallbackUsed))) return null
  const fallback = meta.fallbackUsed
  const effectiveMode = meta.effectiveMode || mode
  return (
    <aside
      className={`public-search-meta${fallback ? ' is-degraded' : ''}`}
      aria-label="Chế độ tìm kiếm"
    >
      <strong>
        {fallback
          ? 'Chỉ mục ngữ nghĩa tạm thời chưa sẵn sàng'
          : effectiveMode === 'hybrid'
            ? 'Tìm kiếm hybrid'
            : 'Tìm kiếm văn bản'}
      </strong>
      <span>
        {fallback
          ? 'Kết quả văn bản vẫn khả dụng.'
          : effectiveMode === 'hybrid'
            ? 'Kết hợp tín hiệu từ khóa và ngữ nghĩa.'
            : 'Xếp hạng bằng tín hiệu văn bản.'}
      </span>
    </aside>
  )
}

export { SearchView }
