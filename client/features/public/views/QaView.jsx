import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ErrorState,
  FilterField,
  PageHeading,
  Skeleton,
  StateCard,
} from '../components/reader-primitives.jsx'
import { articleTitle, formatDate, sourceName, TOPICS, ALL_TOPICS, GROUPED_TOPICS } from '../components/reader-format.js'
import { safeExternalUrl } from '../safe-url.js'
import {
  hasQaScope,
  isQaScopeConfirmation,
  qaClarificationMessage,
  validateQuestionScope,
} from '../../qa/qa-validation.js'
import { handleQaQuestionKeyDown } from '../../qa/qa-keyboard.js'
import { topicsMatch } from '../../../../shared/topic-catalog.js'
import { useDialogFocus } from '../../qa/dialog-focus.js'

const pendingNaturalQuestions = new WeakMap()

function naturalScopeEnabled(scopeMode, allowNaturalLanguageScope) {
  return allowNaturalLanguageScope === true || scopeMode === 'natural-language' || scopeMode === 'preview'
}

function safeScopeProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proposal = Object.fromEntries(
    Object.entries(value).filter(([key]) => ['articleId', 'topics', 'publishedAfter', 'publishedBefore'].includes(key)),
  )
  return hasQaScope(proposal) ? proposal : null
}

function scopeConfirmationSummary(scope) {
  const entries = []
  if (Array.isArray(scope.topics) && scope.topics.length > 0) entries.push(`Chủ đề: ${scope.topics.join(', ')}`)
  if (typeof scope.articleId === 'string' && scope.articleId) entries.push(`Bài viết: ${scope.articleId}`)
  if (scope.publishedAfter && scope.publishedBefore) entries.push(`Thời gian: ${scope.publishedAfter} – ${scope.publishedBefore}`)
  return entries
}

const SUGGESTED_PROMPTS = [
  {
    topic: 'AI',
    prompt: 'Google DeepMind có bài viết nào về Gemini 3.1 Flash TTS không?',
  },
  {
    topic: 'AI',
    prompt: 'Google DeepMind đã công bố mô hình speech AI nào dựa trên Gemini?',
  },
  {
    topic: 'AI',
    prompt: 'Mô hình OlmoEarth của Hugging Face phục vụ mục đích gì?',
  },
  {
    topic: 'Bảo mật',
    prompt: 'Các quy định thử nghiệm an toàn AI được đề cập như thế nào?',
  },
]

export default function QaView({
  state = 'empty',
  sessions = [],
  messages = [],
  scope = {},
  topics,
  articles = [],
  error,
  onAsk,
  handlers = {},
  scopeMode = 'explicit',
  scopeProposal = null,
  scopeConfirmation = null,
  allowNaturalLanguageScope = false,
}) {
  const [question, setQuestion] = useState('')
  const [questionError, setQuestionError] = useState('')
  const [selectedCitation, setSelectedCitation] = useState(null)
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false)
  const [isTopicPopoverOpen, setIsTopicPopoverOpen] = useState(false)
  const [topicSearchTerm, setTopicSearchTerm] = useState('')
  const [submittedQuestion, setSubmittedQuestion] = useState('')
  const topicPopoverRef = useRef(null)
  const pendingQuestionRef = useRef('')
  const canceledScopeRef = useRef(false)
  const confirmationKeyRef = useRef('')
  const closeCitation = useCallback(() => setSelectedCitation(null), [])
  const closeClearConfirmation = useCallback(() => setClearConfirmationOpen(false), [])
  const confirmClearSessions = useCallback(() => {
    closeClearConfirmation()
    void handlers.onClearSessions?.()
  }, [closeClearConfirmation, handlers.onClearSessions])
  const clearDialogRef = useDialogFocus(clearConfirmationOpen, closeClearConfirmation)

  useEffect(() => {
    if (state !== 'loading') {
      setSubmittedQuestion('')
    }
  }, [state])

  useEffect(() => {
    if (!isTopicPopoverOpen) return
    function handleClickOutside(event) {
      if (topicPopoverRef.current && !topicPopoverRef.current.contains(event.target)) {
        setIsTopicPopoverOpen(false)
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsTopicPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isTopicPopoverOpen])

  const safeScope = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {}
  const scopeTopics = Array.isArray(safeScope.topics) ? safeScope.topics : []
  const customTopics = Array.isArray(topics) && topics.length > 0 ? topics : null
  const availableTopicSet = customTopics ? new Set(customTopics.map((t) => typeof t === 'string' ? t.toLowerCase() : '')) : null
  const normalizedSearch = topicSearchTerm.trim().toLowerCase()

  const articlesMap = useMemo(() => {
    const map = new Map()
    if (Array.isArray(articles)) {
      for (const item of articles) {
        const id = item?.id ?? item?._id
        if (id) map.set(String(id), item)
      }
    }
    return map
  }, [articles])

  const filteredTopicGroups = GROUPED_TOPICS.map((group) => {
    const items = group.items.filter((item) => {
      const isAvailable = !availableTopicSet || availableTopicSet.has(item.label.toLowerCase()) || availableTopicSet.has(item.id.toLowerCase())
      if (!isAvailable) return false
      if (!normalizedSearch) return true
      return (
        item.label.toLowerCase().includes(normalizedSearch) ||
        group.label.toLowerCase().includes(normalizedSearch)
      )
    })
    return items.length > 0 ? { ...group, items } : null
  }).filter(Boolean)

  const hasExplicitScopeInput = Boolean(
    (typeof safeScope.articleId === 'string' ? safeScope.articleId.trim() : safeScope.articleId)
      || (Array.isArray(scopeTopics) && scopeTopics.length > 0)
      || safeScope.publishedAfter
      || safeScope.publishedBefore,
  )
  const isTopicSelected = (topic) => scopeTopics.some((selectedTopic) => topicsMatch(selectedTopic, topic))
  const hasScope = hasQaScope(safeScope)
  const naturalMode = naturalScopeEnabled(scopeMode, allowNaturalLanguageScope)
  const proposedScope = safeScopeProposal(scopeProposal ?? error?.scopeProposal ?? error?.proposedScope)
  const proposedConfirmation = isQaScopeConfirmation(scopeConfirmation)
    ? scopeConfirmation
    : isQaScopeConfirmation(error?.scopeConfirmation)
      ? error.scopeConfirmation
      : null
  const confirmationKey = proposedConfirmation ? JSON.stringify(proposedConfirmation) : ''
  if (!confirmationKey) confirmationKeyRef.current = ''
  else if (!confirmationKeyRef.current) confirmationKeyRef.current = confirmationKey
  const pendingQuestion = pendingQuestionRef.current || pendingNaturalQuestions.get(handlers) || question.trim()
  const canConfirmScope = naturalMode && state !== 'loading' && Boolean(proposedScope) && Boolean(proposedConfirmation)
  const displayError = safeQaError(error)
  const confirmScope = useCallback(() => {
    if (state === 'loading' || canceledScopeRef.current || !canConfirmScope || !pendingQuestion || !isQaScopeConfirmation(proposedConfirmation) || confirmationKeyRef.current !== confirmationKey) return
    handlers.onConfirmScope?.({
      question: pendingQuestion,
      scopeMode: 'confirmed',
      scopeConfirmation: proposedConfirmation,
    })
  }, [canConfirmScope, confirmationKey, handlers.onConfirmScope, pendingQuestion, proposedConfirmation, state])
  const cancelScope = useCallback(() => {
    canceledScopeRef.current = true
    confirmationKeyRef.current = ''
    pendingQuestionRef.current = ''
    pendingNaturalQuestions.delete(handlers)
    handlers.onCancelScope?.()
  }, [handlers])
  function submit(event) {
    if (!event.defaultPrevented) event.preventDefault()
    const value = question.trim()
    if (!value || value.length > 1000 || state === 'loading') return
    if (value.length < 3) {
      setQuestionError('Câu hỏi cần ít nhất 3 ký tự.')
      return
    }
    if (naturalMode && !hasScope && !hasExplicitScopeInput) {
      setQuestionError('')
      canceledScopeRef.current = false
      confirmationKeyRef.current = ''
      pendingQuestionRef.current = value
      pendingNaturalQuestions.set(handlers, value)
      setSubmittedQuestion(value)
      onAsk?.({ question: value, scopeMode: 'preview' })
      return
    }
    const askScope = Object.fromEntries(Object.entries({ ...safeScope, topics: scopeTopics }).filter(([key, scopeValue]) => key !== 'topics' || scopeValue.length > 0))
    const validation = validateQuestionScope(value, askScope)
    if (!validation.valid) return
    setQuestionError('')
    canceledScopeRef.current = true
    confirmationKeyRef.current = ''
    pendingQuestionRef.current = ''
    pendingNaturalQuestions.delete(handlers)
    setSubmittedQuestion(value)
    onAsk?.({ ...validation.scope, question: value })
    setQuestion('')
  }
  function handleSelectSuggestion(suggestion) {
    setQuestion(suggestion.prompt)
    if (questionError) setQuestionError('')
    if (suggestion.topic && !isTopicSelected(suggestion.topic)) {
      handlers.onToggleTopic?.(suggestion.topic)
    }
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
                <div
                  key={session.id}
                  className={`public-session-item ${session.id === safeScope.sessionId ? 'active' : ''}`}
                >
                  <button
                    className={`public-session-select ${session.id === safeScope.sessionId ? 'active' : ''}`}
                    type="button"
                    onClick={() => handlers.onSelectSession?.(session.id)}
                  >
                    <strong title={session.title || undefined}>{session.title || 'Phiên hỏi đáp'}</strong>
                    <small>{session.messageCount ?? 0} tin nhắn</small>
                  </button>
                  <button
                    className="public-session-delete"
                    type="button"
                    title="Xóa phiên này"
                    aria-label={`Xóa phiên ${session.title || 'hỏi đáp'}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      void handlers.onDeleteSession?.(session.id)
                    }}
                  >
                    ×
                  </button>
                </div>
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
              <div className="public-qa-empty-wrap">
                <StateCard
                  eyebrow="Phiên trống"
                  title={safeScope.articleId ? 'Hỏi đáp về bài viết' : 'Bắt đầu một câu hỏi'}
                  copy={
                    safeScope.articleId
                      ? 'Đặt câu hỏi xoay quanh nội dung bài viết đã chọn. Câu trả lời sẽ kèm citation tới nguồn đã truy xuất.'
                      : 'Đặt câu hỏi về công nghệ. Câu trả lời sẽ kèm citation tới nguồn đã truy xuất.'
                  }
                />
                {!safeScope.articleId ? (
                  <div className="public-qa-suggestions">
                    <p className="public-form-note">Gợi ý câu hỏi mẫu từ nguồn tin có trong hệ thống:</p>
                    <div className="public-suggestion-chips">
                      {SUGGESTED_PROMPTS.map((item, index) => (
                        <button
                          key={index}
                          className="public-suggestion-chip"
                          type="button"
                          onClick={() => handleSelectSuggestion(item)}
                        >
                          <span className="public-suggestion-tag">{item.topic}</span>
                          <span className="public-suggestion-text">{item.prompt}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {state === 'loading' && messages.length === 0 && !submittedQuestion ? (
              <Skeleton label="Đang truy xuất nguồn" />
            ) : null}
            {state === 'error' ? (
              <ErrorState
                title="Không thể tạo câu trả lời"
                error={displayError}
                onRetry={handlers.onRetry}
              />
            ) : null}
            {state === 'ready' || (state === 'loading' && (messages.length > 0 || submittedQuestion)) ? (
              <MessageThread
                messages={messages}
                pendingQuestion={submittedQuestion}
                isLoading={state === 'loading'}
                onCitation={setSelectedCitation}
                articlesMap={articlesMap}
              />
            ) : null}
          </div>
          {canConfirmScope ? (
            <ScopeConfirmationPanel
              scope={proposedScope}
              canConfirm={Boolean(pendingQuestion)}
              onConfirm={confirmScope}
              onCancel={cancelScope}
            />
          ) : null}
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
                  placeholder={
                    safeScope.articleId
                      ? 'Nhập câu hỏi về bài viết này'
                      : 'Nhập câu hỏi về công nghệ'
                  }
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
                  disabled={!question.trim() || state === 'loading' || (!hasScope && !naturalMode)}
                >
                  {state === 'loading' ? (
                    <span className="public-btn-loading">
                      <span className="public-btn-spinner" aria-hidden="true" />
                      <span>Đang trả lời...</span>
                    </span>
                  ) : (
                    'Hỏi với nguồn'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
        <aside className="public-qa-scope" aria-labelledby="public-qa-scope-title">
          <h2 id="public-qa-scope-title">Phạm vi chủ đề</h2>
          <p className="public-form-note">Giới hạn chủ đề và thời gian bài viết cần hỏi đáp.</p>
          {safeScope.articleId ? (
            <div className="public-qa-article-selected public-qa-article-context">
              <div className="public-qa-article-context-head">
                <span className="public-qa-article-context-badge">Đang hỏi về bài viết</span>
                <button
                  className="public-text-action"
                  type="button"
                  onClick={() => handlers.onClearArticleScope?.()}
                >
                  Bỏ chọn
                </button>
              </div>
              <h3 className="public-qa-article-context-title">
                {safeScope.article
                  ? articleTitle(safeScope.article)
                  : `Bài viết #${String(safeScope.articleId).slice(0, 8)}…`}
              </h3>
              {safeScope.article ? (
                <div className="public-qa-article-context-meta">
                  <span>{sourceName(safeScope.article)}</span>
                  {safeScope.article.publishedAt ? (
                    <time dateTime={safeScope.article.publishedAt}>
                      {formatDate(safeScope.article.publishedAt)}
                    </time>
                  ) : null}
                </div>
              ) : (
                <code className="public-qa-article-fallback-id">{safeScope.articleId}</code>
              )}
              {safeScope.article?.summaryVi ? (
                <p className="public-qa-article-context-summary">{safeScope.article.summaryVi}</p>
              ) : null}
            </div>
          ) : null}
          {!hasScope ? (
            <p id="public-qa-scope-hint" className="public-form-note">
              {naturalMode
                ? 'Phạm vi sẽ được đề xuất từ câu hỏi và cần xác nhận trước khi tìm nguồn.'
                : 'Chọn ít nhất một chủ đề hoặc cung cấp đủ hai mốc thời gian trước khi hỏi.'}
            </p>
          ) : null}

          {customTopics ? (
            <div className="public-topic-row public-scope-topics" role="group" aria-label="Chủ đề bài viết">
              {customTopics.map((topic) => (
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
          ) : null}

          <div className="public-topic-popover-container" ref={topicPopoverRef}>
            <div className="public-topic-trigger-header">
              <span className="public-field-label">Chủ đề ({scopeTopics.length})</span>
              {scopeTopics.length > 0 ? (
                <button
                  className="public-text-action public-topic-clear-btn"
                  type="button"
                  title="Bỏ chọn tất cả chủ đề"
                  onClick={() => {
                    for (const t of [...scopeTopics]) {
                      handlers.onToggleTopic?.(t)
                    }
                  }}
                >
                  Bỏ chọn hết
                </button>
              ) : null}
            </div>

            <button
              id="public-topic-trigger"
              className={`public-topic-trigger-btn ${isTopicPopoverOpen ? 'active' : ''}`}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={isTopicPopoverOpen}
              onClick={() => setIsTopicPopoverOpen((prev) => !prev)}
            >
              <span className="public-topic-trigger-text">
                {scopeTopics.length === 0
                  ? '🏷️ Chọn chủ đề bài viết...'
                  : `🏷️ Đã chọn (${scopeTopics.length}) chủ đề`}
              </span>
              <span className="public-topic-trigger-arrow" aria-hidden="true">
                {isTopicPopoverOpen ? '▲' : '▼'}
              </span>
            </button>

            {isTopicPopoverOpen ? (
              <div
                className="public-topic-popover"
                role="dialog"
                aria-label="Danh mục chủ đề bài viết"
              >
                <div className="public-topic-search-wrap">
                  <input
                    type="search"
                    className="public-input public-topic-search-input"
                    placeholder="Tìm trong 22 chủ đề..."
                    value={topicSearchTerm}
                    onChange={(e) => setTopicSearchTerm(e.target.value)}
                    autoFocus
                  />
                  {topicSearchTerm ? (
                    <button
                      className="public-topic-search-clear"
                      type="button"
                      onClick={() => setTopicSearchTerm('')}
                      aria-label="Xóa tìm kiếm"
                    >
                      ×
                    </button>
                  ) : null}
                </div>

                <div className="public-topic-popover-list" tabIndex={0} role="group" aria-label="Danh mục chủ đề">
                  {filteredTopicGroups.length === 0 ? (
                    <p className="public-topic-empty">Không tìm thấy chủ đề nào phù hợp.</p>
                  ) : (
                    filteredTopicGroups.map((group) => (
                      <div key={group.id} className="public-topic-group">
                        <div className="public-topic-group-title">{group.label}</div>
                        <div className="public-topic-group-items">
                          {group.items.map((item) => {
                            const checked = isTopicSelected(item.label)
                            return (
                              <label
                                key={item.id}
                                className={`public-topic-checkbox-item ${checked ? 'checked' : ''} ${item.isParent ? 'is-parent' : 'is-child'}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handlers.onToggleTopic?.(item.label)}
                                />
                                <span className="public-topic-checkbox-label">
                                  {item.label}
                                  {item.isParent ? <span className="public-topic-parent-tag">Chính</span> : null}
                                </span>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="public-topic-popover-foot">
                  <span className="public-muted" style={{ fontSize: '12px' }}>
                    {scopeTopics.length > 0 ? `${scopeTopics.length} chủ đề được chọn` : 'Chưa chọn chủ đề'}
                  </span>
                  <button
                    className="public-btn public-btn-sm"
                    type="button"
                    onClick={() => setIsTopicPopoverOpen(false)}
                  >
                    Xong
                  </button>
                </div>
              </div>
            ) : null}

            {scopeTopics.length > 0 ? (
              <div className="public-selected-topic-chips" aria-label="Các chủ đề đang chọn">
                {scopeTopics.map((topic) => (
                  <span key={topic} className="public-selected-topic-chip">
                    <span>{topic}</span>
                    <button
                      type="button"
                      aria-label={`Bỏ chọn chủ đề ${topic}`}
                      onClick={() => handlers.onToggleTopic?.(topic)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
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
      <CitationDrawer citation={selectedCitation} onClose={closeCitation} articlesMap={articlesMap} />
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

function ScopeConfirmationPanel({ scope, canConfirm, onConfirm, onCancel }) {
  const summary = scopeConfirmationSummary(scope)
  return (
    <section
      className="public-state-card public-qa-scope-confirmation"
      role="region"
      aria-labelledby="public-qa-scope-confirmation-title"
      aria-describedby="public-qa-scope-confirmation-description"
      aria-live="polite"
    >
      <p className="public-eyebrow">Xác nhận phạm vi</p>
      <h2 id="public-qa-scope-confirmation-title">Phạm vi đề xuất</h2>
      <p id="public-qa-scope-confirmation-description">
        Hệ thống sẽ dùng phạm vi này để tìm nguồn. Hãy kiểm tra trước khi xác nhận.
      </p>
      <ul>
        {summary.map((entry) => <li key={entry}>{entry}</li>)}
      </ul>
      <div className="public-dialog-actions">
        <button className="public-btn public-btn-secondary" type="button" onClick={onCancel}>
          Hủy
        </button>
        <button className="public-btn public-btn-primary" type="button" onClick={onConfirm} disabled={!canConfirm}>
          Xác nhận phạm vi
        </button>
      </div>
    </section>
  )
}

function isHistoricalCitation(citation) {
  return citation?.status === 'available' || citation?.status === 'unavailable'
}

function citationChipTitle(citation, articlesMap) {
  const article = citation?.articleId && articlesMap ? articlesMap.get(String(citation.articleId)) : null
  return (
    citation?.titleVi ||
    article?.titleVi ||
    citation?.titleOriginal ||
    article?.titleOriginal ||
    citation?.title ||
    (citation?.status === 'unavailable' ? 'Nguồn lịch sử' : citation?.sourceName || 'Bài viết nguồn')
  )
}

function citationChipLabel(citation, articlesMap) {
  const title = citationChipTitle(citation, articlesMap)
  const source = citation?.sourceName && citation.sourceName !== title ? ` · ${citation.sourceName}` : ''
  const base = `${title}${source}`
  return isHistoricalCitation(citation) ? `Citation lịch sử · ${base}` : base
}
function CitationDrawer({ citation, onClose, articlesMap }) {
  const dialogRef = useDialogFocus(Boolean(citation), onClose)
  if (!citation) return null
  const url = citation.status === 'unavailable' ? null : safeExternalUrl(citation.originalUrl)
  const historical = isHistoricalCitation(citation)
  const article = citation?.articleId && articlesMap ? articlesMap.get(String(citation.articleId)) : null
  const displayTitle = citation.titleVi || article?.titleVi || citation.titleOriginal || article?.titleOriginal || 'Bài viết nguồn'
  const sourceLabel = citation.sourceName || (citation.status === 'unavailable' ? 'Nguồn lịch sử' : displayTitle || 'Nguồn kiểm chứng')

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
            <h3>{displayTitle}</h3>
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

function MessageThread({ messages, onCitation, pendingQuestion = '', isLoading = false, articlesMap }) {
  const safeMessages = Array.isArray(messages) ? messages : []
  const threadEndRef = useRef(null)
  useEffect(() => {
    if (isLoading || pendingQuestion || safeMessages.length > 0) {
      threadEndRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
    }
  }, [safeMessages.length, pendingQuestion, isLoading])

  if (safeMessages.length === 0 && !pendingQuestion && !isLoading)
    return <StateCard title="Chưa có tin nhắn" copy="Đặt câu hỏi để tạo câu trả lời có nguồn." />

  const lastUserMsg = [...safeMessages].reverse().find((m) => m.role === 'user')
  const showPendingBubble = Boolean(pendingQuestion) && (!lastUserMsg || (lastUserMsg.text !== pendingQuestion && lastUserMsg.content !== pendingQuestion))
  return (
    <div className="public-message-list">
      {messages.map((message, index) => {
        const assistant = message.role !== 'user'
        const paragraphs = Array.isArray(message.paragraphs) ? message.paragraphs : []
        const citations = Array.isArray(message.citations) ? message.citations : []
        const citationById = new Map(citations.map((citation) => [citation.id, citation]))

        // Đánh số thứ tự 1, 2, 3... liên tục theo thứ tự các bài feed xuất hiện trong câu trả lời
        const citationNumberMap = new Map()
        let nextCitationNumber = 1
        for (const p of paragraphs) {
          for (const id of p.citationIds || []) {
            if (!citationNumberMap.has(id)) {
              citationNumberMap.set(id, nextCitationNumber++)
            }
          }
        }
        for (const c of citations) {
          if (c?.id && !citationNumberMap.has(c.id)) {
            citationNumberMap.set(c.id, nextCitationNumber++)
          }
        }

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
              <div className="public-message-bubble public-refusal-bubble">
                <p className="public-refusal-title">
                  <strong>{refusalCopy[message.refusalReason] || 'Câu hỏi bị từ chối an toàn.'}</strong>
                </p>
                {message.refusalReason === 'insufficient-evidence' ? (
                  <div className="public-refusal-guidance">
                    <p className="public-muted">
                      Hệ thống chưa tìm thấy bài viết hoặc dữ liệu liên quan trong các nguồn tin đã thu thập để trả lời câu hỏi này.
                    </p>
                    <ul className="public-refusal-tips">
                      <li>Xem các bài viết mới nhất tại mục <strong>Bảng tin (Feed)</strong> hoặc <strong>Tìm kiếm</strong>.</li>
                      <li>Thử chọn thêm chủ đề hoặc mở rộng phạm vi thời gian ở cột bên phải.</li>
                      <li>Hỏi về các thông tin hoặc sự kiện công nghệ có trong nguồn tin đã thu thập.</li>
                    </ul>
                  </div>
                ) : null}
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
                        const citationNumber = citationNumberMap.get(citationId) || (citationIndex + 1)
                        const feedTitle = citationChipTitle(citation, articlesMap)
                        const hasDistinctSource = Boolean(citation?.sourceName && citation.sourceName !== feedTitle)
                        return citation ? (
                          <button
                            className="public-citation-chip"
                            type="button"
                            key={citationId}
                            onClick={() => onCitation?.(citation)}
                            title={citationChipLabel(citation, articlesMap)}
                          >
                            <span className="public-citation-chip-num">[{citationNumber}]</span>{' '}
                            <span className="public-citation-chip-title">{feedTitle}</span>
                            {hasDistinctSource ? (
                              <span className="public-citation-chip-source"> · {citation.sourceName}</span>
                            ) : null}
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
      {showPendingBubble ? (
        <article
          className="public-message public-message-user public-message-pending"
          aria-label="Câu hỏi vừa gửi"
        >
          <div className="public-message-bubble">{pendingQuestion}</div>
        </article>
      ) : null}
      {isLoading ? (
        <article
          className="public-message public-message-assistant public-message-thinking"
          aria-busy="true"
          aria-live="polite"
        >
          <div className="public-thinking-card">
            <div className="public-thinking-status">
              <div className="public-thinking-badge">
                <span className="public-thinking-sparkle" aria-hidden="true">✨</span>
                <span className="public-thinking-label">Đang truy xuất nguồn và suy nghĩ...</span>
              </div>
              <div className="public-thinking-dots" aria-hidden="true">
                <span className="public-thinking-dot" />
                <span className="public-thinking-dot" />
                <span className="public-thinking-dot" />
              </div>
            </div>
            <div className="public-thinking-shimmer-bar" aria-hidden="true" />
          </div>
        </article>
      ) : null}
      <div ref={threadEndRef} className="public-thread-end" />
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
