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

export function AdminOverviewView({ api, initialData, onNavigate, onSessionExpired }) {
  const resource = useAdminResource(api, 'getAdminOverview', { initialData, onSessionExpired })
  const data = readResponseData(resource.data) ?? {}
  const exceptions = OVERVIEW_METRICS.filter(([key]) => Number(data[key]) > 0)
  return (
    <div className="admin-view admin-overview-view">
      <PageHeader
        eyebrow="Bảng điều hành"
        title="Tổng quan vận hành"
        description="Ngoại lệ cần xử lý và trạng thái pipeline ingestion, indexing, takedown và xóa tài khoản."
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
          <Panel title="Cần xử lý" hint="Ưu tiên theo số liệu overview API">
            <div className="admin-exception-list">
              {exceptions.length ? (
                exceptions.map(([key, label, tone]) => (
                  <button
                    className="admin-exception"
                    key={key}
                    type="button"
                    onClick={() =>
                      onNavigate?.(
                        key === 'openTakedowns' || key === 'failedAccountDeletions'
                          ? 'governance'
                          : key.includes('Job') || key === 'failedIndexes'
                            ? 'jobs'
                            : key.includes('Source')
                              ? 'sources'
                              : 'articles',
                      )
                    }
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
          <Panel title="Trạng thái pipeline" hint="Server-owned queue state">
            <div className="admin-pipeline">
              <div>
                <span className="admin-pipeline-index">01</span>
                <span>
                  <strong>Ingestion</strong>
                  <small>{formatCount(data.queuedJobs)} job đang chờ</small>
                </span>
                <StatusBadge
                  value={Number(data.failedJobs) ? 'failed' : 'active'}
                  label={Number(data.failedJobs) ? 'Cần xem' : 'Ổn định'}
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
            <p className="admin-note">
              Cron và coordinator thuộc server. UI chỉ hiển thị trạng thái và gọi các operation
              admin đã được contract cho phép.
            </p>
          </Panel>
        </div>
        <Panel
          title="Lần ingestion thành công gần nhất"
          hint="lastSuccessfulIngestionAt có thể null"
        >
          <div className="admin-last-run">
            <Icon name="activity" size={24} />
            <div>
              <strong>
                {data.lastSuccessfulIngestionAt
                  ? formatAdminDate(data.lastSuccessfulIngestionAt)
                  : 'Chưa có lần thành công'}
              </strong>
              <p>Thời điểm được server ghi nhận. Không hiển thị lease hoặc credential nội bộ.</p>
            </div>
          </div>
        </Panel>
      </ResourceFrame>
    </div>
  )
}
