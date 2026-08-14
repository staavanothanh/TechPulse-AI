import { useCallback, useEffect, useRef, useState } from 'react'
import { normalizeAdminFailure } from './admin-utils.js'
import {
  AdminConfirmationDialog,
  AdminListControls,
  FailureNotice,
  LoadingState,
  RecordTable,
} from './admin-shared.jsx'
import { DELETION_FLAGS, formatDate, idempotencyKey, statusLabel, TERMINAL_WORKFLOW_STATES, useRetryAfterCooldown } from './admin-helpers.js'

export default function AdminDeletions({ data, state, failure, onRetry, adminApi, csrfToken, query, onQueryChange, loadingMore, onLoadMore }) {
  const rows = data?.data ?? []
  const [busyId, setBusyId] = useState(null)
  const intentKeys = useRef(new Map())
  const [confirmation, setConfirmation] = useState(null)
  const [confirmationError, setConfirmationError] = useState(null)
  const [selectedItem, setSelectedItem] = useState(null)
  const [detailState, setDetailState] = useState('idle')
  const [detail, setDetail] = useState(null)
  const detailSelectionRef = useRef(null)
  const detailRequestRef = useRef(0)
  const detailInFlightRef = useRef(false)
  const pendingDetailRef = useRef(null)
  const [retryAfter, setRetryAfter] = useRetryAfterCooldown()
  const retry = async () => {
    const item = confirmation?.item
    if (!adminApi?.retryAccountDeletionRequest || !csrfToken) return
    const intent = `deletion-retry-${item.id}`
    const key = intentKeys.current.get(intent) ?? idempotencyKey(intent)
    intentKeys.current.set(intent, key)
    setBusyId(item.id)
    try {
      await adminApi.retryAccountDeletionRequest({
        pathParams: { deletionRequestId: item.id },
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': key,
        },
        credentials: 'same-origin',
        body: JSON.stringify({ reasonCode: 'account_deletion_retry_requested' }),
      })
      intentKeys.current.delete(intent)
      setConfirmation(null)
      setConfirmationError(null)
      onRetry()
    } catch (error) {
      setRetryAfter(Number.isSafeInteger(error?.retryAfter) ? error.retryAfter : 0)
      setConfirmationError(normalizeAdminFailure(error).message)
    } finally {
      setBusyId(null)
    }
  }
  const openDetail = useCallback(
    (item) => {
      detailSelectionRef.current = item.id
      setSelectedItem(item)
      setDetailState('loading')
      if (detailInFlightRef.current) {
        pendingDetailRef.current = item
        return
      }
      const fetchDetail = async (target) => {
        detailInFlightRef.current = true
        const requestId = ++detailRequestRef.current
        try {
          const response = await adminApi?.getAccountDeletionRequest?.({
            pathParams: { deletionRequestId: target.id },
          })
          const payload = response?.data ?? response
          if (requestId !== detailRequestRef.current || detailSelectionRef.current !== target.id) return
          setSelectedItem(payload)
          setDetail(payload)
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
    [adminApi],
  )
  useEffect(() => {
    if (!selectedItem || !detail || TERMINAL_WORKFLOW_STATES.has(detail.status)) return undefined
    const canPoll = () => globalThis.document?.visibilityState !== 'hidden' && globalThis.navigator?.onLine !== false
    let timer
    const schedule = () => {
      if (canPoll() && !detailInFlightRef.current) timer = globalThis.setTimeout(() => openDetail(selectedItem), 5_000)
    }
    const resume = () => {
      if (canPoll() && !detailInFlightRef.current) openDetail(selectedItem)
    }
    schedule()
    globalThis.document?.addEventListener?.('visibilitychange', resume)
    globalThis.window?.addEventListener?.('online', resume)
    return () => {
      if (timer) globalThis.clearTimeout(timer)
      globalThis.document?.removeEventListener?.('visibilitychange', resume)
      globalThis.window?.removeEventListener?.('online', resume)
    }
  }, [detail, openDetail, selectedItem])
  if (state === 'loading') return <LoadingState label="Đang tải workflow xóa tài khoản…" />
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">AUTH-006 · AUTOMATIC CLEANUP</span>
          <h1>Xóa tài khoản</h1>
          <p>Admin không phê duyệt deletion; chỉ theo dõi tiến độ và retry request failed.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls query={query} fields={[['status', 'Trạng thái', ['queued', 'running', 'failed', 'completed']]]} onApply={onQueryChange} data={data} loadingMore={loadingMore} onLoadMore={onLoadMore} />
        <RecordTable
          rows={rows}
          label="Danh sách workflow xóa tài khoản"
          columns={[
            ['id', 'Workflow ID', (value) => <code>{value}</code>],
            ['status', 'Trạng thái', statusLabel],
            ['priority', 'Priority'],
            ['attempt', 'Attempt'],
            ['requestedAt', 'Yêu cầu lúc', formatDate],
            ['completedAt', 'Hoàn tất lúc', formatDate],
            ['error', 'SafeError', (value) => value?.message ?? '—'],
          ]}
        />
        {rows.map((item) => (
          <div className="admin-progress" key={`deletion-${item.id}`}>
            <div className="admin-panel-head">
              <h2>Workflow {item.id}</h2>
              <span className="admin-status">{statusLabel(item.status)}</span>
            </div>
            <div className="admin-flags">
              {DELETION_FLAGS.map((flag) => (
                <span key={flag} className={item.completion?.[flag] ? 'true' : 'false'}>
                  {flag}: {item.completion?.[flag] ? 'đã xong' : 'chưa xong'}
                </span>
              ))}
            </div>
            <div className="admin-record-actions">
              <button
                type="button"
                className="admin-button"
                onClick={() => {
                  void openDetail(item)
                }}
              >
                Mở trạng thái workflow
              </button>
              {item.status === 'failed' ? (
                <button
                  type="button"
                  className="admin-button"
                  onClick={(event) => {
                    setConfirmationError(null)
                    setConfirmation({ item, trigger: event.currentTarget })
                  }}
                  disabled={busyId === item.id}
                >
                  {busyId === item.id ? 'Đang retry…' : 'Thử lại xóa dữ liệu'}
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>
      {selectedItem ? (
        <section className="admin-panel">
          <h2>Deletion detail</h2>
          {detailState === 'loading' ? <LoadingState label="Đang tải deletion detail…" /> : detailState === 'error' ? <p className="admin-muted">Chi tiết không còn khả dụng.</p> : <p className="admin-muted">Trạng thái server: {statusLabel(selectedItem.status)}</p>}
        </section>
      ) : null}
      <AdminConfirmationDialog
        open={Boolean(confirmation)}
        trigger={confirmation?.trigger}
        title="Retry workflow xóa dữ liệu?"
        consequence="Server sẽ tiếp tục các completion flag còn thiếu; các flag đã hoàn tất được giữ nguyên."
        reasonCode="account_deletion_retry_requested"
        retryAfter={retryAfter}
        busy={Boolean(busyId)}
        error={confirmationError}
        onCancel={() => {
          setConfirmation(null)
          setConfirmationError(null)
        }}
        onConfirm={retry}
      />
    </>
  )
}
