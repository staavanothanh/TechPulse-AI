import { useCallback, useState } from 'react'
import {
  ErrorState,
  FilterField,
  PageHeading,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'
import { formatDate, TOPICS } from '../components/reader-format.js'
import { safeExternalUrl } from '../safe-url.js'
import { hasQaScope, qaClarificationMessage, validateQuestionScope } from '../../qa/qa-validation.js'
import { handleQaQuestionKeyDown } from '../../qa/qa-keyboard.js'
import { topicsMatch } from '../../../../shared/topic-catalog.js'
import { useDialogFocus } from '../../qa/dialog-focus.js'

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
  const [questionError, setQuestionError] = useState('')
  const [selectedCitation, setSelectedCitation] = useState(null)
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false)
  const closeCitation = useCallback(() => setSelectedCitation(null), [])
  const closeClearConfirmation = useCallback(() => setClearConfirmationOpen(false), [])
  const confirmClearSessions = useCallback(() => {
    closeClearConfirmation()
    void handlers.onClearSessions?.()
  }, [closeClearConfirmation, handlers.onClearSessions])
  const clearDialogRef = useDialogFocus(clearConfirmationOpen, closeClearConfirmation)
  const safeScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {}
  const scopeTopics = Array.isArray(safeScope.topics) ? safeScope.topics : []
  const activeTopics = Array.isArray(topics) ? topics : TOPICS
  const isTopicSelected = (topic) => scopeTopics.some((selectedTopic) => topicsMatch(selectedTopic, topic))
  const hasScope = hasQaScope(safeScope)
  const displayError = safeQaError(error)
  function submit(event) {
    if (!event.defaultPrevented) event.preventDefault()
    const value = question.trim()
    if (!value || value.length > 1000 || state === 'loading') return
    if (value.length < 3) {
      setQuestionError('Câu hỏi cần ít nhất 3 ký tự.')
      return
    }
    const askScope = Object.fromEntries(Object.entries({ ...safeScope, topics: scopeTopics }).filter(([key, scopeValue]) => key !== 'topics' || scopeValue.length > 0))
    const validation = validateQuestionScope(value, askScope)
    if (!validation.valid) return
    setQuestionError('')
    onAsk?.({ ...validation.scope, question: value })
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
                error={displayError}
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
                  onChange={(event) => {
                    setQuestion(event.target.value)
                    if (questionError) setQuestionError('')
                  }}
                  aria-invalid={Boolean(questionError)}
                  aria-describedby={`public-qa-composer-hint${questionError ? ' public-qa-question-error' : ''}`}
                  onKeyDown={(event) => handleQaQuestionKeyDown(event, submit)}
                  minLength={3}
                  maxLength={1000}
                  placeholder="Nhập câu hỏi về công nghệ"
                />
                {questionError ? (
                  <small id="public-qa-question-error" className="public-field-error" role="alert">
                    {questionError}
                  </small>
                ) : null}
              </label>
              <div className="public-composer-foot">
                <span id="public-qa-composer-hint">
                  Tối đa 1.000 ký tự mỗi câu hỏi. Nhấn Enter để gửi · Shift+Enter để xuống dòng.
                </span>
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
          {safeScope.articleId ? (
            <div className="public-qa-article-selected">
              <span>Đang hỏi về bài:</span>
              <code>{safeScope.articleId}</code>
              <button
                className="public-text-action"
                type="button"
                onClick={() => handlers.onClearArticleScope?.()}
              >
                Bỏ chọn
              </button>
            </div>
          ) : null}
          {hasScope ? null : (
            <p id="public-qa-scope-hint" className="public-form-note">
              Chọn ít nhất một chủ đề, nhập ID bài viết hoặc cung cấp đủ hai mốc thời gian trước khi hỏi.
            </p>
          )}
          <div className="public-topic-row public-scope-topics">
            {activeTopics.map((topic) => (
              <button
                key={topic}
                className={isTopicSelected(topic) ? 'active' : ''}
                type="button"
                aria-pressed={isTopicSelected(topic)}
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
      <CitationDrawer citation={selectedCitation} onClose={closeCitation} />
      {clearConfirmationOpen ? (
        <div className="public-dialog-backdrop" role="presentation">
          <section
            ref={clearDialogRef}
            className="public-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="public-clear-sessions-title"
            aria-describedby="public-clear-sessions-description"
            tabIndex={-1}
          >
            <p className="public-eyebrow">Xác nhận xóa</p>
            <h2 id="public-clear-sessions-title">Xóa toàn bộ lịch sử hỏi đáp?</h2>
            <p id="public-clear-sessions-description">Thao tác này sẽ xóa các phiên hỏi đáp của tài khoản và không thể hoàn tác.</p>
            <div className="public-dialog-actions">
              <button
                className="public-btn public-btn-secondary"
                type="button"
                onClick={closeClearConfirmation}
              >
                Quay lại
              </button>
              <button
                className="public-btn public-btn-danger"
                type="button"
                onClick={confirmClearSessions}
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

function isHistoricalCitation(citation) {
  return citation?.status === 'available' || citation?.status === 'unavailable'
}

function citationChipLabel(citation) {
  const sourceLabel = citation?.sourceName || citation?.titleOriginal || (citation?.status === 'unavailable' ? 'Nguồn lịch sử' : 'Nguồn')
  return isHistoricalCitation(citation) ? `Citation lịch sử · ${sourceLabel}` : sourceLabel
}
function CitationDrawer({ citation, onClose }) {
  const dialogRef = useDialogFocus(Boolean(citation), onClose)
  if (!citation) return null
  const url = citation.status === 'unavailable' ? null : safeExternalUrl(citation.originalUrl)
  const historical = isHistoricalCitation(citation)
  const sourceLabel = citation.sourceName || (citation.status === 'unavailable' ? 'Nguồn lịch sử' : citation.titleOriginal || 'Nguồn kiểm chứng')

  return (
    <div
      className="public-dialog-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={dialogRef}
        className="public-dialog public-citation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-citation-title"
        aria-describedby={historical ? 'public-citation-status' : undefined}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="public-dialog-heading">
          <div>
            <p className="public-eyebrow">{historical ? 'Citation lịch sử' : 'Nguồn kiểm chứng'}</p>
            <h2 id="public-citation-title">{sourceLabel}</h2>
          </div>
          <button className="public-text-action" type="button" onClick={onClose}>
            Đóng
          </button>
        </div>
        {citation.status === 'unavailable' ? (
          <p id="public-citation-status" className="public-muted">Nguồn lịch sử không còn khả dụng.</p>
        ) : (
          <>
            {citation.status === 'available' ? (
              <p id="public-citation-status" className="public-form-note">Nguồn còn khả dụng</p>
            ) : null}
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
                            {citationChipLabel(citation)}
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

export { QaView, CitationDrawer }

function safeQaError(error) {
  const message = qaClarificationMessage(error)
  if (!message) return error
  return {
    message,
    ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
  }
}
