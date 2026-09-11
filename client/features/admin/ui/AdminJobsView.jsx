import { useEffect, useRef, useState } from 'react'
import {
  aggregateDueWorkCounters,
  artifactJobRequest,
  formatAdminDate,
  isAdminJobRetryable,
  listItems,
  mutateAdmin,
  normalizeDueWorkRun,
  normalizeLifecycleEventQuery,
  queueLabel,
  runAdminDueWork,
  statusLabel,
  taskLabel,
  useAdminMutation,
  useAdminResource,
} from './admin-data.js'
import {
  nextIndexingPollDelay,
  shouldPollIndexingJob,
} from '../jobs/indexing/polling.js'
import {
  AdminButton,
  AdminConfirmDialog,
  ArticlePreviewDialog,
  CompactId,
  Icon,
  PageHeader,
  Panel,
  ResourceFrame,
  SourceBadge,
  StatusBadge,
  Table,
} from './AdminShared.jsx'
function JobRowActions({ job, kind, onRetry, onCancel, busy }) {
  const retryable = isAdminJobRetryable(job, kind)
  const cancellable = ['queued', 'running'].includes(job.status)
  return (
    <div className="admin-row-actions">
      {retryable ? (
        <AdminButton
          size="small"
          variant="primary"
          icon="refresh"
          onClick={(event) => onRetry(job, kind, event.currentTarget)}
          disabled={busy}
        >
          Thử lại
        </AdminButton>
      ) : null}
      {cancellable ? (
        <AdminButton
          size="small"
          variant="secondary"
          icon="pause"
          onClick={(event) => onCancel(job, kind, event.currentTarget)}
          disabled={busy}
        >
          Yêu cầu dừng
        </AdminButton>
      ) : null}
    </div>
  )
}

function JobTimestamp({ value }) {
  const formatted = formatAdminDate(value)
  if (!value || formatted === 'Không xác định') {
    return <span className="admin-muted admin-job-time">{formatted}</span>
  }
  return (
    <time className="admin-job-time" dateTime={value}>
      {formatted}
    </time>
  )
}

const JOB_TIME_COLUMNS = Object.freeze([
  {
    key: 'createdAt',
    label: 'Tạo lúc',
    render: (value) => <JobTimestamp value={value} />,
  },
  {
    key: 'finishedAt',
    label: 'Hoàn thành lúc',
    render: (value) => <JobTimestamp value={value} />,
  },
])

export function JobList({
  data,
  state,
  error,
  reload,
  loadMore,
  loadingMore,
  kind,
  onRetry,
  onCancel,
  onPreviewArticle,
  busy,
}) {
  const rows = listItems(data)
  const resource = { state, error, reload, data, loadMore, loadingMore }
  return (
    <ResourceFrame
      resource={resource}
      loadingLabel={`Đang tải tác vụ ${kind === 'ingestion' ? 'thu thập' : 'chỉ mục'}…`}
    >
      <Table
        label={`Tác vụ ${kind === 'ingestion' ? 'thu thập' : 'chỉ mục'}`}
        rows={rows}
        emptyTitle="Chưa có tác vụ phù hợp."
        columns={
          kind === 'ingestion'
            ? [
                {
                  key: 'id',
                  label: 'Tác vụ',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <strong className="admin-cell-primary">
                        {(row.connectorType ?? 'connector').toUpperCase()} · {row.trigger ?? 'không rõ'}
                      </strong>
                      <small className="admin-cell-sub">
                        <span>Tác vụ: </span>
                        <CompactId id={value} label="Mã tác vụ" length={8} />
                      </small>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  label: 'Trạng thái',
                  render: (value) => <StatusBadge value={value} />,
                },
                ...JOB_TIME_COLUMNS,
                {
                  key: 'sourceId',
                  label: 'Nguồn thu thập',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <SourceBadge sourceId={value} />
                      <small className="admin-cell-sub">
                        <span>Nguồn: </span>
                        <CompactId id={value} label="Mã nguồn" length={8} />
                        <span> · lần thử {row.attempt ?? 1} · lô {row.batchSize ?? 20}</span>
                      </small>
                    </div>
                  ),
                },
                {
                  key: 'counters',
                  label: 'Bộ đếm',
                  render: (value) =>
                    value ? (
                      <span className="admin-counter-copy">
                        {value.fetched ?? 0} đã lấy · {value.created ?? 0} đã tạo ·{' '}
                        {value.failed ?? 0} lỗi
                      </span>
                    ) : (
                      'Chưa ghi nhận'
                    ),
                },
              ]
            : [
                {
                  key: 'id',
                  label: 'Tác vụ',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <strong className="admin-cell-primary">
                        {taskLabel(row.task)} · {row.trigger ?? 'không rõ'}
                      </strong>
                      <small className="admin-cell-sub">
                        <span>Tác vụ: </span>
                        <CompactId id={value} label="Mã tác vụ" length={8} />
                      </small>
                    </div>
                  ),
                },
                {
                  key: 'status',
                  label: 'Trạng thái',
                  render: (value) => <StatusBadge value={value} />,
                },
                ...JOB_TIME_COLUMNS,
                {
                  key: 'articleId',
                  label: 'Bài viết',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <div className="admin-cell-title-row">
                        <SourceBadge sourceId={row.sourceId} />
                        <button
                          type="button"
                          className="admin-btn-preview"
                          onClick={(event) => onPreviewArticle?.(value, event.currentTarget)}
                          title={`Xem nhanh bài viết ${value}`}
                          aria-label={`Xem nhanh bài viết ${value}`}
                        >
                          <Icon name="eye" size={13} />
                          <span>Xem</span>
                        </button>
                      </div>
                      <small className="admin-cell-sub">
                        <span>Bài viết: </span>
                        <CompactId id={value} label="Mã bài viết" length={8} />
                        <span> · lần thử {row.attempt ?? '—'}</span>
                      </small>
                    </div>
                  ),
                },
                {
                  key: 'error',
                  label: 'Kết quả',
                  render: (value) =>
                    value ? (
                      <span className="admin-safe-error">
                        {value.code ?? 'job_error'}: {value.message ?? 'Không thể xử lý'}
                      </span>
                    ) : (
                      <StatusBadge value="succeeded" label="Không có lỗi" />
                    ),
                },
              ]
        }
      >
        {(row) => (
          <JobRowActions job={row} kind={kind} onRetry={onRetry} onCancel={onCancel} busy={busy} />
        )}
      </Table>
    </ResourceFrame>
  )
}
export function EventList({
  data,
  state,
  error,
  reload,
  loadMore,
  loadingMore,
}) {
  const rows = listItems(data)
  const resource = { state, error, reload, data, loadMore, loadingMore }
  return (
    <ResourceFrame
      resource={resource}
      loadingLabel="Đang tải sự kiện vòng đời…"
    >
      <Table
        label="Sự kiện vòng đời"
        rows={rows}
        emptyTitle="Chưa có sự kiện nào."
        columns={[
          {
            key: 'eventId',
            label: 'Sự kiện',
            render: (value, row) => (
              <div className="admin-cell-resource">
                <strong className="admin-cell-primary">{row.stage}</strong>
                <small className="admin-cell-sub">
                  <span>Sự kiện: </span>
                  <CompactId id={value} label="Mã sự kiện" length={8} />
                  {row.elapsedMs !== null && row.elapsedMs !== undefined ? (
                    <span> · {row.elapsedMs}ms</span>
                  ) : null}
                </small>
              </div>
            ),
          },
          {
            key: 'status',
            label: 'Trạng thái',
            render: (value) => <StatusBadge value={value} />,
          },
          {
            key: 'occurredAt',
            label: 'Thời gian',
            render: (value) => <JobTimestamp value={value} />,
          },
          {
            key: 'runId',
            label: 'Lượt / Hàng đợi / Tác vụ',
            render: (value, row) => (
              <div className="admin-cell-resource">
                <strong className="admin-cell-primary">
                  {row.queueName ? queueLabel(row.queueName) : 'cron'}
                  {row.task ? ` · ${taskLabel(row.task)}` : ''}
                </strong>
                <small className="admin-cell-sub">
                  {value ? (
                    <>
                      <span>Lượt: </span>
                      <CompactId id={value} label="Mã lượt chạy" length={8} />
                    </>
                  ) : (
                    <span>Không có lượt chạy</span>
                  )}
                </small>
              </div>
            ),
          },
          {
            key: 'jobId',
            label: 'Tác vụ / Nguồn / Bài viết',
            render: (value, row) => (
              <div className="admin-cell-resource">
                <small className="admin-cell-sub">
                  {value ? (
                    <>
                      <span>Tác vụ: </span>
                      <CompactId id={value} label="Mã tác vụ" length={8} />
                    </>
                  ) : null}
                  {row.articleId ? (
                    <>
                      <span> · Bài: </span>
                      <CompactId id={row.articleId} label="Mã bài viết" length={8} />
                    </>
                  ) : null}
                  {row.sourceId ? (
                    <>
                      <span> · Nguồn: </span>
                      <CompactId id={row.sourceId} label="Mã nguồn" length={8} />
                    </>
                  ) : null}
                </small>
              </div>
            ),
          },
          {
            key: 'error',
            label: 'Chi tiết / Lỗi',
            render: (value, row) => {
              if (value) {
                return (
                  <span className="admin-safe-error">
                    {value.code}: {value.retryable ? 'thử lại được' : 'không thử lại được'}
                  </span>
                )
              }
              if (row.counters) {
                const items = Object.entries(row.counters)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${k}:${v}`)
                return items.length > 0 ? (
                  <span className="admin-counter-copy">{items.join(' · ')}</span>
                ) : (
                  <StatusBadge value="succeeded" label="Thành công" />
                )
              }
              return <StatusBadge value="succeeded" label="Không có lỗi" />
            },
          },
        ]}
      />
    </ResourceFrame>
  )
}

const DUE_WORK_COUNTERS = Object.freeze([
  ['claimed', 'Đã nhận'],
  ['succeeded', 'Thành công'],
  ['partial', 'Một phần'],
  ['failed', 'Lỗi'],
  ['deferred', 'Hoãn lại'],
])

const DUE_WORK_QUEUES = Object.freeze([
  ['ingestion', 'Thu thập dữ liệu'],
  ['indexing', 'Chỉ mục hóa'],
  ['accountDeletion', 'Xóa tài khoản'],
])

function DueWorkRunPanel({ run }) {
  const normalized = run ?? normalizeDueWorkRun({})
  const aggregate = aggregateDueWorkCounters(normalized)
  return (
    <Panel
      className="admin-due-work-panel"
      title="Kết quả lượt chạy giới hạn gần nhất"
    >
      <div className="admin-due-work-meta" role="status">
        {normalized.runId
          ? `Lượt chạy ${normalized.runId}`
          : 'Chưa có lần chạy thủ công nào trong phiên này.'}
      </div>
      <div className="admin-due-work-summary" aria-label="Tổng hợp bộ đếm lượt chạy giới hạn">
        {DUE_WORK_COUNTERS.map(([key, label]) => (
          <div className="admin-due-work-counter" key={key}>
            <strong>{aggregate[key]}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="admin-due-work-queues" aria-label="Kết quả theo hàng đợi">
        {DUE_WORK_QUEUES.map(([queueName, label]) => (
          <div className="admin-due-work-queue" key={queueName}>
            <h3>{label}</h3>
            <dl>
              {DUE_WORK_COUNTERS.map(([key, counterLabel]) => (
                <div key={key}>
                  <dt>{counterLabel}</dt>
                  <dd>{normalized.queues[queueName][key]}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function IngestionCreateForm({ sources, onSubmit, busy }) {
  const [sourceId, setSourceId] = useState('')
  const [batchSize, setBatchSize] = useState('20')
  const eligible = sources.filter(
    (source) =>
      source.operationalStatus === 'active' &&
      ['permitted', 'metadata-only'].includes(source.licenseStatus) &&
      source.technicalCheck?.status === 'passed',
  )
  return (
    <form
      className="admin-inline-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (sourceId) void onSubmit({ sourceId, batchSize: Number(batchSize) })
      }}
    >
      <div>
        <label htmlFor="admin-job-source">Nguồn thu thập</label>
        <select
          id="admin-job-source"
          value={sourceId}
          onChange={(event) => setSourceId(event.target.value)}
          required
        >
          <option value="">Chọn nguồn đủ điều kiện</option>
          {eligible.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name} · {source.sourceKey}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="admin-job-batch">Kích thước lô</label>
        <input
          id="admin-job-batch"
          type="number"
          min="1"
          max="100"
          value={batchSize}
          onChange={(event) => setBatchSize(event.target.value)}
          required
        />
      </div>
      <AdminButton
        type="submit"
        variant="primary"
        icon="arrow"
        disabled={busy || eligible.length === 0}
      >
        Kích hoạt thu thập
      </AdminButton>
      {eligible.length === 0 ? (
        <small className="admin-form-hint">Chưa có nguồn hoạt động nào đủ điều kiện.</small>
      ) : null}
    </form>
  )
}

function IndexingCreateForm({ onSubmit, busy }) {
  const [articleId, setArticleId] = useState('')
  const [task, setTask] = useState('embedding')
  return (
    <form
      className="admin-inline-form admin-indexing-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (articleId.trim()) void onSubmit(articleId.trim(), task)
      }}
    >
      <div>
        <label htmlFor="admin-index-article">Mã bài viết</label>
        <input
          id="admin-index-article"
          value={articleId}
          maxLength="128"
          onChange={(event) => setArticleId(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="admin-index-task">Tác vụ</label>
        <select
          id="admin-index-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
        >
          <option value="summary">Tóm tắt</option>
          <option value="embedding">Vector</option>
          <option value="visibility-reconcile">Đối chiếu hiển thị</option>
        </select>
      </div>
      <AdminButton type="submit" variant="primary" icon="arrow" disabled={busy}>
        Xếp tác vụ chỉ mục
      </AdminButton>
    </form>
  )
}

export function JobsActionBar({ ingestion, indexing, tab }) {
  if (tab === 'events') return null
  return (
    <div className="admin-jobs-action-slot">
      {tab === 'ingestion' ? (
        <IngestionCreateForm {...ingestion} />
      ) : (
        <IndexingCreateForm {...indexing} />
      )}
    </div>
  )
}
export function reloadAdminJobResources({ tab, ingestion, indexing, events, sources } = {}) {
  if (tab === 'events') return events?.reload?.()
  if (tab === 'ingestion') {
    sources?.reload?.()
    return ingestion?.reload?.()
  }
  return indexing?.reload?.()
}

export function reloadAfterDueWork({ ingestion, indexing, events } = {}) {
  ingestion?.reload?.()
  indexing?.reload?.()
  return events?.reload?.()
}


export function AdminJobsView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const seeded = initialData ?? {}
  const [tab, setTab] = useState(seeded.tab ?? 'ingestion')
  const [draftQuery, setDraftQuery] = useState({
    ingestion: { status: '' },
    indexing: { status: '' },
    events: { status: '', queueName: '', task: '', runId: '', jobId: '', articleId: '', sourceId: '', from: '', to: '' },
  })
  const [appliedQuery, setAppliedQuery] = useState({})
  const [dueWorkRun, setDueWorkRun] = useState(
    seeded.dueWorkRun ? normalizeDueWorkRun(seeded.dueWorkRun) : null,
  )
  const [confirmation, setConfirmation] = useState(null)
  const [previewArticleId, setPreviewArticleId] = useState(null)
  const confirmationTriggerRef = useRef(null)
  const previewTriggerRef = useRef(null)
  const pollStartedAtRef = useRef(null)
  const ingestion = useAdminResource(api, 'listIngestionJobs', {
    enabled: tab === 'ingestion',
    initialData: seeded.ingestion,
    query: appliedQuery.ingestion ?? {},
    onSessionExpired,
    cacheScope,
  })
  const indexing = useAdminResource(api, 'listIndexingJobs', {
    enabled: tab === 'indexing',
    initialData: seeded.indexing,
    query: appliedQuery.indexing ?? {},
    onSessionExpired,
    cacheScope,
  })
  const events = useAdminResource(api, 'listCronLifecycleEvents', {
    enabled: tab === 'events',
    initialData: seeded.events,
    query: appliedQuery.events ?? {},
    onSessionExpired,
    cacheScope,
  })
  const sources = useAdminResource(api, 'listSources', {
    enabled: tab === 'ingestion',
    initialData: seeded.sources,
    onSessionExpired,
    cacheScope,
  })
  const mutation = useAdminMutation({ onSessionExpired, cacheScope })
  const indexingData = indexing.data
  const indexingState = indexing.state
  const reloadIndexing = indexing.reload
  const pollErrorCountRef = useRef(0)
  function actionFor(job, kind, action, trigger) {
    if (trigger) confirmationTriggerRef.current = trigger
    setConfirmation({
      job,
      kind,
      action,
      reasonCode: action === 'retry' ? 'job_retry_requested' : 'job_cancel_requested',
    })
  }
  function previewArticle(articleId, trigger) {
    if (trigger) previewTriggerRef.current = trigger
    setPreviewArticleId(articleId)
  }
  async function confirmJobAction() {
    if (!confirmation) return
    const { job, kind, action, reasonCode } = confirmation
    const operation =
      action === 'retry'
        ? kind === 'ingestion'
          ? 'retryIngestionJob'
          : 'retryIndexingJob'
        : kind === 'ingestion'
          ? 'cancelIngestionJob'
          : 'cancelIndexingJob'
    const response = await mutation.run(
      () =>
        mutateAdmin(api, operation, {
          csrfToken: session?.csrfToken,
          pathParams: { jobId: job.id },
          body: { reasonCode },
          idempotencyStore: mutation.idempotencyStore,
          idempotencyIntent: action === 'retry' ? `${kind}-retry:${job.id}` : undefined,
        }),
      action === 'retry' ? 'Đã xếp tác vụ thử lại.' : 'Đã ghi nhận yêu cầu dừng tác vụ.',
    )
    if (response) {
      setConfirmation(null)
      active.reload()
    }
  }
  function refreshCurrent() {
    return reloadAdminJobResources({ tab, ingestion, indexing, events, sources })
  }

  function runDueWorkNow() {
    return mutation
      .run(
        () => runAdminDueWork(api, { csrfToken: session?.csrfToken }),
        'Đã chạy một lượt hàng đợi giới hạn.',
      )
      .then((response) => {
        if (response) {
          setDueWorkRun(normalizeDueWorkRun(response))
          reloadAfterDueWork({ ingestion, indexing, events })
        }
        return response
      })
  }

  useEffect(() => {
    if (tab !== 'indexing') pollStartedAtRef.current = null
  }, [tab])

  useEffect(() => {
    if (tab !== 'indexing' || indexingState === 'loading') return undefined
    let active = true
    let timer = null
    if (pollStartedAtRef.current === null) pollStartedAtRef.current = Date.now()
    if (indexingState === 'error') pollErrorCountRef.current += 1
    else pollErrorCountRef.current = 0
    const visible = () => globalThis.document?.visibilityState !== 'hidden'
    const online = () => globalThis.navigator?.onLine !== false
    const hasActiveJobs = () =>
      listItems(indexingData).some((job) =>
        shouldPollIndexingJob(job, { visible: visible(), online: online() }),
      )
    const schedule = () => {
      if (!active || !visible() || !online() || !hasActiveJobs()) return
      const delay = nextIndexingPollDelay({
        elapsedMs: Date.now() - pollStartedAtRef.current,
        errorCount: pollErrorCountRef.current,
      })
      timer = globalThis.setTimeout(() => {
        timer = null
        if (!active || !visible() || !online() || indexingState === 'loading') return
        reloadIndexing()
      }, delay)
    }
    const onVisibilityChange = () => {
      if (timer) globalThis.clearTimeout(timer)
      timer = null
      schedule()
    }
    globalThis.document?.addEventListener?.('visibilitychange', onVisibilityChange)
    globalThis.addEventListener?.('online', onVisibilityChange)
    globalThis.addEventListener?.('offline', onVisibilityChange)
    schedule()
    return () => {
      active = false
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', onVisibilityChange)
      globalThis.removeEventListener?.('online', onVisibilityChange)
      globalThis.removeEventListener?.('offline', onVisibilityChange)
    }
  }, [indexingData, indexingState, reloadIndexing, tab])
  function createIngestion(input) {
    return mutation
      .run(
        () =>
          mutateAdmin(api, 'createIngestionJob', {
            csrfToken: session?.csrfToken,
            body: input,
            idempotencyStore: mutation.idempotencyStore,
            idempotencyIntent: `ingestion-create:${input.sourceId}:${input.batchSize}`,
          }),
        'Đã xếp tác vụ thu thập vào hàng đợi bền vững.',
      )
      .then((response) => {
        if (response) ingestion.reload()
        return response
      })
  }
  function createIndexing(articleId, task) {
    const request = artifactJobRequest(task)
    return mutation
      .run(
        () =>
          mutateAdmin(api, request.operation, {
            csrfToken: session?.csrfToken,
            pathParams: { articleId },
            body: request.body,
            idempotencyStore: mutation.idempotencyStore,
            idempotencyIntent: `${task}:${articleId}`,
          }),
        `Đã xếp tác vụ ${task === 'summary' ? 'tóm tắt' : task === 'embedding' ? 'vector' : 'đối chiếu hiển thị'} vào hàng đợi.`,
      )
      .then((response) => {
        if (response) indexing.reload()
        return response
      })
  }
  const active = tab === 'ingestion' ? ingestion : tab === 'indexing' ? indexing : events
  return (
    <div className="admin-view admin-jobs-view">
      <PageHeader
        eyebrow="Tác vụ bền vững"
        title="Tác vụ và hàng đợi"
        action={
          <>
            <AdminButton
              variant="primary"
              icon="play"
              onClick={runDueWorkNow}
              disabled={mutation.busy}
            >
              {mutation.busy ? 'Đang chạy hàng đợi…' : 'Chạy một lượt hàng đợi'}
            </AdminButton>
            <AdminButton icon="refresh" onClick={refreshCurrent} disabled={mutation.busy}>
              Làm mới
            </AdminButton>
          </>
        }
      />
      <DueWorkRunPanel run={dueWorkRun} />
      <div className="admin-tabs" role="tablist" aria-label="Loại tác vụ">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ingestion'}
          className={tab === 'ingestion' ? 'active' : ''}
          onClick={() => setTab('ingestion')}
        >
          Thu thập
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'indexing'}
          className={tab === 'indexing' ? 'active' : ''}
          onClick={() => setTab('indexing')}
        >
          Chỉ mục
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'events'}
          className={tab === 'events' ? 'active' : ''}
          onClick={() => setTab('events')}
        >
          Sự kiện vòng đời
        </button>
      </div>
      <div className="admin-toolbar">
        <label>
          <span>Trạng thái</span>
          <select
            value={draftQuery[tab]?.status ?? ''}
            onChange={(event) =>
              setDraftQuery((current) => ({
                ...current,
                [tab]: { ...current[tab], status: event.target.value },
              }))
            }
          >
            <option value="">Tất cả</option>
            {['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'deferred', 'timeout', 'started'].map((status) => (
              <option key={status} value={status}>
                {statusLabel(status)}
              </option>
            ))}
          </select>
        </label>
        {tab === 'events' ? (
          <>
            <label>
              <span>Hàng đợi</span>
              <select
                value={draftQuery.events?.queueName ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, queueName: event.target.value },
                  }))
                }
              >
                <option value="">Tất cả hàng đợi</option>
                <option value="ingestion">Thu thập dữ liệu</option>
                <option value="indexing">Chỉ mục hóa</option>
                <option value="account-deletion">Xóa tài khoản</option>
              </select>
            </label>
            <label>
              <span>Loại tác vụ</span>
              <select
                value={draftQuery.events?.task ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, task: event.target.value },
                  }))
                }
              >
                <option value="">Tất cả loại tác vụ</option>
                <option value="summary">Tóm tắt</option>
                <option value="embedding">Vector</option>
                <option value="visibility-reconcile">Đối chiếu hiển thị</option>
              </select>
            </label>
            <label>
              <span>Mã lượt chạy</span>
              <input
                type="text"
                placeholder="Lọc theo mã lượt chạy"
                value={draftQuery.events?.runId ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, runId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              <span>Mã tác vụ</span>
              <input
                type="text"
                placeholder="Lọc theo mã tác vụ"
                value={draftQuery.events?.jobId ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, jobId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              <span>Mã bài viết</span>
              <input
                type="text"
                placeholder="Lọc theo mã bài viết"
                value={draftQuery.events?.articleId ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, articleId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              <span>Mã nguồn</span>
              <input
                type="text"
                placeholder="Lọc theo mã nguồn"
                value={draftQuery.events?.sourceId ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, sourceId: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              <span>Từ thời gian</span>
              <input
                type="datetime-local"
                value={draftQuery.events?.from ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, from: event.target.value },
                  }))
                }
              />
            </label>
            <label>
              <span>Đến thời gian</span>
              <input
                type="datetime-local"
                value={draftQuery.events?.to ?? ''}
                onChange={(event) =>
                  setDraftQuery((current) => ({
                    ...current,
                    events: { ...current.events, to: event.target.value },
                  }))
                }
              />
            </label>
          </>
        ) : null}
        <AdminButton
          variant="secondary"
          icon="refresh"
          onClick={() => setAppliedQuery((current) => ({ ...current, [tab]: tab === 'events' ? normalizeLifecycleEventQuery(draftQuery[tab]) : { ...draftQuery[tab] } }))}
        >
          Áp dụng lọc
        </AdminButton>
        <JobsActionBar
          tab={tab}
          ingestion={{
            sources: listItems(sources.data),
            onSubmit: createIngestion,
            busy: mutation.busy,
          }}
          indexing={{ onSubmit: createIndexing, busy: mutation.busy }}
        />
      </div>
      {mutation.error ? (
        <p className="admin-inline-error" role="alert">
          {mutation.error}
        </p>
      ) : null}
      {mutation.notice ? (
        <p className="admin-inline-success" role="status">
          {mutation.notice}
        </p>
      ) : null}
      <Panel
        title={
          tab === 'ingestion'
            ? 'Hàng đợi thu thập'
            : tab === 'indexing'
              ? 'Hàng đợi chỉ mục'
              : 'Sự kiện vòng đời cron và tác vụ'
        }
      >
        {tab === 'events' ? (
          <EventList
            data={events.data}
            state={events.state}
            error={events.error}
            reload={events.reload}
            loadMore={events.loadMore}
            loadingMore={events.loadingMore}
          />
        ) : (
          <JobList
            data={active.data}
            state={active.state}
            error={active.error}
            reload={active.reload}
            loadMore={active.loadMore}
            loadingMore={active.loadingMore}
            kind={tab}
            onRetry={(job, kind, trigger) => actionFor(job, kind, 'retry', trigger)}
            onCancel={(job, kind, trigger) => actionFor(job, kind, 'cancel', trigger)}
            onPreviewArticle={previewArticle}
            busy={mutation.busy}
          />
        )}
      </Panel>
      <AdminConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.action === 'retry' ? 'Tạo tác vụ thử lại liên kết?' : 'Yêu cầu dừng tác vụ?'}
        consequence={
          confirmation?.action === 'retry'
            ? 'Máy chủ sẽ kiểm tra khả năng thử lại và chính sách số lần trước khi tạo tác vụ mới.'
            : 'Máy chủ sẽ kiểm tra vòng đời trước khi hủy hoặc dừng an toàn tác vụ.'
        }
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        returnFocusRef={confirmationTriggerRef}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmJobAction}
      />
      <ArticlePreviewDialog
        open={Boolean(previewArticleId)}
        articleId={previewArticleId}
        api={api}
        returnFocusRef={previewTriggerRef}
        onClose={() => setPreviewArticleId(null)}
      />
    </div>
  )
}
