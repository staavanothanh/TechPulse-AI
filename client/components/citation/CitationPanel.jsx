import { safeHttpsUrl } from '../../features/article-detail/safe-url.js'

export default function CitationPanel({ citation, showSourceAction = true }) {
  if (!citation) return null
  const originalUrl = safeHttpsUrl(citation.originalUrl)
  return (
    <aside className="citation-panel" aria-labelledby="citation-title">
      <div className="content-eyebrow">Nguồn kiểm chứng</div>
      <h2 id="citation-title">{citation.sourceName}</h2>
      <p>{citation.titleOriginal}</p>
      <dl className="content-facts">
        <div><dt>Xuất bản</dt><dd>{new Date(citation.publishedAt).toLocaleDateString('vi-VN')}</dd></div>
        <div><dt>Ngôn ngữ</dt><dd>{citation.sourceLanguage}</dd></div>
        {citation.author ? <div><dt>Tác giả</dt><dd>{citation.author}</dd></div> : null}
      </dl>
      {showSourceAction && originalUrl ? <a className="content-button content-button-primary" href={originalUrl} target="_blank" rel="noopener noreferrer external">Mở nguồn gốc</a> : null}
    </aside>
  )
}
