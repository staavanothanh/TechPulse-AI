import { safeExternalUrl } from '../safe-url.js'
import { ErrorState, Skeleton, StateCard } from '../components/reader-primitives.jsx'
import { articleTitle, formatDate, sourceDomain, sourceName } from '../components/reader-format.js'

export default function ArticleView({
  state = 'loading',
  article = null,
  error,
  onBack,
  onOpenSource,
}) {
  if (state === 'loading')
    return (
      <section className="public-view public-detail-view" aria-busy="true">
        <Skeleton label="Đang tải bài viết" />
      </section>
    )
  if (state === 'error')
    return (
      <section className="public-view public-detail-view">
        <button className="public-back" type="button" onClick={onBack}>
          Quay lại
        </button>
        <ErrorState title="Không thể tải bài viết" error={error} />
      </section>
    )
  if (!article)
    return (
      <section className="public-view public-detail-view">
        <StateCard
          title="Chưa chọn bài viết"
          copy="Chọn một bài từ Feed hoặc Tìm kiếm để xem chi tiết."
          action={
            <button className="public-btn public-btn-secondary" type="button" onClick={onBack}>
              Quay lại
            </button>
          }
        />
      </section>
    )
  const originalUrl = safeExternalUrl(article.originalUrl || article.sourceUrl)
  return (
    <section
      className="public-view public-detail-view"
      aria-labelledby="public-article-title"
      data-od-id="article-detail"
    >
      <div className="public-detail-wrap">
        <button className="public-back" type="button" onClick={onBack}>
          ← Quay lại
        </button>
        <p className="public-eyebrow">
          {sourceName(article)}
          {article.sourceLanguage ? ` · ${article.sourceLanguage}` : ''}
        </p>
        <h1 id="public-article-title" className="public-detail-title">
          {articleTitle(article)}
        </h1>
        <div className="public-card-meta">
          <span>{sourceName(article)}</span>
          {article.publishedAt ? (
            <time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>
          ) : null}
        </div>
        <div className="public-detail-body">
          <div className="public-detail-section">
            <h2>Tóm tắt tiếng Việt</h2>
            {article.summaryStatus === 'ready' && article.summaryVi ? (
              <>
                <p>{article.summaryVi}</p>
                <span className="public-form-note">
                  Tóm tắt do AI tạo. Kiểm chứng với nguồn gốc trước khi sử dụng.
                </span>
              </>
            ) : (
              <p className="public-muted">Tóm tắt chưa sẵn sàng.</p>
            )}
          </div>
          <div className="public-detail-section">
            <h2>Thông tin nguồn</h2>
            <dl className="public-fact-list">
              <div>
                <dt>Tiêu đề gốc</dt>
                <dd>{article.titleOriginal || articleTitle(article)}</dd>
              </div>
              <div>
                <dt>Nguồn</dt>
                <dd>
                  {sourceName(article)}
                  {sourceDomain(article) ? ` · ${sourceDomain(article)}` : ''}
                </dd>
              </div>
              <div>
                <dt>Ngôn ngữ</dt>
                <dd>{article.sourceLanguage || 'Không rõ'}</dd>
              </div>
              <div>
                <dt>Ngày xuất bản</dt>
                <dd>{formatDate(article.publishedAt) || 'Không rõ'}</dd>
              </div>
            </dl>
          </div>
          <div className="public-detail-section public-verification-band content-verification-band">
            <h2>Nguồn kiểm chứng</h2>
            <p>Mở bài gốc để kiểm tra ngữ cảnh và chi tiết đầy đủ.</p>
            {article.aiDisclosure ? (
              <p className="public-form-note">{article.aiDisclosure}</p>
            ) : null}
            {originalUrl ? (
              <a
                className="public-btn public-btn-primary"
                href={originalUrl}
                target="_blank"
                rel="noopener noreferrer external"
                onClick={() => onOpenSource?.(originalUrl)}
              >
                Mở bài gốc
              </a>
            ) : (
              <p className="public-muted">Liên kết bài gốc không khả dụng.</p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

export { ArticleView }
