import { refusalCopy, safeDate } from './qa-validation.js'

export default function AnswerResult({ answer, onCitation, replay = false, conflict = false, headingRef, headingId }) {
  if (!answer) return <section className="qa-progress"><h3>Chưa có câu trả lời trong phiên này</h3><p>Nhập câu hỏi, kiểm tra phạm vi rồi gửi.</p></section>
  if (answer.status === 'refused') {
    const copy = refusalCopy(answer.refusalReason)
    const titleId = headingId ?? 'qa-refusal-title'
    return <article className="qa-refusal" aria-labelledby={titleId}><span className="qa-status qa-warning">Từ chối an toàn</span><h3 id={titleId} tabIndex="-1" ref={headingRef}>{copy.title}</h3><p>{copy.body}</p><button className="qa-button" type="button" onClick={() => document.getElementById('qa-question')?.focus()}>Sửa câu hỏi</button></article>
  }
  const titleId = headingId ?? 'qa-answer-title'
  return <article className="qa-answer" aria-labelledby={titleId}><div className="qa-answer-head"><div><span className="qa-eyebrow">{replay ? 'Kết quả đã nhận trước đó' : 'Trả lời có nguồn'}</span><h3 id={titleId} tabIndex="-1" ref={headingRef}>{conflict ? 'Các nguồn đưa ra những cách diễn giải khác nhau' : 'Câu trả lời trong phạm vi đã chọn'}</h3></div><span className="qa-status qa-success">Đã trả lời</span></div>{conflict ? <div className="qa-conflict" role="note"><strong>Nguồn có mâu thuẫn</strong><p>TechPulse trình bày từng lập luận riêng và không tự chọn một kết luận.</p></div> : null}{answer.paragraphs.map((paragraph, index) => <section className="qa-paragraph" key={`${answer.id}-${index}`}><p>{paragraph.text}</p><div className="qa-citation-row">{paragraph.citationIds.map((id) => { const citation = answer.citations.find((item) => item.id === id); return citation ? <button className="qa-citation-chip" type="button" key={id} onClick={() => onCitation?.(citation)}>[{id}] {citation.status === 'unavailable' ? 'Nguồn lịch sử không còn khả dụng' : citation.sourceName ?? 'Nguồn'}</button> : null })}</div></section>)}<footer className="qa-answer-footer"><span>{answer.paragraphs.length} đoạn · citation theo từng đoạn</span><time>{safeDate(answer.createdAt)}</time></footer></article>
}
