import { useState } from 'react'
import {
  ErrorState,
  FilterField,
  PageHeading,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'
import { formatDate, TOPICS } from '../components/reader-format.js'
import { safeExternalUrl } from '../safe-url.js'
import { hasQaScope } from '../../qa/qa-validation.js'

export default function QaView({
  state = 'empty',
  sessions = [],
  messages = [],
  scope = {},
  topics = TOPICS,
  error,
  onAsk,
  handlers = {},
}) {
  const [question, setQuestion] = useState('')
  const [selectedCitation, setSelectedCitation] = useState(null)
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false)
  const safeScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {}
  const scopeTopics = Array.isArray(safeScope.topics) ? safeScope.topics : []
  const activeTopics = Array.isArray(topics) ? topics : TOPICS
  const hasScope = hasQaScope(safeScope)
  function submit(event) {
    event.preventDefault()
    const value = question.trim()
    if (!value || value.length > 1000 || !hasScope) return
    const askScope = Object.fromEntries(Object.entries({ ...safeScope, topics: scopeTopics }).filter(([key, value]) => key !== 'topics' || value.length > 0))
    onAsk?.({ ...askScope, question: value })
    setQuestion('')
  }
  return (
    <section
      className="public-view public-qa-view"
      aria-labelledby="public-qa-title"
      data-od-id="qa"
    >
      <PageHeading
        id="public-qa-title"
        eyebrow="Grounded Q&A"
        title="Hỏi đáp có nguồn"
        copy="Chỉ trả lời từ bằng chứng đã truy xuất. Mỗi đoạn có thể mở tới citation."
      />
      <div className="public-qa-layout">
        <aside className="public-qa-rail" aria-labelledby="public-qa-history-title">
          <div className="public-filter-heading">
            <h2 id="public-qa-history-title">Lịch sử phiên</h2>
            <button className="public-text-action" type="button" onClick={handlers.onNewSession}>
              Phiên mới
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="public-muted">Chưa có phiên hỏi đáp.</p>
          ) : (
            <div className="public-session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={session.id === safeScope.sessionId ? 'active' : ''}
                  type="button"
                  onClick={() => handlers.onSelectSession?.(session.id)}
                >
                  <strong>{session.title || 'Phiên hỏi đáp'}</strong>
                  <small>{session.messageCount ?? 0} tin nhắn</small>
                </button>
              ))}
            </div>
          )}
          <button
            className="public-text-action"
            type="button"
            onClick={() => setClearConfirmationOpen(true)}
          >
            Xóa tất cả phiên
          </button>
        </aside>
        <div className="public-qa-main">
          <div
            className="public-qa-thread"
            aria-live="polite"
            aria-busy={state === 'loading' || undefined}
          >
            {state === 'empty' ? (
              <StateCard
                eyebrow="Phiên trống"
                title="Bắt đầu một câu hỏi"
                copy="Đặt câu hỏi về công nghệ. Câu trả lời sẽ kèm citation tới nguồn đã truy xuất."
              />
            ) : null}
            {state === 'loading' ? <Skeleton label="Đang truy xuất nguồn" /> : null}
            {state === 'error' ? (
              <ErrorState
                title="Không thể tạo câu trả lời"
                error={error}
                onRetry={handlers.onRetry}
              />
            ) : null}
            {state === 'ready' ? (
              <MessageThread messages={messages} onCitation={setSelectedCitation} />
            ) : null}
          </div>
          <div className="public-qa-composer">
            <form onSubmit={submit} noValidate>
              <label className="public-field" htmlFor="public-qa-question">
                <span>Câu hỏi của bạn</span>
                <textarea
                  id="public-qa-question"
                  className="public-input public-textarea"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  maxLength={1000}
                  placeholder="Nhập câu hỏi về công nghệ"
                />
              </label>
              <div className="public-composer-foot">
                <span>Tối đa 1.000 ký tự mỗi câu hỏi.</span>
                <button
                  className="public-btn public-btn-primary"
                  type="submit"
                  aria-describedby={!hasScope ? 'public-qa-scope-hint' : undefined}
                  disabled={!question.trim() || state === 'loading' || !hasScope}
                >
                  Hỏi với nguồn
                </button>
              </div>
            </form>
          </div>
        </div>
        <aside className="public-qa-scope" aria-labelledby="public-qa-scope-title">
          <h2 id="public-qa-scope-title">Phạm vi nguồn</h2>
          <p className="public-form-note">Giới hạn nguồn truy xuất cho câu trả lời.</p>
          {hasScope ? null : (
            <p id="public-qa-scope-hint" className="public-form-note">
              Chọn ít nhất một chủ đề, nhập ID bài viết hoặc cung cấp đủ hai mốc thời gian trước khi hỏi.
            </p>
          )}
          <div className="public-topic-row public-scope-topics">
            {activeTopics.map((topic) => (
              <button
                key={topic}
                className={scopeTopics.includes(topic) ? 'active' : ''}
                type="button"
                aria-pressed={scopeTopics.includes(topic)}
                onClick={() => handlers.onToggleTopic?.(topic)}
              >
                {topic}
              </button>
            ))}
          </div>
          <FilterField
            id="public-qa-article"
            label="Giới hạn theo bài"
            value={safeScope.articleId || ''}
            onChange={(value) => handlers.onScopeChange?.('articleId', value)}
            maxLength={128}
            placeholder="ID bài tùy chọn"
          />
          <FilterField
            id="public-qa-after"
            label="Từ ngày"
            value={safeScope.publishedAfter || ''}
            onChange={(value) => handlers.onScopeChange?.('publishedAfter', value)}
            type="datetime-local"
          />
          <FilterField
            id="public-qa-before"
            label="Đến ngày"
            value={safeScope.publishedBefore || ''}
            onChange={(value) => handlers.onScopeChange?.('publishedBefore', value)}
            type="datetime-local"
          />
        </aside>
      </div>
      <CitationDrawer citation={selectedCitation} onClose={() => setSelectedCitation(null)} />
      {clearConfirmationOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-clear-sessions-title"
          >
            <p className="public-eyebrow">Xác nhận xóa</p>
            <h2 id="public-clear-sessions-title">Xóa toàn bộ lịch sử hỏi đáp?</h2>
            <p>Thao tác này sẽ xóa các phiên hỏi đáp của tài khoản và không thể hoàn tác.</p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={() => setClearConfirmationOpen(false)}
              >
                Quay lại
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                onClick={() => {
                  setClearConfirmationOpen(false)
                  void handlers.onClearSessions?.()
                }}
              >
                Xóa lịch sử
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  )
}

function CitationDrawer({ citation, onClose }) {
  if (!citation) return null
  const url = citation.status === 'unavailable' ? null : safeExternalUrl(citation.originalUrl)
  return (
    <div
      className="public-dialog-backdrop"
      role="presentation"
      onClick={onClose}
      onKeyDown={(event) => event.key === 'Escape' && onClose?.()}
    >
      <aside
        className="public-dialog public-citation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-citation-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="public-dialog-heading">
          <div>
            <p className="public-eyebrow">Nguồn kiểm chứng</p>
            <h2 id="public-citation-title">{citation.sourceName || 'Nguồn lịch sử'}</h2>
          </div>
          <button className="public-text-action" type="button" onClick={onClose}>
            Đóng
          </button>
        </div>
        {citation.status === 'unavailable' ? (
          <p className="public-muted">Nguồn lịch sử không còn khả dụng.</p>
        ) : (
          <>
            <h3>{citation.titleOriginal || 'Bài viết nguồn'}</h3>
            <dl className="public-fact-list">
              {citation.publishedAt ? (
                <div>
                  <dt>Xuất bản</dt>
                  <dd>{formatDate(citation.publishedAt)}</dd>
                </div>
              ) : null}
              {citation.sourceLanguage ? (
                <div>
                  <dt>Ngôn ngữ</dt>
                  <dd>{citation.sourceLanguage}</dd>
                </div>
              ) : null}
              {citation.author ? (
                <div>
                  <dt>Tác giả</dt>
                  <dd>{citation.author}</dd>
                </div>
              ) : null}
            </dl>
            {url ? (
              <a
                className="public-btn public-btn-primary"
                href={url}
                target="_blank"
                rel="noopener noreferrer external"
              >
                Mở nguồn gốc
              </a>
            ) : null}
          </>
        )}
      </aside>
    </div>
  )
}

function MessageThread({ messages, onCitation }) {
  if (!Array.isArray(messages) || messages.length === 0)
    return <StateCard title="Chưa có tin nhắn" copy="Đặt câu hỏi để tạo câu trả lời có nguồn." />
  return (
    <div className="public-message-list">
      {messages.map((message, index) => {
        const assistant = message.role !== 'user'
        const paragraphs = Array.isArray(message.paragraphs) ? message.paragraphs : []
        const citations = Array.isArray(message.citations) ? message.citations : []
        const citationById = new Map(citations.map((citation) => [citation.id, citation]))
        const refusalCopy = {
          'insufficient-evidence': 'Chưa đủ bằng chứng để trả lời câu hỏi này.',
          'policy-blocked': 'Câu hỏi này nằm ngoài phạm vi hỗ trợ.',
          'sensitive-input': 'Không thể xử lý nội dung nhạy cảm trong phiên hỏi đáp.',
          'provider-unavailable': 'Dịch vụ trả lời tạm thời chưa sẵn sàng.',
        }
        return (
          <article
            className={`public-message public-message-${assistant ? 'assistant' : 'user'}`}
            key={message.id || index}
          >
            {assistant && message.status === 'refused' ? (
              <div className="public-message-bubble">
                {refusalCopy[message.refusalReason] || 'Câu hỏi bị từ chối an toàn.'}
              </div>
            ) : null}
            {!assistant || paragraphs.length === 0 ? (
              !assistant ? (
                <div className="public-message-bubble">{message.text || message.content || ''}</div>
              ) : null
            ) : (
              <div className="public-answer-block">
                {paragraphs.map((paragraph, paragraphIndex) => (
                  <section
                    className="public-answer-paragraph"
                    key={`${message.id || index}-${paragraphIndex}`}
                  >
                    <p>{paragraph.text}</p>
                    <div className="public-citation-row">
                      {(paragraph.citationIds || []).map((citationId, citationIndex) => {
                        const citation = citationById.get(citationId)
                        return citation ? (
                          <button
                            className="public-citation-chip"
                            type="button"
                            key={citationId}
                            onClick={() => onCitation?.(citation)}
                          >
                            [{citationIndex + 1}]{' '}
                            {citation.sourceName || citation.titleOriginal || 'Nguồn'}
                          </button>
                        ) : null
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </article>
        )
      })}
    </div>
  )
}

export { QaView }
