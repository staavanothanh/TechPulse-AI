import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRequestSequence } from '../../request-sequence.js'
import { focusTrapTarget } from '../../../saved/dialog-focus.js'
import { createIndexingJobActions, indexingJobPrerequisites, indexingJobsErrorState } from './indexing-job-actions.js'
import { createIndexingApi, createIndexingRequestGate } from './indexing-api.js'
import { nextIndexingPollDelay, shouldPollIndexingJob } from './polling.js'

const EMPTY_FILTERS = Object.freeze({ status: '', task: '', articleId: '', sourceId: '' })
const EMPTY_META = Object.freeze({ hasNext: false, nextCursor: null })
const FILTER_FIELDS = Object.freeze(['status', 'task', 'articleId', 'sourceId'])

function validateIndexingFilters(filters = EMPTY_FILTERS) {
  const normalized = Object.fromEntries(FILTER_FIELDS.map((field) => [field, typeof filters[field] === 'string' ? filters[field].trim() : '']))
  const errors = {}
  if (normalized.articleId.length > 128) errors.articleId = 'Article ID không được dài quá 128 ký tự.'
  if (normalized.sourceId.length > 128) errors.sourceId = 'Source ID không được dài quá 128 ký tự.'
  const firstInvalid = FILTER_FIELDS.find((field) => errors[field]) ?? null
  return { valid: !firstInvalid, filters: normalized, errors, firstInvalid }
}

function filterErrorsFromRequest(error) {
  if (error?.status !== 422 || !error?.fieldErrors || typeof error.fieldErrors !== 'object') return {}
  return Object.fromEntries(FILTER_FIELDS.flatMap((field) => typeof error.fieldErrors[field] === 'string' ? [[field, error.fieldErrors[field]]] : []))
}

function cooldownSecondsFor(cooldown, key, now) {
  if (!cooldown || cooldown.key !== key) return 0
  return Math.max(0, Math.ceil((cooldown.until - now) / 1_000))
}

function confirmationKey(intent) {
  if (!intent) return ''
  if (intent.action === 'create') return `create:${intent.task}:${intent.articleId}`
  return `${intent.action}:${intent.job?.id ?? ''}`
}

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function StatusMark({ status }) {
  return <span className={`indexing-status status-${status}`}><i aria-hidden="true" />{status}</span>
}

export function IndexingActionDialog({ intent, busy, cooldown = 0, error, onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  const confirmRef = useRef(null)
  useEffect(() => { if (intent) confirmRef.current?.focus() }, [intent])
  if (!intent) return null
  const create = intent.action === 'create'
  const retry = intent.action === 'retry'
  const actionTitle = create ? `Tạo job ${intent.task === 'summary' ? 'tóm tắt' : intent.task === 'embedding' ? 'embedding' : 'đối chiếu hiển thị'}?` : retry ? 'Thử lại job này?' : 'Yêu cầu dừng job này?'
  const actionCopy = create ? <>Bài <code>{intent.articleId}</code> sẽ được server kiểm tra policy và trạng thái trước khi xếp hàng.</> : <>Job <code>{intent.job.id}</code> sẽ được server kiểm tra lại trạng thái trước khi thực hiện.</>
  const confirmCopy = create ? 'Xác nhận tạo job' : retry ? 'Thử lại job' : 'Yêu cầu dừng'
  const actionDisabled = busy || cooldown > 0
  function onKeyDown(event) {
    if (event.key === 'Escape' && !busy) {
      event.preventDefault()
      onCancel?.()
      return
    }
    const focusables = [...(dialogRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled])') ?? [])]
    const target = focusTrapTarget({ key: event.key, shiftKey: event.shiftKey, activeElement: document.activeElement, focusables })
    if (target) {
      event.preventDefault()
      target.focus()
    }
  }
  return (
    <div className="content-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel?.() }}>
      <section className="content-dialog" role="dialog" aria-modal="true" aria-labelledby="indexing-action-title" aria-describedby="indexing-action-copy" ref={dialogRef} onKeyDown={onKeyDown}>
        <div className="content-dialog-body">
          <div className="content-eyebrow">Xác nhận thao tác quản trị</div>
          <h2 id="indexing-action-title">{actionTitle}</h2>
          <p id="indexing-action-copy">{actionCopy}</p>
          {error ? <p className="content-mutation-error" role="alert">{error}</p> : null}
        </div>
        <div className="content-dialog-actions">
          <button className="content-button" type="button" onClick={onCancel} disabled={busy}>Quay lại</button>
          <button className={retry || create ? 'content-button content-button-primary' : 'content-button content-button-danger'} type="button" onClick={onConfirm} disabled={actionDisabled} aria-busy={busy || undefined} ref={confirmRef}>{busy ? 'Đang xử lý…' : cooldown > 0 ? `Thử lại sau ${cooldown} giây` : confirmCopy}</button>
        </div>
      </section>
    </div>
  )
}

export function IndexingJobDetails({ job, handlers = {}, busy = false, headingRef }) {
  const prerequisites = indexingJobPrerequisites(job)
  return (
    <section className="indexing-job-details" aria-labelledby="indexing-job-detail-title" aria-busy={busy || undefined}>
      <div className="source-title-row"><div><span className="eyebrow">{job.task} · attempt {job.attempt}</span><h2 id="indexing-job-detail-title" ref={headingRef} tabIndex="-1">Job {job.id}</h2></div><StatusMark status={job.status} /></div>
      <dl className="indexing-facts">
        <div><dt>Article</dt><dd><code>{job.articleId}</code></dd></div>
        <div><dt>Source</dt><dd><code>{job.sourceId}</code></dd></div>
        <div><dt>Trigger</dt><dd>{job.trigger}</dd></div>
        <div><dt>Available</dt><dd>{formatDate(job.availableAt)}</dd></div>
        <div><dt>Created</dt><dd>{formatDate(job.createdAt)}</dd></div>
        <div><dt>Started</dt><dd>{formatDate(job.startedAt)}</dd></div>
        <div><dt>Finished</dt><dd>{formatDate(job.finishedAt)}</dd></div>
        {job.parentJobId ? <div><dt>Retry of</dt><dd><code>{job.parentJobId}</code></dd></div> : null}
      </dl>
      {job.error ? <div className="indexing-safe-error" role="alert"><strong>{job.error.code}</strong><p>{job.error.message}</p><small>{job.error.retryable ? 'Có thể thử lại' : 'Không thể tự thử lại'} · {formatDate(job.error.occurredAt)}</small></div> : null}
      <div className="source-actions" aria-label="Thao tác indexing job">
        <button type="button" disabled={busy || !prerequisites.retryReady} aria-describedby={!prerequisites.retryReady ? 'indexing-retry-reason' : undefined} onClick={(event) => handlers.onRetry?.(job, event.currentTarget)}>Thử lại job</button>
        <button type="button" disabled={busy || !prerequisites.cancelReady} aria-describedby={!prerequisites.cancelReady ? 'indexing-cancel-reason' : undefined} onClick={(event) => handlers.onCancel?.(job, event.currentTarget)}>Yêu cầu dừng</button>
      </div>
      {!prerequisites.retryReady ? <p className="operator-copy" id="indexing-retry-reason">{prerequisites.retryReason}</p> : null}
      {!prerequisites.cancelReady ? <p className="operator-copy" id="indexing-cancel-reason">{prerequisites.cancelReason}</p> : null}
    </section>
  )
}

function IndexingFilters({ filters, errors = {}, handlers, busy, cooldown = 0 }) {
  const errorFor = (field) => errors[field]
  return (
    <form className="indexing-filters" onSubmit={(event) => { event.preventDefault(); handlers.onApplyFilters?.() }} aria-busy={busy || undefined}>
      <label htmlFor="indexing-filter-status">Trạng thái<select id="indexing-filter-status" value={filters.status} onChange={(event) => handlers.onFilterChange?.('status', event.target.value)}><option value="">Tất cả</option>{['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'].map((status) => <option key={status}>{status}</option>)}</select></label>
      <label htmlFor="indexing-filter-task">Task<select id="indexing-filter-task" value={filters.task} onChange={(event) => handlers.onFilterChange?.('task', event.target.value)}><option value="">Tất cả</option>{['summary', 'embedding', 'visibility-reconcile'].map((task) => <option key={task}>{task}</option>)}</select></label>
      <label htmlFor="indexing-filter-article">Article ID<input id="indexing-filter-article" value={filters.articleId} maxLength="128" aria-invalid={Boolean(errorFor('articleId'))} aria-describedby={errorFor('articleId') ? 'indexing-filter-article-error' : undefined} onChange={(event) => handlers.onFilterChange?.('articleId', event.target.value)} />{errorFor('articleId') ? <small className="content-field-error" id="indexing-filter-article-error">{errorFor('articleId')}</small> : null}</label>
      <label htmlFor="indexing-filter-source">Source ID<input id="indexing-filter-source" value={filters.sourceId} maxLength="128" aria-invalid={Boolean(errorFor('sourceId'))} aria-describedby={errorFor('sourceId') ? 'indexing-filter-source-error' : undefined} onChange={(event) => handlers.onFilterChange?.('sourceId', event.target.value)} />{errorFor('sourceId') ? <small className="content-field-error" id="indexing-filter-source-error">{errorFor('sourceId')}</small> : null}</label>
      <button type="submit" disabled={busy || cooldown > 0}>{busy ? 'Đang lọc…' : cooldown > 0 ? `Thử lại sau ${cooldown} giây` : 'Lọc jobs'}</button>
    </form>
  )
}

function CreateArtifactJobs({ onCreate, busy }) {
  const [articleId, setArticleId] = useState('')
  return (
    <form className="indexing-create" onSubmit={(event) => event.preventDefault()}>
      <div><span className="eyebrow">ARTIFACT ACTIONS</span><h3>Tạo work cho một bài</h3></div>
      <label htmlFor="indexing-create-article">Article ID<input id="indexing-create-article" required maxLength="128" value={articleId} onChange={(event) => setArticleId(event.target.value)} /></label>
      <div className="indexing-create-actions">
        <button type="button" disabled={busy || !articleId} onClick={(event) => onCreate('summary', articleId, event.currentTarget)}>Tạo tóm tắt</button>
        <button type="button" disabled={busy || !articleId} onClick={(event) => onCreate('embedding', articleId, event.currentTarget)}>Tạo embedding</button>
        <button type="button" disabled={busy || !articleId} onClick={(event) => onCreate('visibility-reconcile', articleId, event.currentTarget)}>Đối chiếu hiển thị</button>
      </div>
    </form>
  )
}

export function IndexingJobsPanelView({ state = 'loading', jobs = [], selected, filters = EMPTY_FILTERS, filterErrors = {}, meta = EMPTY_META, busy = false, listLoading = false, loadingMore = false, reloadCooldown = 0, filterCooldown = 0, loadMoreCooldown = 0, selectionCooldown = 0, operationError, operationCooldown = 0, error, notice, handlers = {}, detailHeadingRef }) {
  const controlsBusy = busy || listLoading
  return (
    <section className="source-registry indexing-jobs-panel" aria-labelledby="indexing-jobs-title">
      <div className="operator-header"><div><span className="eyebrow">ADMIN · SUMMARY & RETRIEVAL</span><h1 id="indexing-jobs-title">Indexing jobs</h1><p className="operator-copy">Summary, embedding và visibility reconciliation có vòng đời độc lập.</p></div><button className="text-button" type="button" onClick={handlers.onReload} disabled={controlsBusy || reloadCooldown > 0}>{listLoading ? 'Đang tải…' : reloadCooldown > 0 ? `Thử lại sau ${reloadCooldown} giây` : 'Tải lại'}</button></div>
      <div className="source-live" role="status" aria-live="polite" aria-atomic="true">{notice ?? (controlsBusy ? 'Đang xử lý indexing job…' : '')}</div>
      <IndexingFilters filters={filters} errors={filterErrors} handlers={handlers} busy={controlsBusy} cooldown={filterCooldown} />
      {operationError ? <div className="source-state" role="alert"><p>{operationError.message}</p><button type="button" onClick={handlers.onRetryOperation} disabled={controlsBusy || operationCooldown > 0}>{operationCooldown > 0 ? `Thử lại sau ${operationCooldown} giây` : 'Thử lại'}</button></div> : null}
      {state === 'loading' ? <div className="source-state" aria-busy="true">Đang tải indexing jobs…</div> : null}
      {state === 'error' ? <div className="source-state" role="alert"><h2>Không thể tải indexing jobs</h2><p>{error}</p><button type="button" onClick={handlers.onReload} disabled={controlsBusy || reloadCooldown > 0}>{reloadCooldown > 0 ? `Thử lại sau ${reloadCooldown} giây` : 'Thử lại'}</button></div> : null}
      {state === 'ready' ? <div className="source-workspace indexing-workspace"><aside className="source-list" aria-label="Danh sách indexing jobs" aria-busy={loadingMore || undefined}>{jobs.length === 0 ? <p>Chưa có indexing job phù hợp.</p> : jobs.map((item) => <button type="button" key={item.id} className={selected?.id === item.id ? 'selected' : ''} aria-pressed={selected?.id === item.id} disabled={controlsBusy || selectionCooldown > 0} onClick={() => handlers.onSelect?.(item)}><strong>{item.task}</strong><StatusMark status={item.status} /><span>attempt {item.attempt} · {formatDate(item.createdAt)}</span><small>{item.id}</small></button>)}{meta.hasNext ? <button className="content-button content-load-more" type="button" onClick={handlers.onLoadMore} disabled={controlsBusy || loadingMore || loadMoreCooldown > 0} aria-busy={loadingMore || undefined}>{loadingMore ? 'Đang tải thêm…' : loadMoreCooldown > 0 ? `Thử lại sau ${loadMoreCooldown} giây` : 'Tải thêm indexing jobs'}</button> : null}</aside><div className="source-editor">{selected ? <IndexingJobDetails job={selected} handlers={handlers} busy={controlsBusy} headingRef={detailHeadingRef} /> : <div className="source-state"><p>Chọn một job để xem chi tiết.</p></div>}<CreateArtifactJobs onCreate={handlers.onCreate} busy={controlsBusy} /></div></div> : null}
    </section>
  )
}

export default function IndexingJobsPanel({ api, csrfToken, onSessionExpired }) {
  const [state, setState] = useState('loading')
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS)
  const [appliedFilters, setAppliedFilters] = useState(EMPTY_FILTERS)
  const [filterErrors, setFilterErrors] = useState({})
  const [meta, setMeta] = useState(EMPTY_META)
  const [listLoading, setListLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [operationError, setOperationError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState(null)
  const [cooldown, setCooldown] = useState(null)
  const [clock, setClock] = useState(() => Date.now())
  const [pollNonce, setPollNonce] = useState(0)
  const [intentKeys] = useState(() => new Map())
  const detailHeadingRef = useRef(null)
  const selectedRef = useRef(selected)
  const stateRef = useRef(state)
  const listGateRef = useRef(createIndexingRequestGate())
  const listSequenceRef = useRef(createRequestSequence())
  const selectionSequenceRef = useRef(createRequestSequence())
  const detailRequestRef = useRef(false)
  const mutationRequestRef = useRef(false)
  const indexingApi = useMemo(() => createIndexingApi(api), [api])

  useEffect(() => { selectedRef.current = selected }, [selected])
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => () => {
    listSequenceRef.current.invalidate()
    selectionSequenceRef.current.invalidate()
  }, [])
  useEffect(() => {
    if (!cooldown) return undefined
    const remaining = cooldown.until - clock
    if (remaining <= 0) return undefined
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(1_000, remaining))
    return () => window.clearTimeout(timer)
  }, [clock, cooldown])

  const resolveFailure = useCallback((requestError) => {
    const failure = indexingJobsErrorState(requestError)
    if (failure.sessionExpiredNotice) onSessionExpired?.(failure.sessionExpiredNotice)
    return failure
  }, [onSessionExpired])
  const setRateLimitCooldown = useCallback((key, requestError) => {
    if (requestError?.status !== 429 || !Number.isSafeInteger(requestError.retryAfter) || requestError.retryAfter <= 0) return
    const now = Date.now()
    setClock(now)
    setCooldown({ key, until: now + requestError.retryAfter * 1_000 })
  }, [])
  const patchJob = useCallback((job) => {
    setJobs((current) => current.some((item) => item.id === job.id) ? current.map((item) => item.id === job.id ? job : item) : [job, ...current])
    setSelected(job)
  }, [])

  const load = useCallback(async ({ filters = EMPTY_FILTERS, cursor = null, append = false, actionKey = 'reload' } = {}) => {
    const gate = listGateRef.current
    if (gate.isInFlight()) {
      setNotice('Đang tải danh sách indexing jobs. Bộ lọc hiện tại chưa thể gửi lại.')
      return { started: false }
    }
    const ticket = listSequenceRef.current.start()
    const preserveReady = stateRef.current === 'ready'
    if (append) setLoadingMore(true)
    else if (!preserveReady) setState('loading')
    setListLoading(true)
    setError(null)
    setOperationError(null)
    try {
      const query = { ...filters, ...(cursor ? { cursor } : {}) }
      const result = await gate.run(() => indexingApi.listIndexingJobs({ query }))
      if (!result.started || !listSequenceRef.current.isCurrent(ticket)) return result
      const response = result.value
      setJobs((current) => append ? [...current, ...response.data] : response.data)
      setMeta(response.meta ?? EMPTY_META)
      setSelected((current) => append ? current ?? response.data[0] ?? null : response.data.find((job) => job.id === current?.id) ?? response.data[0] ?? null)
      setFilterErrors({})
      setState('ready')
      return result
    } catch (requestError) {
      if (!listSequenceRef.current.isCurrent(ticket)) return { started: true, error: requestError }
      const failure = resolveFailure(requestError)
      const nextFilterErrors = filterErrorsFromRequest(requestError)
      if (Object.keys(nextFilterErrors).length > 0) setFilterErrors(nextFilterErrors)
      setRateLimitCooldown(actionKey, requestError)
      if (append || preserveReady) {
        setOperationError({ scope: append ? 'append' : 'list', actionKey, message: failure.message })
        setNotice(append ? 'Không thể tải thêm indexing jobs. Bạn có thể thử lại.' : 'Không thể áp dụng bộ lọc. Danh sách trước đó vẫn được giữ lại.')
      } else {
        setError(failure.message)
        setState('error')
      }
      return { started: true, error: requestError }
    } finally {
      if (listSequenceRef.current.isCurrent(ticket)) {
        setListLoading(false)
        if (append) setLoadingMore(false)
      }
    }
  }, [indexingApi, resolveFailure, setRateLimitCooldown])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load({ filters: EMPTY_FILTERS, actionKey: 'initial' }) }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const selectJob = useCallback(async (job) => {
    if (detailRequestRef.current) {
      setNotice('Đang cập nhật indexing job đã chọn. Hãy thử lại sau khi yêu cầu hiện tại hoàn tất.')
      return
    }
    const ticket = selectionSequenceRef.current.start()
    detailRequestRef.current = true
    setBusy(true)
    setError(null)
    setOperationError(null)
    try {
      const response = await indexingApi.getIndexingJob({ pathParams: { jobId: job.id } })
      if (!selectionSequenceRef.current.isCurrent(ticket)) return
      patchJob(response.data)
      window.requestAnimationFrame(() => detailHeadingRef.current?.focus({ preventScroll: true }))
    } catch (requestError) {
      if (!selectionSequenceRef.current.isCurrent(ticket)) return
      const failure = resolveFailure(requestError)
      setRateLimitCooldown('selection', requestError)
      setOperationError({ scope: 'selection', actionKey: 'selection', jobId: job.id, message: failure.message })
      setNotice('Không thể tải chi tiết indexing job. Bạn có thể thử lại.')
    } finally {
      detailRequestRef.current = false
      if (selectionSequenceRef.current.isCurrent(ticket)) setBusy(false)
    }
  }, [indexingApi, patchJob, resolveFailure, setRateLimitCooldown])

  useEffect(() => {
    if (!selected?.id) return undefined
    let active = true
    let timer = null
    let inFlight = false
    let errorCount = 0
    let lastStatus = selectedRef.current?.status
    const startedAt = Date.now()
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    const online = () => !globalThis.navigator || globalThis.navigator.onLine !== false
    const schedule = (job, retryAfterSeconds) => {
      if (!active || !shouldPollIndexingJob(job, { visible: visible(), online: online() })) return
      const delay = nextIndexingPollDelay({ elapsedMs: Date.now() - startedAt, errorCount, retryAfterSeconds })
      timer = window.setTimeout(poll, delay)
    }
    const poll = async () => {
      if (!active || inFlight) return
      const current = selectedRef.current
      if (!shouldPollIndexingJob(current, { visible: visible(), online: online() })) return
      if (detailRequestRef.current || mutationRequestRef.current) {
        schedule(current)
        return
      }
      inFlight = true
      detailRequestRef.current = true
      try {
        const response = await indexingApi.getIndexingJob({ pathParams: { jobId: current.id } })
        if (!active) return
        errorCount = 0
        patchJob(response.data)
        if (response.data.status !== lastStatus) {
          setNotice(`Job chuyển từ ${lastStatus} sang ${response.data.status}.`)
          lastStatus = response.data.status
        }
        schedule(response.data)
      } catch (requestError) {
        if (!active) return
        errorCount += 1
        const failure = resolveFailure(requestError)
        setRateLimitCooldown('poll', requestError)
        setOperationError({ scope: 'poll', actionKey: 'poll', jobId: current.id, message: failure.message })
        setNotice('Không thể cập nhật indexing job. Bạn có thể thử lại.')
        schedule(current, requestError.retryAfter)
      } finally {
        inFlight = false
        detailRequestRef.current = false
      }
    }
    const resume = () => {
      if (timer) window.clearTimeout(timer)
      if (shouldPollIndexingJob(selectedRef.current, { visible: visible(), online: online() })) timer = window.setTimeout(poll, 0)
    }
    schedule(selectedRef.current)
    document.addEventListener('visibilitychange', resume)
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', resume)
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
    }
  }, [indexingApi, patchJob, pollNonce, resolveFailure, selected?.id, setRateLimitCooldown])

  const mutate = useCallback(async (action, successMessage) => {
    if (!csrfToken || mutationRequestRef.current) return undefined
    mutationRequestRef.current = true
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await action()
      patchJob(response.data)
      setNotice(successMessage)
      return response
    } catch (requestError) {
      resolveFailure(requestError)
      throw requestError
    } finally {
      mutationRequestRef.current = false
      setBusy(false)
    }
  }, [csrfToken, patchJob, resolveFailure])
  const createActions = useCallback(() => createIndexingJobActions({ api: indexingApi, csrfToken, mutate, intentKeys }), [csrfToken, indexingApi, intentKeys, mutate])
  const closeConfirmation = useCallback(() => {
    const trigger = confirmation?.trigger
    setConfirmation(null)
    setConfirmationError(null)
    window.requestAnimationFrame(() => (trigger?.isConnected ? trigger : detailHeadingRef.current)?.focus({ preventScroll: true }))
  }, [confirmation])
  const confirmAction = useCallback(async () => {
    if (!confirmation) return
    const actions = createActions()
    try {
      if (confirmation.action === 'create') {
        if (confirmation.task === 'summary') await actions.createSummary(confirmation.articleId)
        else await actions.createTask(confirmation.articleId, confirmation.task)
      } else if (confirmation.action === 'retry') await actions.retry(confirmation.job)
      else await actions.cancel(confirmation.job)
      closeConfirmation()
    } catch (requestError) {
      const failure = resolveFailure(requestError)
      setRateLimitCooldown(confirmationKey(confirmation), requestError)
      setConfirmationError(failure.message)
    }
  }, [closeConfirmation, confirmation, createActions, resolveFailure, setRateLimitCooldown])

  const cooldownFor = (key) => cooldownSecondsFor(cooldown, key, clock)
  const handlers = {
    onReload: () => { if (cooldownFor('reload') === 0) void load({ filters: appliedFilters, actionKey: 'reload' }) },
    onFilterChange: (field, value) => {
      setDraftFilters((current) => ({ ...current, [field]: value }))
      setFilterErrors((current) => ({ ...current, [field]: undefined }))
    },
    onApplyFilters: () => {
      const validation = validateIndexingFilters(draftFilters)
      setFilterErrors(validation.errors)
      if (!validation.valid) {
        document.getElementById(`indexing-filter-${validation.firstInvalid === 'articleId' ? 'article' : 'source'}`)?.focus()
        return
      }
      if (cooldownFor('filter') > 0 || listGateRef.current.isInFlight()) {
        setNotice('Đang áp dụng bộ lọc hiện tại. Chưa thể gửi yêu cầu trùng lặp.')
        return
      }
      setAppliedFilters(validation.filters)
      void load({ filters: validation.filters, actionKey: 'filter' })
    },
    onLoadMore: () => {
      if (meta.hasNext && meta.nextCursor && cooldownFor('append') === 0) void load({ filters: appliedFilters, cursor: meta.nextCursor, append: true, actionKey: 'append' })
    },
    onSelect: selectJob,
    onRetryOperation: () => {
      if (!operationError || cooldownFor(operationError.actionKey) > 0) return
      setOperationError(null)
      if (operationError.scope === 'append') {
        if (meta.hasNext && meta.nextCursor) void load({ filters: appliedFilters, cursor: meta.nextCursor, append: true, actionKey: 'append' })
        return
      }
      if (operationError.scope === 'selection') {
        const retryJob = jobs.find((job) => job.id === operationError.jobId) ?? selectedRef.current
        if (retryJob) void selectJob(retryJob)
        return
      }
      if (operationError.scope === 'poll') {
        setPollNonce((value) => value + 1)
        return
      }
      void load({ filters: appliedFilters, actionKey: operationError.actionKey ?? 'reload' })
    },
    onCreate: (task, articleId, trigger) => { setConfirmationError(null); setConfirmation({ action: 'create', task, articleId, trigger }) },
    onRetry: (job, trigger) => { setConfirmationError(null); setConfirmation({ action: 'retry', job, trigger }) },
    onCancel: (job, trigger) => { setConfirmationError(null); setConfirmation({ action: 'cancel', job, trigger }) },
  }
  const dialogCooldown = cooldownFor(confirmationKey(confirmation))
  const operationCooldown = cooldownFor(operationError?.actionKey)
  return <><IndexingJobsPanelView state={state} jobs={jobs} selected={selected} filters={draftFilters} filterErrors={filterErrors} meta={meta} busy={busy} listLoading={listLoading} loadingMore={loadingMore} reloadCooldown={cooldownFor('reload')} filterCooldown={cooldownFor('filter')} loadMoreCooldown={cooldownFor('append')} selectionCooldown={cooldownFor('selection')} operationError={operationError} operationCooldown={operationCooldown} error={error} notice={notice} handlers={handlers} detailHeadingRef={detailHeadingRef} /><IndexingActionDialog intent={confirmation} busy={busy} cooldown={dialogCooldown} error={confirmationError} onCancel={closeConfirmation} onConfirm={confirmAction} /></>
}
