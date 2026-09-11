import { useCallback, useRef, useState, useEffect } from 'react'
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
  const [selectedArticle, setSelectedArticle] = useState(null)

  // Tự động chọn bài viết đầu tiên trong danh sách khi tải xong
  useEffect(() => {
    if (articles.length > 0 && (!selectedArticle || !articles.some((a) => a.id === selectedArticle.id))) {
      setSelectedArticle(articles[0])
    } else if (articles.length === 0) {
      setSelectedArticle(null)
    }
  }, [articles, selectedArticle])

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
                backgroundColor: articles.length >= maxSavedLimit ? '#fef2f2' : '#f3f4f6',
                color: articles.length >= maxSavedLimit ? '#dc2626' : '#374151',
                border: `1px solid ${articles.length >= maxSavedLimit ? '#fca5a5' : '#e5e7eb'}`,
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
              style={{ color: '#dc2626', borderColor: '#fca5a5' }}
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
          eyebrow="Thư viện trống"
          title="Bạn chưa lưu bài viết nào"
          copy="Khám phá các bài viết mới từ Trang chủ hoặc Tìm kiếm để lưu lại đọc sau."
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
            gridTemplateColumns: '380px 1fr',
            gap: '28px',
            marginTop: '20px',
            alignItems: 'start',
          }}
        >
          {/* CỘT BÊN TRÁI: DANH SÁCH BÀI ĐÃ LƯU */}
          <div
            className="saved-list-column"
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
                  onClick={() => setSelectedArticle(item)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: '12px',
                    outline: isSelected ? '2px solid #000000' : '1px solid transparent',
                    boxShadow: isSelected ? '0 4px 12px rgba(0,0,0,0.08)' : 'none',
                    transition: 'all 0.15s ease-in-out',
                  }}
                >
                  <ArticleCard
                    article={{ ...item, isSaved: true }}
                    savedOverride
                    busy={pendingArticleId === item.id}
                    onSaveToggle={handlers.onUnsave || handlers.onSaveToggle}
                    onOpenArticle={() => setSelectedArticle(item)}
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
              backgroundColor: '#ffffff',
              borderRadius: '16px',
              padding: '32px',
              border: '1px solid #e5e7eb',
              maxHeight: 'calc(100vh - 100px)',
              overflowY: 'auto',
            }}
          >
            {selectedArticle ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
                {/* 1. Tóm tắt tiếng Việt */}
                <section>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: '0 0 12px 0', color: '#111827' }}>
                    Tóm tắt tiếng Việt
                  </h3>
                  <div style={{ fontSize: '0.95rem', color: '#374151', lineHeight: '1.6' }}>
                    <p style={{ margin: '0 0 8px 0' }}>
                      {selectedArticle.summaryVi ||
                        selectedArticle.summary ||
                        selectedArticle.description ||
                        'Nguồn chỉ cung cấp metadata và chưa có đủ thông tin để tóm tắt chi tiết.'}
                    </p>
                    {selectedArticle.summaryDetail && (
                      <p style={{ margin: '0 0 12px 0' }}>{selectedArticle.summaryDetail}</p>
                    )}
                    <p style={{ fontSize: '0.8125rem', color: '#6b7280', margin: 0 }}>
                      Tóm tắt do AI tạo. Kiểm chứng với nguồn gốc trước khi sử dụng.
                    </p>
                  </div>
                </section>

                <hr style={{ border: 'none', borderTop: '1px solid #f3f4f6', margin: 0 }} />

                {/* 2. Thông tin nguồn (Grid 2x2) */}
                <section>
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: '0 0 16px 0', color: '#111827' }}>
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
                        border: '1px solid #e5e7eb',
                        borderRadius: '12px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '6px' }}>
                        Tiêu đề gốc
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: '#111827', lineHeight: '1.4' }}>
                        {selectedArticle.originalTitle || selectedArticle.title || 'N/A'}
                      </div>
                    </div>

                    {/* Nguồn */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid #e5e7eb',
                        borderRadius: '12px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '6px' }}>
                        Nguồn
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: '#111827' }}>
                        {selectedArticle.sourceName || selectedArticle.source?.name || 'N/A'}
                      </div>
                    </div>

                    {/* Ngôn ngữ */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid #e5e7eb',
                        borderRadius: '12px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '6px' }}>
                        Ngôn ngữ
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: '#111827' }}>
                        {selectedArticle.language || 'en-us'}
                      </div>
                    </div>

                    {/* Ngày xuất bản */}
                    <div
                      style={{
                        padding: '16px',
                        border: '1px solid #e5e7eb',
                        borderRadius: '12px',
                        backgroundColor: '#ffffff',
                      }}
                    >
                      <div style={{ fontSize: '0.8125rem', color: '#6b7280', marginBottom: '6px' }}>
                        Ngày xuất bản
                      </div>
                      <div style={{ fontSize: '0.925rem', fontWeight: '600', color: '#111827' }}>
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
                    backgroundColor: '#e5e7eb',
                    borderRadius: '16px',
                    padding: '24px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                  }}
                >
                  <h3 style={{ fontSize: '1.25rem', fontWeight: '700', margin: 0, color: '#111827' }}>
                    Nguồn kiểm chứng
                  </h3>
                  <p style={{ margin: 0, fontSize: '0.925rem', color: '#374151' }}>
                    Mở bài gốc để kiểm tra ngữ cảnh và chi tiết đầy đủ.
                  </p>
                  <p style={{ margin: 0, fontSize: '0.8125rem', color: '#6b7280' }}>
                    AI tổng hợp; hãy kiểm chứng với nguồn gốc.
                  </p>
                  <div style={{ marginTop: '8px' }}>
                    <a
                      href={selectedArticle.url || selectedArticle.link || '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="public-btn"
                      style={{
                        display: 'inline-block',
                        backgroundColor: '#000000',
                        color: '#ffffff',
                        padding: '10px 20px',
                        borderRadius: '9999px',
                        fontWeight: '600',
                        fontSize: '0.875rem',
                        textDecoration: 'none',
                      }}
                    >
                      Mở bài gốc
                    </a>
                  </div>
                </section>
              </div>
            ) : (
              <div style={{ textAlign: 'center', color: '#9ca3af', padding: '60px 0' }}>
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
            <p id="public-clear-description" style={{ margin: '0 0 20px 0', color: '#6b7280' }}>
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
