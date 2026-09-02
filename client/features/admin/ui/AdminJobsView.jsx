import { useEffect, useRef, useState } from 'react'
import {
  aggregateDueWorkCounters,
  artifactJobRequest,
  formatAdminDate,
  isAdminJobRetryable,
  listItems,
  mutateAdmin,
  normalizeDueWorkRun,
  runAdminDueWork,
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
          onClick={() => onRetry(job, kind)}
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
          onClick={() => onCancel(job, kind)}
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
      loadingLabel={`Đang tải ${kind === 'ingestion' ? 'ingestion' : 'indexing'} jobs…`}
    >
      <Table
        label={`${kind} jobs`}
        rows={rows}
        emptyTitle="Chưa có job phù hợp."
        columns={
          kind === 'ingestion'
            ? [
                {
                  key: 'id',
                  label: 'Job',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <strong className="admin-cell-primary">
                        {(row.connectorType ?? 'connector').toUpperCase()} · {row.trigger ?? 'unknown'}
                      </strong>
                      <small className="admin-cell-sub">
                        <span>Job: </span>
                        <CompactId id={value} label="Job ID" length={8} />
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
                  label: 'Nguồn crawl',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <SourceBadge sourceId={value} />
                      <small className="admin-cell-sub">
                        <span>Source: </span>
                        <CompactId id={value} label="Source ID" length={8} />
                        <span> · attempt {row.attempt ?? 1} · batch {row.batchSize ?? 20}</span>
                      </small>
                    </div>
                  ),
                },
                {
                  key: 'counters',
                  label: 'Counters',
                  render: (value) =>
                    value ? (
                      <span className="admin-counter-copy">
                        {value.fetched ?? 0} fetched · {value.created ?? 0} created ·{' '}
                        {value.failed ?? 0} failed
                      </span>
                    ) : (
                      'Chưa ghi nhận'
                    ),
                },
              ]
            : [
                {
                  key: 'id',
                  label: 'Job',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <strong className="admin-cell-primary">
                        {row.task === 'summary'
                          ? 'Tóm tắt AI (Summary)'
                          : row.task === 'embedding'
                            ? 'Embedding Vector'
                            : (row.task ?? 'task')} · {row.trigger ?? 'unknown'}
                      </strong>
                      <small className="admin-cell-sub">
                        <span>Job: </span>
                        <CompactId id={value} label="Job ID" length={8} />
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
                  label: 'Article',
                  render: (value, row) => (
                    <div className="admin-cell-resource">
                      <div className="admin-cell-title-row">
                        <SourceBadge sourceId={row.sourceId} />
                        <button
                          type="button"
                          className="admin-btn-preview"
                          onClick={() => onPreviewArticle?.(value)}
                          title={`Xem nhanh bài viết ${value}`}
                          aria-label={`Xem nhanh bài viết ${value}`}
                        >
                          <Icon name="eye" size={13} />
                          <span>Xem</span>
                        </button>
                      </div>
                      <small className="admin-cell-sub">
                        <span>Article: </span>
                        <CompactId id={value} label="Article ID" length={8} />
                        <span> · attempt {row.attempt ?? 'n/a'}</span>
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

const DUE_WORK_COUNTERS = Object.freeze([
  ['claimed', 'Claimed'],
  ['succeeded', 'Succeeded'],
  ['partial', 'Partial'],
  ['failed', 'Failed'],
  ['deferred', 'Deferred'],
])

const DUE_WORK_QUEUES = Object.freeze([
  ['ingestion', 'Ingestion'],
  ['indexing', 'Indexing'],
  ['accountDeletion', 'Account deletion'],
])

function DueWorkRunPanel({ run }) {
  const normalized = run ?? normalizeDueWorkRun({})
  const aggregate = aggregateDueWorkCounters(normalized)
  return (
    <Panel
      className="admin-due-work-panel"
      title="Kết quả bounded run gần nhất"
    >
      <div className="admin-due-work-meta" role="status">
        {normalized.runId
          ? `Run ${normalized.runId}`
          : 'Chưa có lần chạy thủ công nào trong phiên này.'}
      </div>
      <div className="admin-due-work-summary" aria-label="Aggregate bounded run counters">
        {DUE_WORK_COUNTERS.map(([key, label]) => (
          <div className="admin-due-work-counter" key={key}>
            <strong>{aggregate[key]}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      <div className="admin-due-work-queues" aria-label="Kết quả theo queue">
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
        <label htmlFor="admin-job-source">Nguồn ingestion</label>
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
        <label htmlFor="admin-job-batch">Batch size</label>
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
        Trigger ingestion
      </AdminButton>
      {eligible.length === 0 ? (
        <small className="admin-form-hint">Chưa có source active đủ điều kiện.</small>
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
        <label htmlFor="admin-index-article">Article ID</label>
        <input
          id="admin-index-article"
          value={articleId}
          maxLength="128"
          onChange={(event) => setArticleId(event.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="admin-index-task">Task</label>
        <select
          id="admin-index-task"
          value={task}
          onChange={(event) => setTask(event.target.value)}
        >
          <option value="summary">summary</option>
          <option value="embedding">embedding</option>
          <option value="visibility-reconcile">visibility-reconcile</option>
        </select>
      </div>
      <AdminButton type="submit" variant="primary" icon="arrow" disabled={busy}>
        Xếp indexing job
      </AdminButton>
    </form>
  )
}

export function JobsActionBar({ ingestion, indexing, tab }) {
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

export function AdminJobsView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const seeded = initialData ?? {}
  const [tab, setTab] = useState('ingestion')
  const [draftQuery, setDraftQuery] = useState({
    ingestion: { status: '' },
    indexing: { status: '' },
  })
  const [appliedQuery, setAppliedQuery] = useState({})
  const [dueWorkRun, setDueWorkRun] = useState(
    seeded.dueWorkRun ? normalizeDueWorkRun(seeded.dueWorkRun) : null,
  )
  const [confirmation, setConfirmation] = useState(null)
  const [previewArticleId, setPreviewArticleId] = useState(null)
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
  function actionFor(job, kind, action) {
    setConfirmation({
      job,
      kind,
      action,
      reasonCode: action === 'retry' ? 'job_retry_requested' : 'job_cancel_requested',
    })
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
      action === 'retry' ? 'Đã xếp job thử lại.' : 'Đã ghi nhận yêu cầu dừng job.',
    )
    if (response) {
      setConfirmation(null)
      active.reload()
    }
  }
  function refreshCurrent() {
    ;(tab === 'ingestion' ? ingestion : indexing).reload()
  }

  function runDueWorkNow() {
    return mutation
      .run(
        () => runAdminDueWork(api, { csrfToken: session?.csrfToken }),
        'Đã chạy một lượt bounded queue.',
      )
      .then((response) => {
        if (response) {
          setDueWorkRun(normalizeDueWorkRun(response))
          ingestion.reload()
          indexing.reload()
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
        'Đã xếp ingestion job vào durable queue.',
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
        `Đã xếp job ${task} vào hàng đợi.`,
      )
      .then((response) => {
        if (response) indexing.reload()
        return response
      })
  }
  const active = tab === 'ingestion' ? ingestion : indexing
  return (
    <div className="admin-view admin-jobs-view">
      <PageHeader
        eyebrow="Durable jobs"
        title="Jobs và queue"
        action={
          <>
            <AdminButton
              variant="primary"
              icon="play"
              onClick={runDueWorkNow}
              disabled={mutation.busy}
            >
              {mutation.busy ? 'Đang chạy queue…' : 'Chạy queue bounded'}
            </AdminButton>
            <AdminButton icon="refresh" onClick={refreshCurrent} disabled={mutation.busy}>
              Làm mới
            </AdminButton>
          </>
        }
      />
      <DueWorkRunPanel run={dueWorkRun} />
      <div className="admin-tabs" role="tablist" aria-label="Loại job">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ingestion'}
          className={tab === 'ingestion' ? 'active' : ''}
          onClick={() => setTab('ingestion')}
        >
          Ingestion
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'indexing'}
          className={tab === 'indexing' ? 'active' : ''}
          onClick={() => setTab('indexing')}
        >
          Indexing
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
            {['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'].map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <AdminButton
          variant="secondary"
          icon="refresh"
          onClick={() => setAppliedQuery((current) => ({ ...current, [tab]: { ...draftQuery[tab] } }))}
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
        title={tab === 'ingestion' ? 'Ingestion queue' : 'Indexing queue'}
      >
        <JobList
          data={active.data}
          state={active.state}
          error={active.error}
          reload={active.reload}
          loadMore={active.loadMore}
          loadingMore={active.loadingMore}
          kind={tab}
          onRetry={(job, kind) => actionFor(job, kind, 'retry')}
          onCancel={(job, kind) => actionFor(job, kind, 'cancel')}
          onPreviewArticle={setPreviewArticleId}
          busy={mutation.busy}
        />
      </Panel>
      <AdminConfirmDialog
        open={Boolean(confirmation)}
        title={confirmation?.action === 'retry' ? 'Tạo linked retry cho job?' : 'Yêu cầu dừng job?'}
        consequence={
          confirmation?.action === 'retry'
            ? 'Server sẽ kiểm tra retryable và attempt policy trước khi tạo job mới.'
            : 'Server sẽ kiểm tra lifecycle trước khi hủy hoặc dừng an toàn job.'
        }
        reasonCode={confirmation?.reasonCode}
        busy={mutation.busy}
        onCancel={() => setConfirmation(null)}
        onConfirm={confirmJobAction}
      />
      <ArticlePreviewDialog
        open={Boolean(previewArticleId)}
        articleId={previewArticleId}
        api={api}
        onClose={() => setPreviewArticleId(null)}
      />
    </div>
  )
}
