import { useCallback, useRef, useState } from 'react'
import {
  ArticleCard,
  ErrorState,
  PageHeading,
  Pagination,
  SaveErrorNotice,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'
import { useDialogFocus } from '../../qa/dialog-focus.js'
import { safeExternalUrl } from '../safe-url.js'

export default function SavedView({
  state = 'loading',
  articles = [],
  meta = {},
  error,
  saveError = null,
  pendingArticleId,
  clearOpen = false,
  handlers = {},
  maxSavedLimit = 20,
}) {
  const [selectedArticleId, setSelectedArticleId] = useState(null)
  const selectedArticle =
    articles.find((item) => item.id === selectedArticleId) ?? articles[0] ?? null
  const selectedArticleUrl = selectedArticle ? safeExternalUrl(selectedArticle.originalUrl) : null
  const summaryReady = selectedArticle?.summaryStatus === 'ready' && typeof selectedArticle.summaryVi === 'string' && selectedArticle.summaryVi.trim()
  const summaryParagraphs = selectedArticle?.summaryDetailStatus === 'ready' && Array.isArray(selectedArticle.summaryParagraphsVi)
    ? selectedArticle.summaryParagraphsVi.filter((paragraph) => typeof paragraph === 'string' && paragraph.trim()).slice(0, 5)
    : []

  const cancelClearRef = useRef(handlers.onCancelClear)
  const confirmClearRef = useRef(handlers.onConfirmClear)
  cancelClearRef.current = handlers.onCancelClear
  confirmClearRef.current = handlers.onConfirmClear
  const cancelClear = useCallback(() => cancelClearRef.current?.(), [])
  const confirmClear = useCallback(() => confirmClearRef.current?.(), [])
  const clearDialogRef = useDialogFocus(clearOpen, cancelClear)

  return (
    <section
      className="public-view public-saved-view"
      aria-labelledby="public-saved-title"
      data-od-id="saved"
      style={{ maxWidth: '1280px', margin: '0 auto', padding: '0 16px' }}
    >
      {/* Tiêu đề & Bộ đếm chỉ số */}
      <PageHeading
        id="public-saved-title"
        eyebrow="Thư viện cá nhân"
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <span>Bài đã lưu</span>
            <span
              style={{
                fontSize: '0.875rem',
                fontWeight: '600',
                fontFamily: 'inherit',
                padding: '2px 10px',
                borderRadius: '9999px',
                backgroundColor: articles.length >= maxSavedLimit ? 'var(--public-danger-soft)' : 'var(--public-border)',
                color: articles.length >= maxSavedLimit ? 'var(--public-danger)' : 'var(--public-fg)',
                border: `1px solid ${articles.length >= maxSavedLimit ? 'var(--public-danger)' : 'var(--public-border)'}`,
                lineHeight: '1.5',
              }}
            >
              {articles.length}/{maxSavedLimit}
            </span>
          </div>
        }
        copy="Danh sách các bài viết bạn đã lưu để xem lại sau."
        action={
          articles.length > 0 ? (
            <button
              className="public-btn public-btn-secondary"
              type="button"
              onClick={handlers.onOpenClear}
              style={{ color: 'var(--public-danger)', borderColor: 'var(--public-danger)' }}
            >
              Xóa tất cả
            </button>
          ) : null
        }
      />

      <SaveErrorNotice
        error={saveError}
        onRetry={handlers.onSaveRetry}
        onDismiss={handlers.onDismissSaveError}
      />

      {state === 'loading' && (
        <div style={{ display: 'grid', gap: '16px' }}>
          <Skeleton label="Đang tải danh sách bài đã lưu..." />
          <Skeleton label="Đang tải danh sách bài đã lưu..." />
        </div>
      )}

      {state === 'error' && (
        <ErrorState
          title="Không thể tải danh sách bài đã lưu"
          error={error}
          onRetry={handlers.onRetry}
        />
      )}

      {state === 'ready' && articles.length === 0 && (
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
              Khám phá Feed ngay
            </button>
          }
        />
      )}

      {/* BỐ CỤC 2 CỘT */}
      {state === 'ready' && articles.length > 0 && (
        <div
          className="saved-split-layout"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 380px), 1fr))',
            gap: '28px',
            marginTop: '20px',
            alignItems: 'start',
          }}
        >
          {/* CỘT BÊN TRÁI: DANH SÁCH BÀI ĐÃ LƯU */}
          <div
            className="saved-list-column"
            role="list"
            aria-label="Danh sách bài đã lưu"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              maxHeight: 'calc(100vh - 160px)',
              overflowY: 'auto',
              paddingRight: '6px',
            }}
          >
            {articles.map((item) => {
              const isSelected = selectedArticle?.id === item.id
              return (
                <div
                  key={item.id}
                  role="listitem"
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => setSelectedArticleId(item.id)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: '12px',
                    outline: isSelected ? '2px solid var(--public-accent)' : '1px solid transparent',
                    boxShadow: isSelected ? '0 4px 12px rgba(0,0,0,0.08)' : 'none',
                    transition: 'all 0.15s ease-in-out',
                  }}
                >
                  <ArticleCard
                    article={{ ...item, isSaved: true }}
                    savedOverride
                    busy={pendingArticleId === item.id}
                    onSaveToggle={handlers.onUnsave || handlers.onSaveToggle}
                    onOpenArticle={(id, article) => {
                      setSelectedArticleId(item.id)
                      handlers.onOpenArticle?.(id || item.id, article || item)
                    }}
                    onAskAboutArticle={handlers.onAskAboutArticle}
                  />
                </div>
              )
            })}
            {meta.hasNext || meta.page > 1 ? (
              <Pagination
                page={meta.page || 1}
                hasNext={Boolean(meta.hasNext)}
                onPrevious={handlers.onPreviousPage}
                onNext={handlers.onNextPage}
                label="Phân trang bài đã lưu"
              />
            ) : null}
          </div>

          {/* CỘT BÊN PHẢI: KHUNG CHI TIẾT THEO HÌNH 2 */}
          <div
            className="saved-detail-column"
            style={{
              position: 'sticky',
              top: '20px',
              backgroundColor: 'var(--public-surface)',
              borderRadius: '16px',
              padding: '32px',
              border: '1px solid var(--public-border)',
              maxHeight: 'calc(100vh - 100px)',
              overflowY: 'auto',
            }}
          >
            {selectedArticle ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {/* 1. Tóm tắt tiếng Việt */}
                <section>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: '0 0 12px 0', color: 'var(--public-fg)' }}>
                    Tóm tắt tiếng Việt
                  </h3>
                  <div style={{ fontSize: '0.95rem', color: 'var(--public-fg)', lineHeight: '1.6' }}>
                    <p style={{ margin: '0 0 8px 0' }}>
                      {summaryReady
                        ? selectedArticle.summaryVi
                        : 'Nguồn chỉ cung cấp metadata và chưa có đủ thông tin để tóm tắt chi tiết.'}
                    </p>
                    {summaryParagraphs.map((paragraph, index) => (
                      <p style={{ margin: '0 0 12px 0' }} key={`${selectedArticle.id}-saved-summary-${index}`}>
                        {paragraph}
                      </p>
                    ))}
                    <p style={{ fontSize: '0.8125rem', color: 'var(--public-muted)', margin: 0 }}>
                      Tóm tắt do AI tạo. Kiểm chứng với nguồn gốc trước khi sử dụng.
                    </p>
                  </div>
                </section>

                <hr style={{ border: 'none', borderTop: '1px solid var(--public-border)', margin: 0 }} />

                {/* 2. Thông tin nguồn (Grid 2x2) */}
                <section>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: '0 0 16px 0', color: 'var(--public-fg)' }}>
                    Thông tin nguồn
                  </h3>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr',
                      gap: '16px',
                    }}
                  >
                    {/* Tiêu đề gốc */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--public-border)',
                        borderRadius: '12px',
                        backgroundColor: 'var(--public-surface)',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: 'var(--public-muted)', marginBottom: '6px' }}>
                        Tiêu đề gốc
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: 'var(--public-fg)', lineHeight: '1.4' }}>
                        {selectedArticle.titleOriginal || selectedArticle.titleVi || 'N/A'}
                      </div>
                    </div>

                    {/* Nguồn */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--public-border)',
                        borderRadius: '12px',
                        backgroundColor: 'var(--public-surface)',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: 'var(--public-muted)', marginBottom: '6px' }}>
                        Nguồn
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: 'var(--public-fg)' }}>
                        {selectedArticle.sourceName || selectedArticle.source?.name || 'N/A'}
                      </div>
                    </div>

                    {/* Ngôn ngữ */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--public-border)',
                        borderRadius: '12px',
                        backgroundColor: 'var(--public-surface)',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: 'var(--public-muted)', marginBottom: '6px' }}>
                        Ngôn ngữ
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: 'var(--public-fg)' }}>
                        {selectedArticle.sourceLanguage || 'N/A'}
                      </div>
                    </div>

                    {/* Ngày xuất bản */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid var(--public-border)',
                        borderRadius: '12px',
                        backgroundColor: 'var(--public-surface)',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: 'var(--public-muted)', marginBottom: '6px' }}>
                        Ngày xuất bản
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: 'var(--public-fg)' }}>
                        {selectedArticle.publishedAt
                          ? new Date(selectedArticle.publishedAt).toLocaleDateString('vi-VN', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })
                          : 'N/A'}
                      </div>
                    </div>
                  </div>
                </section>

                {/* 3. Nguồn kiểm chứng */}
                <section
                  style={{
                    backgroundColor: 'var(--public-border)',
                    borderRadius: '16px',
                    padding: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: 0, color: 'var(--public-fg)' }}>
                    Nguồn kiểm chứng
                  </h3>
                  <p style={{ margin: 0, fontSize: '0.925rem', color: 'var(--public-fg)' }}>
                    Mở bài gốc để kiểm tra ngữ cảnh và chi tiết đầy đủ.
                  </p>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: 'var(--public-muted)' }}>
                    AI tổng hợp; hãy kiểm chứng với nguồn gốc.
                  </p>
                  {selectedArticleUrl ? (
                    <a
                      href={selectedArticleUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="public-btn"
                      style={{
                        display: 'inline-block',

                        padding: '10px 20px',
                        borderRadius: '9999px',
                        fontWeight: '600',
                        fontSize: '0.875rem',
                        textDecoration: 'none',
                      }}
                    >
                      Mở bài gốc
                    </a>
                  ) : (
                    <button
                      className="public-btn public-btn-secondary"
                      type="button"
                      onClick={() => handlers.onOpenArticle?.(selectedArticle.id, selectedArticle)}
                      style={{ alignSelf: 'flex-start' }}
                    >
                      Xem chi tiết bài viết
                    </button>
                  )}
                </section>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: 'var(--public-muted)', padding: '60px 0' }}>
                Chọn một bài viết bên trái để xem nội dung chi tiết.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dialog xóa tất cả */}
      {clearOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={clearDialogRef}
            className="public-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="public-clear-title"
            aria-describedby="public-clear-description"
            tabIndex={-1}
          >
            <h2 id="public-clear-title" style={{ margin: '0 0 8px 0', fontSize: '1.25rem' }}>
              Xóa tất cả bài đã lưu?
            </h2>
            <p id="public-clear-description" style={{ margin: '0 0 20px 0', color: 'var(--public-muted)' }}>
              Hành động này sẽ xoá toàn bộ danh sách bài viết đã lưu của bạn và không thể hoàn tác.
            </p>
            <div className="public-dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={cancelClear}
              >
                Hủy bỏ
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                onClick={confirmClear}
                disabled={handlers.clearBusy}
              >
                {handlers.clearBusy ? 'Đang xóa...' : 'Xác nhận xóa'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

export { SavedView }
