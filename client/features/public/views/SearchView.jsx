import {
  ArticleCard,
  ErrorState,
  FilterField,
  PageHeading,
  Pagination,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'

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
  handlers = {},
}) {
  const current = { q: '', mode: 'hybrid', topic: '', sourceId: '', publishedAfter: '', ...query }
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
        <FilterField
          id="public-search-topic"
          label="Chủ đề"
          value={current.topic}
          onChange={(value) => handlers.onQueryChange?.('topic', value)}
          error={errors.topic}
          maxLength={64}
        />
        <FilterField
          id="public-search-source"
          label="Nguồn"
          value={current.sourceId}
          onChange={(value) => handlers.onQueryChange?.('sourceId', value)}
          error={errors.sourceId}
          maxLength={128}
        />
        <FilterField
          id="public-search-after"
          label="Từ ngày"
          value={current.publishedAfter}
          onChange={(value) => handlers.onQueryChange?.('publishedAfter', value)}
          error={errors.publishedAfter}
          type="datetime-local"
        />
      </div>
      <SearchMeta meta={meta} mode={current.mode} visible={state === 'ready'} />
      <div
        className="public-results"
        id="public-search-results"
        aria-busy={state === 'loading' ? 'true' : 'false'}
      >
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
