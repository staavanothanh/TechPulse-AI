import {
  ArticleCard,
  ErrorState,
  PageHeading,
  Pagination,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'

export default function SavedView({
  state = 'loading',
  articles = [],
  meta = {},
  error,
  pendingArticleId,
  clearOpen = false,
  handlers = {},
}) {
  return (
    <section
      className="public-view public-saved-view"
      aria-labelledby="public-saved-title"
      data-od-id="saved"
    >
      <PageHeading
        id="public-saved-title"
        eyebrow="Thư viện của bạn"
        title="Bài đã lưu"
        copy="Bài bạn đã lưu để đọc sau, từ Feed và Tìm kiếm."
        action={
          articles.length > 0 ? (
            <button
              className="public-btn public-btn-secondary"
              type="button"
              onClick={handlers.onOpenClear}
            >
              Xóa lịch sử lưu
            </button>
          ) : null
        }
      />
      <div
        className="public-results"
        id="public-saved-results"
        role="region"
        aria-label="Danh sách bài đã lưu"
        aria-live="polite"
        aria-busy={state === 'loading' ? 'true' : 'false'}
      >
        {state === 'loading' ? (
          <>
            <Skeleton label="Đang tải bài đã lưu" />
            <Skeleton label="Đang tải bài đã lưu" />
          </>
        ) : null}
        {state === 'error' ? (
          <ErrorState title="Không thể tải bài đã lưu" error={error} onRetry={handlers.onRetry} />
        ) : null}
        {state === 'ready' && articles.length === 0 ? (
          <StateCard
            eyebrow="Danh sách trống"
            title="Chưa có bài đã lưu"
            copy="Lưu bài từ Feed hoặc Tìm kiếm để xem lại tại đây."
            action={
              <button
                className="public-btn public-btn-primary"
                type="button"
                onClick={handlers.onOpenFeed}
              >
                Khám phá Feed
              </button>
            }
          />
        ) : null}
        {state === 'ready'
          ? articles.map((item) => (
              <ArticleCard
                key={item.id}
                article={{ ...item, isSaved: true }}
                savedOverride
                busy={pendingArticleId === item.id}
                onSaveToggle={handlers.onUnsave || handlers.onSaveToggle}
                onOpenArticle={handlers.onOpenArticle}
              />
            ))
          : null}
        <Pagination
          page={meta.page || 1}
          hasNext={Boolean(meta.hasNext)}
          onPrevious={handlers.onPreviousPage}
          onNext={handlers.onNextPage}
          label="Phân trang bài đã lưu"
        />
      </div>
      {clearOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            className="public-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="public-clear-title"
          >
            <h2 id="public-clear-title">Xóa tất cả bài đã lưu?</h2>
            <p>Thao tác này không thể hoàn tác.</p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={handlers.onCancelClear}
              >
                Hủy
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                onClick={handlers.onConfirmClear}
                disabled={handlers.clearBusy}
              >
                {handlers.clearBusy ? 'Đang xóa...' : 'Xác nhận'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

export { SavedView }
