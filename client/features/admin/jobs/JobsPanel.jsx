import { useCallback, useEffect, useRef, useState } from 'react'
import { createJobActions, jobActionPrerequisites, jobsErrorState } from './job-actions.js'
import { createRequestSequence, runLatestRequest } from '../request-sequence.js'

function CreateJobForm({ sources = [], onSubmit, busy, error }) {
  const [sourceId, setSourceId] = useState('')
  const [batchSize, setBatchSize] = useState('20')
  return (
    <form
      className="source-form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({ sourceId, batchSize: Number(batchSize) }).catch(() => {})
      }}
      aria-describedby={error ? 'job-form-error' : undefined}
    >
      <div className="form-heading">
        <h3>Trigger ingestion</h3>
        <span className="policy-chip">durable</span>
      </div>
      <div className="source-form-grid">
        <label htmlFor="job-source-id">
          Nguồn ingestion
          <select
            id="job-source-id"
            required
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
          >
            <option value="">Chọn nguồn đủ điều kiện</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name} · {source.sourceKey}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="job-batch-size">
          Batch size
          <input
            id="job-batch-size"
            required
            type="number"
            min="1"
            max="100"
            value={batchSize}
            onChange={(event) => setBatchSize(event.target.value)}
          />
        </label>
      </div>
      {error ? (
        <p id="job-form-error" className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? 'Đang xếp hàng…' : 'Tạo ingestion job'}
      </button>
    </form>
  )
}

export function JobDetails({ job, handlers, busy = false, headingRef }) {
  const prerequisites = jobActionPrerequisites(job)
  return (
    <section className="source-details" aria-labelledby="job-detail-title">
      <div className="source-title-row">
        <div>
          <span className="eyebrow">
            {job.connectorType} · attempt {job.attempt}
          </span>
          <h2 id="job-detail-title" ref={headingRef} tabIndex="-1">
            Job {job.id}
          </h2>
        </div>
        <div className="source-badges">
          <span>{job.status}</span>
        </div>
      </div>
      <dl className="policy-rail">
        <div>
          <dt>Source</dt>
          <dd>{job.sourceId}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{job.trigger}</dd>
        </div>
        <div>
          <dt>Batch</dt>
          <dd>{job.batchSize}</dd>
        </div>
      </dl>
      <p className="operator-copy">
        Counters: fetched {job.counters.fetched}, created {job.counters.created}, duplicate{' '}
        {job.counters.duplicate}, failed {job.counters.failed}.
      </p>
      {job.error ? (
        <p className="form-error" role="alert">
          {job.error.code}: {job.error.message}
        </p>
      ) : null}
      <div className="source-actions" aria-label="Thao tác ingestion job">
        <button
          type="button"
          onClick={() => handlers.onRetry(job)}
          disabled={busy || !prerequisites.retryReady}
          aria-describedby={!prerequisites.retryReady ? 'job-retry-prerequisite' : undefined}
        >
          Thử lại ingestion
        </button>
        <button
          type="button"
          onClick={() => handlers.onCancel(job)}
          disabled={busy || !prerequisites.cancelReady}
          aria-describedby={!prerequisites.cancelReady ? 'job-cancel-prerequisite' : undefined}
        >
          Yêu cầu dừng
        </button>
      </div>
      {!prerequisites.retryReady ? (
        <p id="job-retry-prerequisite" className="operator-copy">
          {prerequisites.retryReason}
        </p>
      ) : null}
      {!prerequisites.cancelReady ? (
        <p id="job-cancel-prerequisite" className="operator-copy">
          {prerequisites.cancelReason}
        </p>
      ) : null}
    </section>
  )
}

export function JobsPanelView({
  state,
  jobs = [],
  sources = [],
  selected,
  busy = false,
  error,
  notice,
  handlers,
  detailHeadingRef,
}) {
  return (
    <section className="source-registry" aria-labelledby="jobs-panel-title">
      <div className="operator-header">
        <div>
          <span className="eyebrow">ADMIN · DURABLE JOBS</span>
          <h1 id="jobs-panel-title">Ingestion queue và lease state.</h1>
        </div>
        <button className="text-button" type="button" onClick={handlers.onReload} disabled={busy}>
          Tải lại
        </button>
      </div>
      <p className="operator-copy">
        Danh sách chỉ hiển thị trạng thái an toàn; lease owner hash, actor scope và request hash
        không qua HTTP.
      </p>
      <div className="source-live" role="status" aria-live="polite" aria-atomic="true">
        {notice ?? (busy ? 'Đang xử lý job…' : '')}
      </div>
      {state === 'loading' ? (
        <div className="source-state" aria-busy="true">
          Đang tải durable jobs…
        </div>
      ) : null}
      {state === 'error' ? (
        <div className="source-state" role="alert">
          <p>{error}</p>
          <button type="button" onClick={handlers.onReload}>
            Thử lại
          </button>
        </div>
      ) : null}
      {state === 'ready' ? (
        <div className="source-workspace">
          <aside className="source-list" aria-label="Danh sách ingestion jobs">
            {jobs.length === 0 ? (
              <p>Chưa có ingestion job.</p>
            ) : (
              jobs.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={selected?.id === item.id ? 'selected' : ''}
                  aria-pressed={selected?.id === item.id}
                  onClick={() => handlers.onSelect(item)}
                >
                  <strong>
                    {item.connectorType} · {item.status}
                  </strong>
                  <span>
                    attempt {item.attempt} · batch {item.batchSize}
                  </span>
                  <small>{item.id}</small>
                </button>
              ))
            )}
          </aside>
          <div className="source-editor">
            {selected ? (
              <JobDetails
                job={selected}
                handlers={handlers}
                busy={busy}
                headingRef={detailHeadingRef}
              />
            ) : (
              <div className="source-state">
                <p>Chọn một job để xem chi tiết.</p>
              </div>
            )}
            <CreateJobForm
              sources={sources}
              onSubmit={handlers.onCreate}
              busy={busy || sources.length === 0}
              error={error}
            />
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default function JobsPanel({ api, csrfToken, onSessionExpired }) {
  const [state, setState] = useState('loading')
  const [jobs, setJobs] = useState([])
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [sources, setSources] = useState([])
  const [intentKeys] = useState(() => new Map())
  const [focusRequest, setFocusRequest] = useState(0)
  const detailHeadingRef = useRef(null)
  const pollInFlightRef = useRef(false)
  const [requestSequence] = useState(createRequestSequence)

  const handleError = useCallback(
    (requestError) => {
      const failure = jobsErrorState(requestError)
      if (failure.sessionExpiredNotice) onSessionExpired?.(failure.sessionExpiredNotice)
      setError(failure.message)
    },
    [onSessionExpired],
  )
  const reload = useCallback(
    async ({ propagate = false } = {}) => {
      setState('loading')
      setError(null)
      return runLatestRequest({
        sequence: requestSequence,
        request: async () =>
          Promise.all([
            api.listIngestionJobs({ credentials: 'same-origin' }),
            api.listSources({ credentials: 'same-origin' }),
          ]),
        onSuccess: ([response, sourceResponse]) => {
          setJobs(response.data)
          setSources(
            sourceResponse.data.filter(
              (source) =>
                source.operationalStatus === 'active' &&
                ['permitted', 'metadata-only'].includes(source.licenseStatus) &&
                source.technicalCheck?.status === 'passed',
            ),
          )
          setSelected(
            (current) =>
              response.data.find((item) => item.id === current?.id) ?? response.data[0] ?? null,
          )
          setState('ready')
        },
        onError: (requestError) => {
          handleError(requestError)
          setState('error')
        },
        propagate,
      })
    },
    [api, handleError, requestSequence],
  )
  useEffect(() => {
    void runLatestRequest({
      sequence: requestSequence,
      request: async () =>
        Promise.all([
          api.listIngestionJobs({ credentials: 'same-origin' }),
          api.listSources({ credentials: 'same-origin' }),
        ]),
      onSuccess: ([response, sourceResponse]) => {
        setJobs(response.data)
        setSources(
          sourceResponse.data.filter(
            (source) =>
              source.operationalStatus === 'active' &&
              ['permitted', 'metadata-only'].includes(source.licenseStatus) &&
              source.technicalCheck?.status === 'passed',
          ),
        )
        setSelected(response.data[0] ?? null)
        setState('ready')
      },
      onError: (requestError) => {
        handleError(requestError)
        setState('error')
      },
    })
    return () => {
      requestSequence.invalidate()
    }
  }, [api, handleError, requestSequence])
  useEffect(() => {
    if (focusRequest > 0) detailHeadingRef.current?.focus({ preventScroll: true })
  }, [focusRequest, selected?.id])
  useEffect(() => {
    if (
      !selected ||
      !['queued', 'running'].includes(selected.status) ||
      typeof api.getIngestionJob !== 'function'
    )
      return undefined
    let disposed = false
    let timer
    const canPoll = () =>
      globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false
    const poll = async () => {
      if (disposed || pollInFlightRef.current || !canPoll()) return
      pollInFlightRef.current = true
      try {
        const response = await api.getIngestionJob({
          pathParams: { jobId: selected.id },
          credentials: 'same-origin',
        })
        if (disposed) return
        const next = response.data
        setSelected((current) => (current?.id === next.id ? next : current))
        setJobs((current) => current.map((item) => (item.id === next.id ? next : item)))
      } catch (requestError) {
        if (!disposed && requestError?.status === 401) handleError(requestError)
      } finally {
        pollInFlightRef.current = false
        if (!disposed) timer = globalThis.setTimeout(poll, 5_000)
      }
    }
    const resume = () => {
      if (canPoll() && !pollInFlightRef.current) void poll()
    }
    timer = globalThis.setTimeout(poll, 5_000)
    globalThis.document?.addEventListener?.('visibilitychange', resume)
    globalThis.window?.addEventListener?.('online', resume)
    return () => {
      disposed = true
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', resume)
      globalThis.window?.removeEventListener?.('online', resume)
    }
  }, [api, handleError, selected])
  async function mutate(action, successMessage) {
    if (!csrfToken) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await action()
      setSelected(response.data)
      setNotice(successMessage)
      try {
        await reload({ propagate: true })
      } catch {
        setNotice(`${successMessage} Tải lại danh sách chưa thành công.`)
      }
      return response
    } catch (requestError) {
      handleError(requestError)
      throw requestError
    } finally {
      setBusy(false)
    }
  }
  const handlers = {
    onReload: reload,
    onSelect: (job) => {
      setSelected(job)
      setFocusRequest((value) => value + 1)
    },
    onCreate: (input) => createJobActions({ api, csrfToken, mutate, intentKeys }).onCreate(input),
    onRetry: (job) => createJobActions({ api, csrfToken, mutate, intentKeys }).onRetry(job),
    onCancel: (job) => createJobActions({ api, csrfToken, mutate }).onCancel(job),
  }
  return (
    <JobsPanelView
      state={state}
      jobs={jobs}
      sources={sources}
      selected={selected}
      busy={busy}
      error={error}
      notice={notice}
      handlers={handlers}
      detailHeadingRef={detailHeadingRef}
    />
  )
}
