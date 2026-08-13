import AnswerResult from './AnswerResult.jsx'
import { safeDate, validateSessionDetail } from './qa-validation.js'

export default function ChatSessionTranscript({ status = 'empty', detail, error, onRetry, onCitation }) {
  if (status === 'loading') return <section className="qa-conversation-state" aria-busy="true"><h2>Đang tải lịch sử phiên</h2><p>Transcript được đọc lại từ server.</p></section>
  if (status === 'error') return <section className="qa-conversation-state" role="alert"><h2>{error?.status === 404 ? 'Phiên không còn khả dụng' : 'Không thể tải phiên'}</h2><p>{error?.status === 404 ? 'Phiên này không còn trong phạm vi hiện tại.' : 'Giữ phiên đã chọn và thử đọc lại.'}</p>{error?.status !== 401 ? <button className="qa-button" type="button" onClick={onRetry}>Đọc lại phiên</button> : null}</section>
  const checked = validateSessionDetail(detail)
  if (status === 'empty' || !detail) return <section className="qa-conversation-state"><h2>Chưa có câu trả lời trong phiên này</h2><p>Nhập câu hỏi, kiểm tra phạm vi rồi gửi.</p></section>
  if (!checked.valid) return <section className="qa-conversation-state" role="alert"><h2>Phiên không thể hiển thị</h2><p>Dữ liệu lịch sử không đáp ứng giới hạn an toàn.</p></section>
  return <section className="qa-transcript" aria-label="Nội dung phiên"><div className="qa-transcript-meta"><span>{detail.messageCount} messages</span><time>{safeDate(detail.updatedAt)}</time></div>{detail.messages.map((message) => message.role === 'user' ? <article className="qa-message-user" key={message.id}><p>{message.text}</p></article> : <AnswerResult key={message.id} answer={message} onCitation={onCitation} headingId={`qa-${message.status === 'refused' ? 'refusal' : 'answer'}-title-${message.id}`} />)}</section>
}
