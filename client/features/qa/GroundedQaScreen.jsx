import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AnswerResult from './AnswerResult.jsx'
import AnswerScopeControls from './AnswerScopeControls.jsx'
import { CitationDrawer } from './CitationDrawer.jsx'
import ChatSessionList from './ChatSessionList.jsx'
import ChatSessionTranscript from './ChatSessionTranscript.jsx'
import GenerationProgress from './GenerationProgress.jsx'
import QuestionComposer from './QuestionComposer.jsx'
import { createQaApi } from './qa-api.js'
import { appendSessionPage, boundedQaCooldown, firstQaFieldError, validateAnswerPayload, validateQuestionScope } from './qa-validation.js'
import { useDialogFocus } from './dialog-focus.js'

const phaseTimers = Object.freeze({ retrieving: 450, provider: 850 })
const compact = (query) => Boolean(globalThis.matchMedia?.(query)?.matches)

export default function GroundedQaScreen({ generatedApi, csrfToken, api: injectedApi, announce, onSessionExpired }) {
  const api = useMemo(() => injectedApi ?? createQaApi(generatedApi), [generatedApi, injectedApi])
  const [scope, setScope] = useState({ topics: ['AI'] })
  const [fieldErrors, setFieldErrors] = useState({})
  const [sessions, setSessions] = useState([])
  const [nextCursor, setNextCursor] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [detail, setDetail] = useState(null)
  const [listState, setListState] = useState('loading')
  const [listNotice, setListNotice] = useState('Trạng thái danh sách phiên')
  const [transcriptState, setTranscriptState] = useState('empty')
  const [phase, setPhase] = useState(null)
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState(null)
  const [citation, setCitation] = useState(null)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [deletePending, setDeletePending] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [cooldowns, setCooldowns] = useState({ answer: 0, delete: 0, clear: 0 })
  const listStatusRef = useRef(null)
  const emptyHeadingRef = useRef(null)
  const conversationHeadingRef = useRef(null)
  const resultHeadingRef = useRef(null)
  const selectionRequestRef = useRef(0)
  const closeScope = useCallback(() => setScopeOpen(false), [])
  const closeHistory = useCallback(() => setHistoryOpen(false), [])
  const closeCitation = useCallback(() => setCitation(null), [])
  const closeConfirm = useCallback(() => { if (!deletePending) { setConfirm(null); setDeleteError('') } }, [deletePending])
  const scopeDialogRef = useDialogFocus(scopeOpen, closeScope)
  const historyDialogRef = useDialogFocus(historyOpen, closeHistory)
  const confirmDialogRef = useDialogFocus(Boolean(confirm), closeConfirm)

  const handleSessionExpired = useCallback((nextError) => {
    if (nextError?.status !== 401) return false
    setPhase(null); setCitation(null); setDeletePending(false); setConfirm(null); setError(null)
    onSessionExpired?.()
    return true
  }, [onSessionExpired])

  useEffect(() => {
    if (!Object.values(cooldowns).some((value) => value > 0)) return undefined
    const timer = globalThis.setTimeout(() => setCooldowns((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, Math.max(0, value - 1)]))), 1000)
    return () => globalThis.clearTimeout(timer)
  }, [cooldowns])

  const refreshSessions = useCallback(async ({ append = false, cursor } = {}) => {
    setListState('loading')
    try {
      const response = await api.listSessions?.({ limit: 20, ...(cursor ? { cursor } : {}) })
      const page = response?.data ?? []
      setSessions((current) => append ? appendSessionPage(current, page) : page)
      setNextCursor(response?.meta?.nextCursor ?? null)
      setListState('ready')
    } catch (nextError) {
      if (handleSessionExpired(nextError)) return
      setListState('error'); setError(nextError)
    }
  }, [api, handleSessionExpired])

  useEffect(() => {
    const timer = globalThis.setTimeout(() => { refreshSessions() }, 0)
    return () => globalThis.clearTimeout(timer)
  }, [refreshSessions])

  const focusListDestination = useCallback(({ empty = false } = {}) => {
    if (compact('(max-width: 600px)')) setHistoryOpen(true)
    globalThis.setTimeout(() => (empty ? emptyHeadingRef.current : listStatusRef.current)?.focus(), 0)
  }, [])

  const focusInvalidField = useCallback((field) => {
    const scopeField = field !== 'question'
    const compactScope = scopeField && compact('(max-width: 1000px)')
    if (compactScope) setScopeOpen(true)
    globalThis.setTimeout(() => document.getElementById(`${compactScope ? 'qa-dialog' : 'qa'}-${field}`)?.focus(), 0)
  }, [])

  const selectSession = useCallback(async (id) => {
    if (phase) return
    const requestId = selectionRequestRef.current + 1
    selectionRequestRef.current = requestId
    setSelectedId(id); setDetail(null); setAnswer(null); setError(null); setTranscriptState('loading'); closeHistory()
    try {
      const response = await api.getSession?.(id)
      if (requestId !== selectionRequestRef.current) return
      const nextDetail = response?.data ?? response
      setDetail(nextDetail); setTranscriptState('ready'); announce?.('Đã tải lịch sử phiên từ server')
      globalThis.setTimeout(() => conversationHeadingRef.current?.focus(), 0)
    } catch (nextError) {
      if (requestId !== selectionRequestRef.current) return
      if (handleSessionExpired(nextError)) return
      if (nextError?.status === 404) {
        setSelectedId(null); setDetail(null); setTranscriptState('empty'); setError(null)
        setListNotice('Phiên không còn khả dụng')
        announce?.('Phiên không còn khả dụng')
        focusListDestination()
        return
      }
      setTranscriptState('error'); setError(nextError); announce?.('Không thể tải phiên')
    }
  }, [api, announce, closeHistory, focusListDestination, handleSessionExpired, phase])

  async function submitQuestion(question) {
    const validation = validateQuestionScope(question, scope)
    if (!validation.valid) {
      setFieldErrors({ [validation.firstInvalid]: validation.message })
      focusInvalidField(validation.firstInvalid)
      return
    }
    const key = globalThis.crypto?.randomUUID?.() ?? `qa-${Date.now()}`
    setFieldErrors({}); setError(null); setPhase('retrieving'); setAnswer(null); announce?.('Đang truy xuất nguồn')
    const timer = globalThis.setTimeout(() => { setPhase('provider'); announce?.('Đang chờ dịch vụ trả lời') }, phaseTimers.retrieving)
    const timer2 = globalThis.setTimeout(() => { setPhase('support'); announce?.('Đang kiểm tra mức hỗ trợ') }, phaseTimers.provider)
    try {
      const response = await api.createAnswer?.({ question, scope }, { csrfToken, idempotencyKey: key, chatSessionId: selectedId })
      const checked = validateAnswerPayload(response)
      if (!checked.valid) throw Object.assign(new Error('Câu trả lời không đáp ứng định dạng an toàn'), { code: 'invalid_answer_shape' })
      setAnswer(checked.answer); setDetail(null); setTranscriptState('empty'); setPhase(null); announce?.(checked.answer.status === 'answered' ? 'Đã nhận câu trả lời có nguồn' : 'Câu hỏi được từ chối an toàn')
      refreshSessions()
      globalThis.setTimeout(() => resultHeadingRef.current?.focus(), 0)
    } catch (nextError) {
      setPhase(null)
      if (handleSessionExpired(nextError)) return
      if (nextError?.status === 422 && nextError.fieldErrors) {
        setFieldErrors(nextError.fieldErrors)
        const first = firstQaFieldError(nextError.fieldErrors)
        focusInvalidField(first)
      }
      const cooldown = boundedQaCooldown(nextError)
      if (cooldown) setCooldowns((current) => ({ ...current, answer: cooldown }))
      setError(nextError); announce?.('Không thể hoàn tất câu hỏi')
    } finally { globalThis.clearTimeout(timer); globalThis.clearTimeout(timer2) }
  }

  function handleInvalid(result) {
    setFieldErrors({ [result.firstInvalid]: result.message })
    focusInvalidField(result.firstInvalid)
  }

  function clearFieldError(field) {
    setFieldErrors((current) => current[field] ? { ...current, [field]: undefined } : current)
  }

  function confirmDelete(kind, id = null) {
    if (cooldowns[kind === 'clear' ? 'clear' : 'delete'] > 0) return
    setDeleteError(''); setConfirm({ kind, id })
  }
  async function executeDelete() {
    const current = confirm
    if (!current || deletePending) return
    setDeletePending(true); setDeleteError('')
    try {
      if (current.kind === 'clear') await api.clearSessions?.(csrfToken)
      else await api.deleteSession?.(current.id, csrfToken)
      if (current.kind === 'clear') { setSessions([]); setSelectedId(null); setDetail(null); setTranscriptState('empty') } else { setSessions((items) => items.filter((item) => item.id !== current.id)); if (selectedId === current.id) { setSelectedId(null); setDetail(null); setTranscriptState('empty') } }
      setConfirm(null); announce?.('Đã xóa phiên hỏi đáp')
      focusListDestination({ empty: current.kind === 'clear' })
    } catch (nextError) {
      if (handleSessionExpired(nextError)) return
      const cooldown = boundedQaCooldown(nextError)
      if (cooldown) setCooldowns((values) => ({ ...values, [current.kind === 'clear' ? 'clear' : 'delete']: cooldown }))
      setDeleteError(nextError?.status === 429 ? `Thử lại sau ${cooldown} giây.` : 'Không thể xóa phiên hỏi đáp. Hãy thử lại rõ ràng.')
      announce?.('Không thể xóa phiên hỏi đáp')
    } finally { setDeletePending(false) }
  }

  const currentDeleteCooldown = confirm ? cooldowns[confirm.kind === 'clear' ? 'clear' : 'delete'] : 0

  return (
    <section className="qa-workspace" aria-label="Q&A có nguồn">
      <div className="qa-product-header">
        <div><span className="qa-eyebrow">TechPulse AI · grounded Q&A</span><h1>Hỏi đáp có nguồn</h1></div>
        <div className="qa-mobile-actions">
          <button className="qa-button qa-history-action" type="button" onClick={() => setHistoryOpen(true)}>Lịch sử phiên</button>
          <button className="qa-button" type="button" onClick={() => setScopeOpen(true)}>Mở phạm vi</button>
        </div>
      </div>
      <div className="qa-layout">
        <div className={historyOpen ? 'qa-history-scrim open' : 'qa-history-scrim'} role="presentation" onClick={closeHistory}>
        <div className={historyOpen ? 'qa-rail-modal open' : 'qa-rail-modal'} ref={historyDialogRef} tabIndex="-1" role={historyOpen ? 'dialog' : undefined} aria-modal={historyOpen || undefined} aria-label={historyOpen ? 'Lịch sử phiên' : undefined} onClick={(event) => event.stopPropagation()}>
          <ChatSessionList sessions={sessions} selectedId={selectedId} loading={listState === 'loading'} statusRef={listStatusRef} emptyHeadingRef={emptyHeadingRef} statusText={listNotice} onSelect={selectSession} onDelete={(id) => confirmDelete('one', id)} onClear={() => confirmDelete('clear')} onLoadMore={() => refreshSessions({ append: true, cursor: nextCursor })} hasNext={Boolean(nextCursor)} deleteCooldown={cooldowns.delete} clearCooldown={cooldowns.clear} selectionLocked={Boolean(phase)} />
        </div>
        </div>
        <section className="qa-main">
          <div className="qa-conversation-head"><div><h2 tabIndex="-1" ref={conversationHeadingRef}>{detail?.title || 'Phiên hỏi đáp'}</h2><p>Chỉ hiển thị transcript bounded từ server.</p></div></div>
          <div className="qa-conversation">
            {phase ? <GenerationProgress phase={phase} /> : error && !answer ? <section className="qa-conversation-state" role="alert"><h3>Không thể hoàn tất yêu cầu</h3><p>{error.status === 429 ? `Thử lại sau ${cooldowns.answer} giây.` : 'Giữ câu hỏi và phạm vi để thử lại rõ ràng.'}</p></section> : answer ? <AnswerResult answer={answer} onCitation={setCitation} headingRef={resultHeadingRef} /> : <ChatSessionTranscript status={transcriptState} detail={detail} error={error} onRetry={() => selectedId && selectSession(selectedId)} onCitation={setCitation} />}
          </div>
          <QuestionComposer scope={scope} onSubmit={submitQuestion} onInvalid={handleInvalid} onFieldChange={clearFieldError} busy={Boolean(phase)} cooldown={cooldowns.answer} errors={fieldErrors} />
        </section>
        <aside className="qa-scope-rail"><div className="qa-rail-header"><h2>Phạm vi nguồn</h2></div><AnswerScopeControls value={scope} onChange={setScope} onFieldChange={clearFieldError} errors={fieldErrors} /></aside>
      </div>
      {scopeOpen ? <div className="qa-dialog-scrim" role="presentation" onClick={closeScope}><div className="qa-dialog" ref={scopeDialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="qa-scope-dialog-title" onClick={(event) => event.stopPropagation()}><h2 id="qa-scope-dialog-title">Phạm vi nguồn</h2><AnswerScopeControls value={scope} onChange={setScope} onFieldChange={clearFieldError} errors={fieldErrors} idPrefix="qa-dialog" /><button className="qa-button qa-primary" type="button" onClick={closeScope}>Xong</button></div></div> : null}
      {confirm ? <div className="qa-dialog-scrim" role="presentation"><div className="qa-dialog" ref={confirmDialogRef} tabIndex="-1" role="alertdialog" aria-modal="true" aria-labelledby="qa-confirm-title" aria-busy={deletePending || undefined}><h2 id="qa-confirm-title">{confirm.kind === 'clear' ? 'Xóa tất cả phiên hỏi đáp?' : 'Xóa phiên hỏi đáp?'}</h2><p>Thao tác này không thể hoàn tác.</p>{deleteError ? <p className="qa-error" role="alert">{deleteError}</p> : null}<div className="qa-dialog-actions"><button className="qa-button" type="button" onClick={closeConfirm} disabled={deletePending}>Hủy</button><button className="qa-button qa-danger" type="button" onClick={executeDelete} disabled={deletePending || currentDeleteCooldown > 0}>{deletePending ? 'Đang xóa…' : currentDeleteCooldown > 0 ? `Thử lại sau ${currentDeleteCooldown} giây` : 'Xóa'}</button></div></div></div> : null}
      <CitationDrawer citation={citation} open={Boolean(citation)} onClose={closeCitation} />
    </section>
  )
}
