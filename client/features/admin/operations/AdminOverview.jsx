import { FailureNotice, LoadingState } from './admin-shared.jsx'
import { formatDate, OVERVIEW_FIELDS } from './admin-helpers.js'

export default function AdminOverview({ data, state, failure, onRetry }) {
  if (state === 'loading') return <LoadingState label="Đang tải tổng quan…" />
  if (failure) return <FailureNotice failure={failure} onRetry={onRetry} />
  const overview = data ?? {}
  return (
    <>
      <div className="admin-page-head">
        <div>
          <span className="admin-eyebrow">ADMIN-001 · EXCEPTION FIRST</span>
          <h1>Việc cần xử lý</h1>
          <p>Ưu tiên workflow lỗi hoặc bị dừng; bộ đếm khỏe vẫn giữ trong cùng information architecture.</p>
        </div>
        <button type="button" className="admin-button" onClick={onRetry}>
          Làm mới
        </button>
      </div>
      <section className="admin-metrics" aria-label="Bộ đếm vận hành">
        {OVERVIEW_FIELDS.map(([key, label, tone]) => (
          <article className={`admin-metric ${tone}`} key={key}>
            <strong>{overview[key] ?? 0}</strong>
            <span>{key}</span>
            <small>{label}</small>
          </article>
        ))}
      </section>
      <section className="admin-panel">
        <div className="admin-panel-head">
          <div>
            <h2>Ingestion gần nhất</h2>
            <p>
              <code>lastSuccessfulIngestionAt</code> có thể null.
            </p>
          </div>
          <span className={`admin-status ${overview.lastSuccessfulIngestionAt ? 'ok' : 'warning'}`}>{overview.lastSuccessfulIngestionAt ? formatDate(overview.lastSuccessfulIngestionAt) : 'Chưa có lần thành công'}</span>
        </div>
        <p className="admin-muted">Browser chỉ hiển thị trạng thái; không có control chạy maintenance task.</p>
      </section>
    </>
  )
}
