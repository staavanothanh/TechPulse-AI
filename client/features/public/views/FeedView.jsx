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
import { EMPTY_FILTERS } from '../components/reader-format.js'

const MAX_DIRECT_PAGE = 10_000

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

function articleSource(article) {
  if (!article || typeof article !== 'object') return null
  if (article.source) return article.source
  if (article.sourceId || article.sourceName) {
    return { sourceId: article.sourceId, sourceName: article.sourceName }
  }
  return null
}

function collectSourceItems(sources, articles) {
  const candidates = [
    ...(Array.isArray(sources) ? sources : []),
    ...(Array.isArray(articles) ? articles.map(articleSource) : []),
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

export default function FeedView({
  state = 'loading',
  articles = [],
  filters = EMPTY_FILTERS,
  sources = [],
  errors = {},
  error,
  meta = {},
  page = 1,
  pendingArticleId,
  applying = false,
  savedOverrides = {},
  saveError = null,
  handlers = {},
}) {
  const nextFilters = { ...EMPTY_FILTERS, ...filters }
  const hasFilters = Object.values(nextFilters).some(Boolean)
  const sourceItems = collectSourceItems(sources, articles)
  const totalItems = Number(meta.totalItems)
  const totalPages = Number.isFinite(totalItems) && totalItems > 0 ? Math.ceil(totalItems / 10) : undefined
  return (
    <section
      className="public-view public-feed-view"
      aria-labelledby="public-feed-title"
      data-od-id="feed"
    >
      <PageHeading
        id="public-feed-title"
        eyebrow="Tín hiệu mới nhất"
        title="Feed công nghệ"
        copy="Tin công nghệ có provenance rõ ràng và luôn dẫn về nguồn gốc."
        action={
          <button
            className="public-btn public-btn-primary"
            type="button"
            onClick={handlers.onOpenSearch}
          >
            Tìm kiếm
          </button>
        }
      />
      <div className="public-feed-layout">
        <div
          className="public-results"
          id="public-feed-results"
          aria-busy={state === 'loading' ? 'true' : 'false'}
        >
          <SaveErrorNotice
            error={saveError}
            onRetry={handlers.onSaveRetry}
            onDismiss={handlers.onDismissSaveError}
          />
          {state === 'loading' ? (
            <>
              <Skeleton label="Đang tải feed" />
              <Skeleton label="Đang tải feed" />
            </>
          ) : null}
          {state === 'error' ? (
            <ErrorState title="Không thể tải feed" error={error} onRetry={handlers.onRetry} />
          ) : null}
          {state === 'ready' && articles.length === 0 ? (
            <StateCard
              eyebrow="Feed trống"
              title="Không có bài phù hợp"
              copy={
                hasFilters
                  ? 'Xóa một vài bộ lọc để mở rộng kết quả.'
                  : 'Chưa có bài đã xuất bản từ nguồn đang hoạt động.'
              }
              action={
                hasFilters ? (
                  <button
                    className="public-btn public-btn-secondary"
                    type="button"
                    onClick={handlers.onClearFilters}
                  >
                    Xóa bộ lọc
                  </button>
                ) : null
              }
            />
          ) : null}
          {state === 'ready'
            ? articles.map((item) => (
                <ArticleCard
                  key={item.id}
                  article={item}
                  savedOverride={savedOverrides[item.id]}
                  busy={pendingArticleId === item.id}
                  onSaveToggle={handlers.onSaveToggle}
                  onOpenArticle={handlers.onOpenArticle}
                />
              ))
            : null}
          <Pagination
            page={page}
            hasNext={Boolean(meta.hasNext)}
            totalPages={totalPages}
            onPrevious={handlers.onPreviousPage}
            onNext={handlers.onNextPage}
            onFirst={handlers.onFirstPage}
            onLast={handlers.onLastPage}
            onPageChange={handlers.onPageChange}
            disabled={state === 'loading'}
            maxPage={MAX_DIRECT_PAGE}
            canGoPrevious={page <= MAX_DIRECT_PAGE}
            label="Phân trang feed"
          />
        </div>
        <aside className="public-filter-rail" aria-labelledby="public-feed-filter-title">
          <div className="public-filter-card">
            <div className="public-filter-heading">
              <h2 id="public-feed-filter-title">Bộ lọc</h2>
              {hasFilters ? (
                <button
                  className="public-text-action"
                  type="button"
                  onClick={handlers.onClearFilters}
                  disabled={applying}
                >
                  Đặt lại
                </button>
              ) : null}
            </div>
            <form onSubmit={handlers.onSubmit} noValidate aria-busy={applying || undefined}>
              <FilterField
                id="public-feed-topic"
                label="Chủ đề"
                value={nextFilters.topic}
                onChange={(value) => handlers.onFilterChange?.('topic', value)}
                error={errors.topic}
                maxLength={64}
                placeholder="Ví dụ: AI"
              />
              <label className="public-field" htmlFor="public-feed-source">
                <span>Nguồn</span>
                <select
                  id="public-feed-source"
                  className="public-input"
                  value={nextFilters.sourceId}
                  onChange={(event) => handlers.onFilterChange?.('sourceId', event.target.value)}
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
                id="public-feed-after"
                label="Từ ngày"
                value={nextFilters.publishedAfter}
                onChange={(value) => handlers.onFilterChange?.('publishedAfter', value)}
                error={errors.publishedAfter}
                type="datetime-local"
              />
              <FilterField
                id="public-feed-before"
                label="Đến ngày"
                value={nextFilters.publishedBefore}
                onChange={(value) => handlers.onFilterChange?.('publishedBefore', value)}
                error={errors.publishedBefore}
                type="datetime-local"
              />
              <button
                className="public-btn public-btn-primary public-btn-block"
                type="submit"
                disabled={applying}
                aria-busy={applying || undefined}
              >
                {applying ? 'Đang áp dụng...' : 'Áp dụng bộ lọc'}
              </button>
            </form>
          </div>
        </aside>
      </div>
    </section>
  )
}

export { FeedView }
