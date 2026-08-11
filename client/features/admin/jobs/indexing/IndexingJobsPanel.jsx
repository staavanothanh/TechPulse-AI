import { useCallback, useEffect, useRef, useState } from 'react'
import { focusTrapTarget } from '../../../saved/dialog-focus.js'
import { createIndexingJobActions, indexingJobPrerequisites, indexingJobsErrorState } from './indexing-job-actions.js'
import { nextIndexingPollDelay, shouldPollIndexingJob } from './polling.js'

const EMPTY_FILTERS = Object.freeze({ status: '', task: '', articleId: '', sourceId: '' })

function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('vi-VN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function StatusMark({ status }) {
  return <span className={`indexing-status status-${status}`}><i aria-hidden="true" />{status}</span>
}

export function IndexingActionDialog({ intent, busy, onCancel, onConfirm }) {
  const dialogRef = useRef(null)
  const confirmRef = useRef(null)
  useEffect(() => { if (intent) confirmRef.current?.focus() }, [intent])
  if (!intent) return null
  const retry = intent.action === 'retry'
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
          <h2 id="indexing-action-title">{retry ? 'Thử lại job này?' : 'Yêu cầu dừng job này?'}</h2>
          <p id="indexing-action-copy">Job <code>{intent.job.id}</code> sẽ được server kiểm tra lại trạng thái trước khi thực hiện.</p>
        </div>
        <div className="content-dialog-actions">
          <button className="content-button" type="button" onClick={onCancel} disabled={busy}>Quay lại</button>
          <button className={retry ? 'content-button content-button-primary' : 'content-button content-button-danger'} type="button" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined} ref={confirmRef}>{busy ? 'Đang xử lý…' : retry ? 'Thử lại job' : 'Yêu cầu dừng'}</button>
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

function IndexingFilters({ filters, handlers, busy }) {
  return (
    <form className="indexing-filters" onSubmit={(event) => { event.preventDefault(); handlers.onApplyFilters?.() }}>
      <label htmlFor="indexing-filter-status">Trạng thái<select id="indexing-filter-status" value={filters.status} onChange={(event) => handlers.onFilterChange?.('status', event.target.value)}><option value="">Tất cả</option>{['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'].map((status) => <option key={status}>{status}</option>)}</select></label>
      <label htmlFor="indexing-filter-task">Task<select id="indexing-filter-task" value={filters.task} onChange={(event) => handlers.onFilterChange?.('task', event.target.value)}><option value="">Tất cả</option>{['summary', 'embedding', 'visibility-reconcile'].map((task) => <option key={task}>{task}</option>)}</select></label>
      <label htmlFor="indexing-filter-article">Article ID<input id="indexing-filter-article" value={filters.articleId} maxLength="128" onChange={(event) => handlers.onFilterChange?.('articleId', event.target.value)} /></label>
      <label htmlFor="indexing-filter-source">Source ID<input id="indexing-filter-source" value={filters.sourceId} maxLength="128" onChange={(event) => handlers.onFilterChange?.('sourceId', event.target.value)} /></label>
      <button type="submit" disabled={busy}>Lọc jobs</button>
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
        <button type="button" disabled={busy || !articleId} onClick={() => onCreate('summary', articleId)}>Tạo tóm tắt</button>
        <button type="button" disabled={busy || !articleId} onClick={() => onCreate('embedding', articleId)}>Tạo embedding</button>
        <button type="button" disabled={busy || !articleId} onClick={() => onCreate('visibility-reconcile', articleId)}>Đối chiếu hiển thị</button>
      </div>
    </form>
  )
}

export function IndexingJobsPanelView({ state = 'loading', jobs = [], selected, filters = EMPTY_FILTERS, busy = false, error, notice, handlers = {}, detailHeadingRef }) {
  return (
    <section className="source-registry indexing-jobs-panel" aria-labelledby="indexing-jobs-title">
      <div className="operator-header"><div><span className="eyebrow">ADMIN · SUMMARY & RETRIEVAL</span><h1 id="indexing-jobs-title">Indexing jobs</h1><p className="operator-copy">Summary, embedding và visibility reconciliation có vòng đời độc lập.</p></div><button className="text-button" type="button" onClick={handlers.onReload} disabled={busy}>Tải lại</button></div>
      <div className="source-live" role="status" aria-live="polite" aria-atomic="true">{notice ?? (busy ? 'Đang xử lý indexing job…' : '')}</div>
      <IndexingFilters filters={filters} handlers={handlers} busy={busy} />
      {state === 'loading' ? <div className="source-state" aria-busy="true">Đang tải indexing jobs…</div> : null}
      {state === 'error' ? <div className="source-state" role="alert"><h2>Không thể tải indexing jobs</h2><p>{error}</p><button type="button" onClick={handlers.onReload}>Thử lại</button></div> : null}
      {state === 'ready' ? <div className="source-workspace indexing-workspace"><aside className="source-list" aria-label="Danh sách indexing jobs">{jobs.length === 0 ? <p>Chưa có indexing job phù hợp.</p> : jobs.map((item) => <button type="button" key={item.id} className={selected?.id === item.id ? 'selected' : ''} aria-pressed={selected?.id === item.id} onClick={() => handlers.onSelect?.(item)}><strong>{item.task}</strong><StatusMark status={item.status} /><span>attempt {item.attempt} · {formatDate(item.createdAt)}</span><small>{item.id}</small></button>)}</aside><div className="source-editor">{selected ? <IndexingJobDetails job={selected} handlers={handlers} busy={busy} headingRef={detailHeadingRef} /> : <div className="source-state"><p>Chọn một job để xem chi tiết.</p></div>}<CreateArtifactJobs onCreate={handlers.onCreate} busy={busy} /></div></div> : null}
    </section>
  )
}

function queryFetch(filters) {
  return async (input, init) => {
    const url = new URL(input)
    for (const [key, value] of Object.entries(filters)) if (value) url.searchParams.set(key, value)
    return fetch(url, init)
  }
}

export default function IndexingJobsPanel({ api, csrfToken, onSessionExpired }) {
  const [state, setState] = useState('loading')
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [confirmation, setConfirmation] = useState(null)
  const [intentKeys] = useState(() => new Map())
  const detailHeadingRef = useRef(null)
  const selectedRef = useRef(selected)
  useEffect(() => { selectedRef.current = selected }, [selected])

  const handleError = useCallback((requestError) => {
    const failure = indexingJobsErrorState(requestError)
    setError(failure.message)
    if (failure.sessionExpiredNotice) onSessionExpired?.(failure.sessionExpiredNotice)
  }, [onSessionExpired])

  const load = useCallback(async () => {
    setState('loading'); setError(null)
    try {
      const response = await api.listIndexingJobs({ credentials: 'same-origin', fetchImpl: queryFetch(filters) })
      setJobs(response.data)
      setSelected((current) => response.data.find((job) => job.id === current?.id) ?? response.data[0] ?? null)
      setState('ready')
    } catch (requestError) { handleError(requestError); setState('error') }
  }, [api, filters, handleError])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const patchJob = useCallback((job) => {
    setJobs((current) => current.some((item) => item.id === job.id) ? current.map((item) => item.id === job.id ? job : item) : [job, ...current])
    setSelected(job)
  }, [])

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
      inFlight = true
      try {
        const response = await api.getIndexingJob({ pathParams: { jobId: current.id }, credentials: 'same-origin' })
        if (!active) return
        errorCount = 0
        patchJob(response.data)
        if (response.data.status !== lastStatus) { setNotice(`Job chuyển từ ${lastStatus} sang ${response.data.status}.`); lastStatus = response.data.status }
        schedule(response.data)
      } catch (requestError) {
        if (!active) return
        errorCount += 1
        handleError(requestError)
        schedule(current, requestError.retryAfter)
      } finally { inFlight = false }
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
  }, [api, handleError, patchJob, selected?.id])

  async function mutate(action, successMessage) {
    if (!csrfToken) return undefined
    setBusy(true); setError(null); setNotice(null)
    try { const response = await action(); patchJob(response.data); setNotice(successMessage); return response } catch (requestError) { handleError(requestError); throw requestError } finally { setBusy(false) }
  }
  const actions = createIndexingJobActions({ api, csrfToken, mutate, intentKeys })
  const closeConfirmation = useCallback(() => {
    const trigger = confirmation?.trigger
    setConfirmation(null)
    window.requestAnimationFrame(() => (trigger?.isConnected ? trigger : detailHeadingRef.current)?.focus({ preventScroll: true }))
  }, [confirmation])
  async function confirmAction() {
    if (!confirmation) return
    try {
      if (confirmation.action === 'retry') await actions.retry(confirmation.job)
      else await actions.cancel(confirmation.job)
    } catch {
      // mutate already maps the canonical error into the visible panel state.
    } finally {
      closeConfirmation()
    }
  }
  const handlers = {
    onReload: load,
    onFilterChange: (field, value) => setFilters((current) => ({ ...current, [field]: value })),
    onApplyFilters: load,
    onSelect: async (job) => {
      setBusy(true); setError(null)
      try { const response = await api.getIndexingJob({ pathParams: { jobId: job.id }, credentials: 'same-origin' }); patchJob(response.data); window.requestAnimationFrame(() => detailHeadingRef.current?.focus({ preventScroll: true })) } catch (requestError) { handleError(requestError) } finally { setBusy(false) }
    },
    onCreate: (task, articleId) => task === 'summary' ? actions.createSummary(articleId) : actions.createTask(articleId, task),
    onRetry: (job, trigger) => setConfirmation({ action: 'retry', job, trigger }),
    onCancel: (job, trigger) => setConfirmation({ action: 'cancel', job, trigger }),
  }
  return <><IndexingJobsPanelView state={state} jobs={jobs} selected={selected} filters={filters} busy={busy} error={error} notice={notice} handlers={handlers} detailHeadingRef={detailHeadingRef} /><IndexingActionDialog intent={confirmation} busy={busy} onCancel={closeConfirmation} onConfirm={confirmAction} /></>
}
