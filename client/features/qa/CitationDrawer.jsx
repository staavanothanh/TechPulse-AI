import { safeHttpsUrl } from '../article-detail/safe-url.js'
import { safeDate } from './qa-validation.js'
import { useDialogFocus } from './dialog-focus.js'

export function CitationDrawer({ citation, open = false, onClose }) {
  const dialogRef = useDialogFocus(open, onClose)
  if (!open || !citation) return null
  const url = citation.status === 'available' || !citation.status ? safeHttpsUrl(citation.originalUrl) : null
  return (
    <div className="qa-dialog-scrim qa-citation-scrim" data-citation-backdrop="true" role="presentation" onClick={onClose}>
    <aside className="qa-citation-drawer" ref={dialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="qa-citation-title" onClick={(event) => event.stopPropagation()}>
      <div className="qa-drawer-header"><div><span className="qa-eyebrow">Nguồn kiểm chứng</span><h3 id="qa-citation-title">{citation.sourceName ?? 'Nguồn lịch sử'}</h3></div><button className="qa-icon-button" type="button" aria-label="Đóng chi tiết nguồn" onClick={onClose}>×</button></div>
      {citation.status === 'unavailable' ? <p className="qa-muted">Nguồn lịch sử không còn khả dụng.</p> : <><h4>{citation.titleOriginal}</h4><dl className="qa-facts"><div><dt>Xuất bản</dt><dd>{safeDate(citation.publishedAt)}</dd></div>{citation.sourceLanguage ? <div><dt>Ngôn ngữ</dt><dd>{citation.sourceLanguage}</dd></div> : null}{citation.author ? <div><dt>Tác giả</dt><dd>{citation.author}</dd></div> : null}</dl>{url ? <a className="qa-button qa-primary" href={url} target="_blank" rel="noopener noreferrer external">Mở nguồn gốc</a> : null}</>}
    </aside>
    </div>
  )
}

export default CitationDrawer
