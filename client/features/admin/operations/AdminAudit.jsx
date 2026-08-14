import {
  AdminListControls,
  FailureNotice,
  LoadingState,
  RecordTable,
} from './admin-shared.jsx'
import { formatDate } from './admin-helpers.js'

export default function AdminAudit({ data, state, failure, onRetry, query, onQueryChange, loadingMore, onLoadMore }) {
  if (state === 'loading') return <LoadingState label="Đang tải audit…" />
  const rows = data?.data ?? []
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">NFR-017 · READ ONLY</span>
          <h1>Audit bất biến</h1>
          <p>Chỉ structured fields allowlist; không có mutation control hoặc raw export.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <FailureNotice failure={failure} onRetry={onRetry} />
      <section className="admin-panel">
        <AdminListControls
          query={query}
          fields={[
            ['actorType', 'Actor type'],
            ['actorId', 'Actor ID'],
            ['targetType', 'Target type'],
            ['targetId', 'Target ID'],
          ]}
          onApply={onQueryChange}
          data={data}
          loadingMore={loadingMore}
          onLoadMore={onLoadMore}
        />
        <RecordTable
          rows={rows}
          label="Danh sách audit"
          columns={[
            ['id', 'Event ID', (value) => <code>{value}</code>],
            ['actorType', 'Actor type'],
            ['actorId', 'Actor ID', (value) => <code>{value}</code>],
            ['action', 'Action', (value) => <code>{value}</code>],
            ['targetType', 'Target type'],
            ['targetId', 'Target ID', (value) => <code>{value}</code>],
            ['changedFields', 'Changed fields', (value) => <code>{value?.join(', ')}</code>],
            ['reasonCode', 'Reason code', (value) => <code>{value}</code>],
            ['result', 'Kết quả'],
            ['createdAt', 'Thời điểm', formatDate],
          ]}
        />
      </section>
    </>
  )
}
