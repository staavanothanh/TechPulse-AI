import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeAdminFailure, projectTakedownDetail } from './admin-utils.js'
import {
  AdminConfirmationDialog,
  AdminListControls,
  FailureNotice,
  LoadingState,
  RecordTable,
} from './admin-shared.jsx'
import { formatDate, statusLabel, TERMINAL_WORKFLOW_STATES, useRetryAfterCooldown } from './admin-helpers.js'

const TAKEDOWN_TRANSITIONS = Object.freeze({
  received: [{ status: 'reviewing', reasonCode: 'takedown_review_started', label: 'Bắt đầu review' }],
  reviewing: [
    { status: 'approved', reasonCode: 'takedown_approved', label: 'Phê duyệt' },
    { status: 'rejected', reasonCode: 'takedown_rejected', label: 'Từ chối' },
  ],
  approved: [
    {
      status: 'completed',
      reasonCode: 'takedown_completed',
      label: 'Hoàn tất takedown',
      requiresCompletionProof: true,
    },
  ],
})

const TAKEDOWN_SCOPE_FLAGS = Object.freeze({
  metadata: 'metadataRemoved',
  'media-metadata': 'mediaMetadataRemoved',
  summary: 'summaryRemoved',
  embedding: 'embeddingRemoved',
})

function isTakedownCompletionEligible(detail) {
  if (!detail || detail.status !== 'approved' || detail.completion?.hidden !== true || detail.completion?.historicalChatCitationsRedacted !== true) return false
  return (detail.requestedScope ?? []).every((scope) => detail.completion?.[TAKEDOWN_SCOPE_FLAGS[scope]] === true)
}

export default function AdminGovernance({ data, state, failure, onRetry, readApi, adminApi, csrfToken, onNotice, query, onQueryChange, loadingMore, onLoadMore }) {
  const rows = data?.data ?? []
  const [selected, setSelected] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [transition, setTransition] = useState(null)
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const detailSelectionRef = useRef(null)
  const detailRequestRef = useRef(0)
  const detailInFlightRef = useRef(false)
  const pendingDetailRef = useRef(null)
  const openDetail = useCallback(
    (item) => {
      detailSelectionRef.current = item.id
      setSelected(item)
      setDetailState('loading')
      if (detailInFlightRef.current) {
        pendingDetailRef.current = item
        return
      }
      const fetchDetail = async (target) => {
        detailInFlightRef.current = true
        const requestId = ++detailRequestRef.current
        try {
          const response = await readApi?.getTakedownRequest?.({
            pathParams: { takedownRequestId: target.id },
          })
          if (requestId !== detailRequestRef.current || detailSelectionRef.current !== target.id) return
          setDetail(projectTakedownDetail(response))
          setDetailState('ready')
        } catch {
          if (requestId === detailRequestRef.current && detailSelectionRef.current === target.id) {
            setDetail(null)
            setDetailState('error')
          }
        } finally {
          detailInFlightRef.current = false
          const pending = pendingDetailRef.current
          if (pending && pending.id === detailSelectionRef.current && pending.id !== target.id) {
            pendingDetailRef.current = null
            void fetchDetail(pending)
          } else pendingDetailRef.current = null
        }
      }
      void fetchDetail(item)
    },
    [readApi],
  )
  useEffect(() => {
    if (!selected || !detail || TERMINAL_WORKFLOW_STATES.has(detail.status)) return undefined
    const canPoll = () => globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false
    let timer
    const schedule = () => {
      if (canPoll() && !detailInFlightRef.current) timer = globalThis.setTimeout(() => openDetail(selected), 5_000)
    }
    const resume = () => {
      if (canPoll() && !detailInFlightRef.current) openDetail(selected)
    }
    schedule()
    globalThis.document?.addEventListener?.('visibilitychange', resume)
    globalThis.window?.addEventListener?.('online', resume)
    return () => {
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', resume)
      globalThis.window?.removeEventListener?.('online', resume)
    }
  }, [detail, openDetail, selected])
  const submitTransition = async () => {
    if (!transition || !adminApi?.updateTakedownRequest || !csrfToken) return
    setBusy(true)
    setMutationError(null)
    try {
      await adminApi.updateTakedownRequest({
        pathParams: { takedownRequestId: transition.item.id },
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        credentials: 'same-origin',
        body: JSON.stringify({ status: transition.status, reasonCode: transition.reasonCode }),
      })
      setTransition(null)
      onNotice?.(`Đã chuyển workflow sang ${statusLabel(transition.status)}.`)
      openDetail(transition.item)
    } catch (error) {
      setRetryAfter(Number.isSafeInteger(error?.retryAfter) ? error.retryAfter : 0)
      setMutationError(normalizeAdminFailure(error).message)
    } finally {
      setBusy(false)
    }
  }
  if (state === 'loading') return <LoadingState label="Đang tải governance…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">GOVERNANCE · HIDE FIRST</span>
          <h1>Takedown workflows</h1>
          <p>Workflow pre-purge có review, quyết định all-or-nothing và tiến độ cleanup server.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls query={query} fields={[['status', 'Trạng thái', ['received', 'reviewing', 'approved', 'rejected', 'completed']]]} onApply={onQueryChange} data={data} loadingMore={loadingMore} onLoadMore={onLoadMore} />
        <RecordTable
          rows={rows}
          label="Danh sách takedown"
          columns={[
            ['id', 'Workflow ID', (value) => <code>{value}</code>],
            ['status', 'Trạng thái', statusLabel],
            ['targetType', 'Loại đích'],
            ['targetIds', 'Target IDs', (value) => <code>{value?.join(', ')}</code>],
            ['requestedScope', 'Scope', (value) => <code>{value?.join(', ')}</code>],
            ['updatedAt', 'Cập nhật', formatDate],
          ]}
        />
        {rows.map((item) => (
          <div className="admin-progress" key={`progress-${item.id}`}>
            <div className="admin-panel-head">
              <h2>Workflow {item.id}</h2>
              <span className="admin-status warning">{statusLabel(item.status)}</span>
            </div>
            <ol className="admin-steps">
              <li className={['reviewing', 'approved', 'completed'].includes(item.status) ? 'done' : ''}>Review</li>
              <li className={['approved', 'completed'].includes(item.status) ? 'done' : 'current'}>Hide trước</li>
              <li className={item.status === 'completed' ? 'done' : ''}>Cleanup + citation redaction</li>
            </ol>
            <p className="admin-muted">
              Completion chỉ hợp lệ khi server xác nhận hidden, <code>historicalChatCitationsRedacted</code> và mọi cờ scope.
            </p>
            <div className="admin-record-actions">
              <button type="button" className="admin-button" onClick={() => openDetail(item)}>
                Mở trạng thái an toàn
              </button>
              {(TAKEDOWN_TRANSITIONS[item.status] ?? []).map((next) => {
                const proofReady = !next.requiresCompletionProof || isTakedownCompletionEligible(detail?.id === item.id ? detail : null)
                return (
                  <button
                    type="button"
                    className={`admin-button${next.status === 'rejected' ? ' admin-button-danger' : ''}`}
                    key={next.status}
                    disabled={!proofReady}
                    aria-describedby={!proofReady && next.requiresCompletionProof ? `takedown-completion-${item.id}-proof` : undefined}
                    onClick={(event) => {
                      setMutationError(null)
                      setTransition({ ...next, item, trigger: event.currentTarget })
                    }}
                  >
                    {next.label}
                  </button>
                )
              })}
            </div>
            {item.status === 'approved' && !isTakedownCompletionEligible(detail?.id === item.id ? detail : null) ? (
              <p className="admin-muted" id={`takedown-completion-${item.id}-proof`}>
                Chờ detail proof: hidden, historical citations redacted và mọi scope flag phải true.
              </p>
            ) : null}
          </div>
        ))}
      </section>
      {selected ? (
        <section className="admin-panel" aria-live="off">
          <h2>Workflow {selected.id} detail</h2>
          {detailState === 'loading' ? (
            <LoadingState label="Đang tải trạng thái workflow…" />
          ) : detailState === 'error' || !detail ? (
            <p className="admin-muted">Chi tiết không còn khả dụng; không hiển thị requester/case.</p>
          ) : (
            <>
              <p className="admin-muted">Trạng thái server: {statusLabel(detail.status)}</p>
              {detail.status === 'completed' ? <p className="admin-muted">Workflow terminal; UI không mở branch sau retention purge.</p> : null}
            </>
          )}
        </section>
      ) : null}
      <AdminConfirmationDialog open={Boolean(transition)} trigger={transition?.trigger} title={`${transition?.label ?? 'Cập nhật'}?`} consequence="Server sẽ kiểm tra quyền, lifecycle và completion fence trước khi commit." reasonCode={transition?.reasonCode} retryAfter={retryAfter} busy={busy} error={mutationError} onCancel={() => setTransition(null)} onConfirm={submitTransition} />
    </>
  )
}
