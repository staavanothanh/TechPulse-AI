import {
  OVERVIEW_METRICS,
  formatAdminDate,
  readResponseData,
  useAdminResource,
} from './admin-data.js'
import {
  AdminButton,
  EmptyState,
  Icon,
  PageHeader,
  Panel,
  ResourceFrame,
  StatusBadge,
} from './AdminShared.jsx'

function formatCount(value) {
  return Number.isFinite(Number(value)) ? new Intl.NumberFormat('vi-VN').format(Number(value)) : '0'
}

export const OVERVIEW_EXCEPTION_ROUTES = Object.freeze({
  failedJobs: 'jobs',
  failedIndexes: 'jobs',
  queuedJobs: 'jobs',
  openTakedowns: 'governance',
  failedAccountDeletions: 'governance',
  sourcesNeedingReview: 'sources',
  activeSources: 'sources',
  pausedSources: 'sources',
  articlesNeedingReview: 'articles',
})

export function overviewExceptionRoute(key) {
  if (typeof key === 'string' && OVERVIEW_EXCEPTION_ROUTES[key]) {
    return OVERVIEW_EXCEPTION_ROUTES[key]
  }
  if (key === 'openTakedowns' || key === 'failedAccountDeletions') return 'governance'
  if (typeof key === 'string' && (key.toLowerCase().includes('job') || key === 'failedIndexes')) {
    return 'jobs'
  }
  if (typeof key === 'string' && key.toLowerCase().includes('source')) return 'sources'
  return 'articles'
}

export function AdminOverviewView({ api, initialData, onNavigate, onSessionExpired, cacheScope }) {
  const resource = useAdminResource(api, 'getAdminOverview', {
    initialData,
    onSessionExpired,
    cacheScope,
  })
  const data = readResponseData(resource.data) ?? {}
  const exceptions = OVERVIEW_METRICS.filter(([key]) => Number(data[key]) > 0)
  return (
    <div className="admin-view admin-overview-view">
      <PageHeader
        eyebrow="Bảng điều hành"
        title="Tổng quan vận hành"
        action={
          <AdminButton icon="refresh" onClick={resource.reload}>
            Làm mới
          </AdminButton>
        }
      />
      <ResourceFrame resource={resource} loadingLabel="Đang tải tổng quan…">
        <section className="admin-metrics" aria-label="Bộ đếm vận hành">
          {OVERVIEW_METRICS.map(([key, label, tone]) => (
            <article className={`admin-metric admin-metric-${tone}`} key={key}>
              <strong>{formatCount(data[key])}</strong>
              <span>{key}</span>
              <small>{label}</small>
            </article>
          ))}
        </section>
        <div className="admin-two-column">
          <Panel title="Cần xử lý">
            <div className="admin-exception-list">
              {exceptions.length ? (
                exceptions.map(([key, label, tone]) => (
                  <button
                    className="admin-exception"
                    key={key}
                    type="button"
                    onClick={() => onNavigate?.(overviewExceptionRoute(key))}
                  >
                    <span>
                      <strong>{label}</strong>
                      <small>{key}</small>
                    </span>
                    <b className={`admin-value-${tone}`}>{formatCount(data[key])}</b>
                    <Icon name="arrow" size={16} />
                  </button>
                ))
              ) : (
                <EmptyState
                  title="Không có ngoại lệ mở."
                  description="Các pipeline đang ở trạng thái theo dõi bình thường."
                />
              )}
            </div>
          </Panel>
          <Panel title="Trạng thái pipeline">
            <div className="admin-pipeline">
              <div>
                <span className="admin-pipeline-index">01</span>
                <span>
                  <strong>Ingestion</strong>
                  <small>{formatCount(data.queuedJobs)} job đang chờ</small>
                </span>
                <StatusBadge
                  value={Number(data.failedJobs) ? 'failed' : Number(data.queuedJobs) ? 'queued' : 'active'}
                  label={Number(data.failedJobs) ? 'Cần xem' : Number(data.queuedJobs) ? 'Đang chờ' : 'Ổn định'}
                />
              </div>
              <div>
                <span className="admin-pipeline-index">02</span>
                <span>
                  <strong>Indexing</strong>
                  <small>{formatCount(data.failedIndexes)} index lỗi</small>
                </span>
                <StatusBadge
                  value={Number(data.failedIndexes) ? 'failed' : 'active'}
                  label={Number(data.failedIndexes) ? 'Cần xem' : 'Ổn định'}
                />
              </div>
              <div>
                <span className="admin-pipeline-index">03</span>
                <span>
                  <strong>Governance</strong>
                  <small>{formatCount(data.openTakedowns)} takedown mở</small>
                </span>
                <StatusBadge
                  value={Number(data.openTakedowns) ? 'reviewing' : 'active'}
                  label={Number(data.openTakedowns) ? 'Đang xử lý' : 'Ổn định'}
                />
              </div>
            </div>
          </Panel>
        </div>
        <Panel
          title="Lần ingestion thành công gần nhất"
          hint="lastSuccessfulIngestionAt"
        >
          <div className="admin-last-run">
            <Icon name="activity" size={24} />
            <div>
              <strong>
                {data.lastSuccessfulIngestionAt
                  ? formatAdminDate(data.lastSuccessfulIngestionAt)
                  : 'Chưa có lần thành công'}
              </strong>
              <p>Thời điểm hoàn tất chu kỳ thu thập dữ liệu gần nhất.</p>
            </div>
          </div>
        </Panel>
      </ResourceFrame>
    </div>
  )
}
