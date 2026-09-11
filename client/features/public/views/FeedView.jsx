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
import {
  EMPTY_FILTERS,
  SOURCE_CATALOG,
  groupSourcesByConnector,
} from '../components/reader-format.js'

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
    ...SOURCE_CATALOG,
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
  const hasFilters = Boolean(
    nextFilters.topic || nextFilters.sourceId || nextFilters.publishedAfter || nextFilters.publishedBefore,
  )
  const sourceItems = collectSourceItems(sources, articles)
  const sourceGroups = groupSourcesByConnector(sourceItems)
  const totalItems = Number(meta.totalItems)
  const totalPages = Number.isFinite(totalItems) && totalItems > 0 ? Math.ceil(totalItems / 10) : undefined

  return (
    <section
      className="public-view public-feed-view"
      aria-labelledby="public-feed-title"
      data-od-id="feed"
      style={{ maxWidth: '1200px', margin: '0 auto', padding: '0 16px' }}
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
            style={{ display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            <span>🔍</span> Tìm kiếm nâng cao
          </button>
        }
      />

      <div
        className="public-feed-layout"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))',
          gap: '32px',
          marginTop: '24px',
          alignItems: 'start',
        }}
      >
        <div
          className="public-results"
          id="public-feed-results"
          aria-busy={state === 'loading' ? 'true' : 'false'}
          style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
        >
          <SaveErrorNotice
            error={saveError}
            onRetry={handlers.onSaveRetry}
            onDismiss={handlers.onDismissSaveError}
          />

          {state === 'loading' ? (
            <div style={{ display: 'grid', gap: '16px' }}>
              <Skeleton label="Đang tải feed tín hiệu..." />
              <Skeleton label="Đang tải feed tín hiệu..." />
              <Skeleton label="Đang tải feed tín hiệu..." />
            </div>
          ) : null}

          {state === 'error' ? (
            <ErrorState
              title="Không thể tải danh sách Feed"
              error={error}
              onRetry={handlers.onRetry}
            />
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

          {state === 'ready' && articles.length > 0 ? (
            <div
              className="feed-articles-list"
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              {articles.map((item) => (
                <ArticleCard
                  key={item.id}
                  article={item}
                  savedOverride={savedOverrides[item.id]}
                  busy={pendingArticleId === item.id}
                  onSaveToggle={handlers.onSaveToggle}
                  onOpenArticle={handlers.onOpenArticle}
                  onAskAboutArticle={handlers.onAskAboutArticle}
                />
              ))}
            </div>
          ) : null}

          {state === 'ready' && (
            <div style={{ marginTop: '16px' }}>
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
          )}
        </div>

        <aside className="public-filter-rail" aria-labelledby="public-feed-filter-title">
          <div className="public-filter-card">
            <div
              className="public-filter-heading"
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '16px',
                paddingBottom: '12px',
                borderBottom: '1px solid var(--public-border)',
              }}
            >
              <h2
                id="public-feed-filter-title"
                style={{ fontSize: '1.125rem', fontWeight: '700', margin: 0, color: 'var(--public-fg)' }}
              >
                Bộ lọc tin tức
              </h2>
              {hasFilters ? (
                <button
                  className="public-text-action"
                  type="button"
                  onClick={handlers.onClearFilters}
                  disabled={applying}
                  style={{
                    fontSize: '0.875rem',
                    color: 'var(--public-accent)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: '500',
                  }}
                >
                  Đặt lại
                </button>
              ) : null}
            </div>

            <form
              onSubmit={handlers.onSubmit}
              noValidate
              aria-busy={applying || undefined}
              style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}
            >
              <FilterField
                id="public-feed-topic"
                label="Chủ đề"
                value={nextFilters.topic}
                onChange={(value) => handlers.onFilterChange?.('topic', value)}
                error={errors.topic}
                maxLength={64}
                placeholder="Ví dụ: AI"
              />
              <label
                className="public-field"
                htmlFor="public-feed-source"
                style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.875rem', fontWeight: '500', color: 'var(--public-fg)' }}
              >
                <span>Nguồn tin</span>
                <select
                  id="public-feed-source"
                  className="public-input"
                  value={nextFilters.sourceId}
                  onChange={(event) => handlers.onFilterChange?.('sourceId', event.target.value)}
                  aria-invalid={Boolean(errors.sourceId)}
                  aria-describedby={errors.sourceId ? 'public-feed-source-error' : undefined}
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    border: '1px solid var(--public-border)',
                    backgroundColor: 'var(--public-surface)',
                    fontSize: '0.875rem',
                  }}
                >
                  <option value="">Tất cả nguồn</option>
                  {sourceGroups.map((group) => (
                    <optgroup key={group.key} label={group.label}>
                      {group.items.map((source) => (
                        <option key={source.id} value={source.id}>
                          {source.name || source.id}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {errors.sourceId ? (
                  <small className="public-field-error" id="public-feed-source-error">
                    {errors.sourceId}
                  </small>
                ) : null}
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
                style={{
                  width: '100%',
                  marginTop: '8px',
                  padding: '10px 16px',
                  fontWeight: '600',
                }}
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
