import { useEffect, useRef, useState } from 'react'
import {
  artifactJobRequest,
  isAdminJobRetryable,
  listItems,
  mutateAdmin,
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
  PageHeader,
  Panel,
  ResourceFrame,
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

function JobList({
  data,
  state,
  error,
  reload,
  loadMore,
  loadingMore,
  kind,
  onRetry,
  onCancel,
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
                    <>
                      <strong className="admin-mono">{value}</strong>
                      <small>
                        {row.connectorType ?? 'connector'} · {row.trigger ?? 'unknown'}
                      </small>
                    </>
                  ),
                },
                {
                  key: 'status',
                  label: 'Trạng thái',
                  render: (value) => <StatusBadge value={value} />,
                },
                {
                  key: 'sourceId',
                  label: 'Source',
                  render: (value, row) => (
                    <>
                      <strong className="admin-mono">{value}</strong>
                      <small>
                        attempt {row.attempt ?? 'n/a'} · batch {row.batchSize ?? 'n/a'}
                      </small>
                    </>
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
                    <>
                      <strong className="admin-mono">{value}</strong>
                      <small>
                        {row.task ?? 'task'} · {row.trigger ?? 'unknown'}
                      </small>
                    </>
                  ),
                },
                {
                  key: 'status',
                  label: 'Trạng thái',
                  render: (value) => <StatusBadge value={value} />,
                },
                {
                  key: 'articleId',
                  label: 'Article',
                  render: (value, row) => (
                    <>
                      <strong className="admin-mono">{value}</strong>
                      <small>
                        source {row.sourceId ?? 'n/a'} · attempt {row.attempt ?? 'n/a'}
                      </small>
                    </>
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

export function AdminJobsView({ api, session, initialData, onSessionExpired, cacheScope }) {
  const [tab, setTab] = useState('ingestion')
  const [draftQuery, setDraftQuery] = useState({})
  const [appliedQuery, setAppliedQuery] = useState({})
  const seeded = initialData ?? {}
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
  const pollStartedAtRef = useRef(null)
  const [confirmation, setConfirmation] = useState(null)
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
        description="Xem, retry và cancel mọi bounded job qua một operational view duy nhất."
        action={
          <AdminButton icon="refresh" onClick={refreshCurrent} disabled={mutation.busy}>
            Làm mới
          </AdminButton>
        }
      />
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
        hint={
          tab === 'ingestion'
            ? 'Nguồn và trạng thái lease an toàn'
            : 'Summary, embedding và visibility reconciliation'
        }
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
          busy={mutation.busy}
        />
        {tab === 'ingestion' ? (
          <IngestionCreateForm
            sources={listItems(sources.data)}
            onSubmit={createIngestion}
            busy={mutation.busy}
          />
        ) : (
          <IndexingCreateForm onSubmit={createIndexing} busy={mutation.busy} />
        )}
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
    </div>
  )
}
