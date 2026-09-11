import { useState } from 'react'
import { AdminButton } from './AdminShared.jsx'
import { llmScopeLabel, statusLabel } from './admin-data.js'
import { buildPolicyReview } from '../sources/source-form.js'

export function SourcePolicy({ source }) {
  return (
    <dl className="admin-policy-grid">
      <div>
        <dt>Chính sách</dt>
        <dd>v{source.policyVersion ?? 'n/a'}</dd>
      </div>
      <div>
        <dt>Giấy phép</dt>
        <dd>{statusLabel(source.licenseStatus ?? 'Chưa ghi nhận')}</dd>
      </div>
      <div>
        <dt>Phạm vi LLM</dt>
        <dd>{llmScopeLabel(source.llmInputScope ?? 'none')}</dd>
      </div>
      <div>
        <dt>Kiểm tra kỹ thuật</dt>
        <dd>{statusLabel(source.technicalCheck?.status ?? 'Chưa chạy')}</dd>
      </div>
      <div>
        <dt>Đối chiếu</dt>
        <dd>{statusLabel(source.reconciliation?.status ?? 'Chưa ghi nhận')}</dd>
      </div>
      <div>
        <dt>Kết nối</dt>
        <dd>
          {source.connectorType ?? 'Chưa ghi nhận'} · {source.accessMethod ?? 'n/a'}
        </dd>
      </div>
    </dl>
  )
}

export function SourcePolicyReviewForm({ source, onSubmit, busy }) {
  const reviewBlockedByLifecycle = source.operationalStatus === 'active'
  const mediaPolicy = {
    imageMode: source.mediaPolicy?.imageMode ?? 'none',
    videoMode: source.mediaPolicy?.videoMode ?? 'none',
    allowedHosts: Array.isArray(source.mediaPolicy?.allowedHosts)
      ? source.mediaPolicy.allowedHosts
      : [],
    attributionRequired: source.mediaPolicy?.attributionRequired ?? false,
    evidenceNote: source.mediaPolicy?.evidenceNote ?? null,
  }
  const [form, setForm] = useState({
    licenseStatus: ['permitted', 'metadata-only', 'blocked'].includes(source.licenseStatus)
      ? source.licenseStatus
      : 'metadata-only',
    llmInputScope: source.llmInputScope ?? 'metadata',
    attributionRequired: source.attributionRequired ?? true,
    attributionText: source.attributionText ?? '',
    termsUrl: source.termsUrl ?? '',
    licenseUrl: source.licenseUrl ?? '',
    evidenceNote: source.evidenceNote ?? '',
    storeSummary: Boolean(source.storageScope?.summary),
    storeEmbedding: Boolean(source.storageScope?.embedding),
    storeMetadata: Boolean(source.storageScope?.metadata ?? true),
    storeExcerpt: false,
    imageMode: mediaPolicy.imageMode,
    videoMode: mediaPolicy.videoMode,
    allowedHosts: mediaPolicy.allowedHosts.join(', '),
    mediaAttributionRequired: Boolean(mediaPolicy.attributionRequired),
    mediaEvidenceNote: mediaPolicy.evidenceNote ?? '',
  })
  const set = (key) => (event) =>
    setForm((current) => ({
      ...current,
      [key]: event.target.type === 'checkbox' ? event.target.checked : event.target.value,
    }))
  function submit(event) {
    event.preventDefault()
    if (reviewBlockedByLifecycle) return
    const blocked = form.licenseStatus === 'blocked'
    void onSubmit(buildPolicyReview({ ...form, blocked }))
  }
  return (
    <form className="admin-source-create admin-policy-review-form" onSubmit={submit}>
      <div className="admin-form-heading">
        <div>
          <p className="admin-eyebrow">Đánh giá chính sách bởi con người</p>
          <h3>Quyết định quyền xử lý</h3>
        </div>
        <span className="admin-chip">v{source.policyVersion ?? 'n/a'}</span>
      </div>
      <p className="admin-form-hint">
        Ghi bằng chứng đánh giá trước khi lưu. Máy chủ vẫn kiểm tra chính sách và trạng thái nguồn. Sau khi đổi host xem trước, cần nạp lại/khởi động lại runtime để cập nhật CSP; trước khi nạp lại, bản xem trước mới sẽ bị khóa an toàn.
      </p>
      {reviewBlockedByLifecycle ? (
        <p className="admin-form-hint" role="note">
          Nguồn đang hoạt động nên chưa thể gửi đánh giá chính sách trực tiếp. Hãy bấm “Yêu cầu duyệt lại” ở phần vòng đời, chờ nạp lại nguồn về trạng thái tạm dừng rồi gửi quyết định mới.
        </p>
      ) : null}
      <div className="admin-form-grid">
        <label>
          Quyền sử dụng
          <select value={form.licenseStatus} onChange={set('licenseStatus')}>
            <option value="metadata-only">Chỉ siêu dữ liệu</option>
            <option value="permitted">Được phép</option>
            <option value="blocked">Chặn</option>
          </select>
        </label>
        <label>
          Đầu vào LLM
          <select
            value={form.llmInputScope}
            onChange={set('llmInputScope')}
            disabled={form.licenseStatus === 'blocked'}
          >
            <option value="none">Không gửi</option>
            <option value="metadata">Siêu dữ liệu</option>
            <option value="excerpt">Trích đoạn</option>
            <option value="fulltext-temporary">Toàn văn tạm thời</option>
          </select>
        </label>
        <label>
          Ghi công nguồn
          <input
            value={form.attributionText}
            onChange={set('attributionText')}
            maxLength="500"
            required={form.attributionRequired}
          />
        </label>
        <label>
          URL điều khoản
          <input type="url" value={form.termsUrl} onChange={set('termsUrl')} maxLength="2048" />
        </label>
        <label>
          URL giấy phép
          <input type="url" value={form.licenseUrl} onChange={set('licenseUrl')} maxLength="2048" />
        </label>
        <div className="admin-policy-options">
          <label>
            <input
              type="checkbox"
              checked={form.attributionRequired}
              onChange={set('attributionRequired')}
            />{' '}
            Bắt buộc ghi nguồn
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.storeSummary}
              onChange={set('storeSummary')}
              disabled={form.licenseStatus === 'blocked' || form.llmInputScope === 'none'}
            />{' '}
            Lưu tóm tắt
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.storeEmbedding}
              onChange={set('storeEmbedding')}
              disabled={form.licenseStatus === 'blocked' || form.llmInputScope === 'none'}
            />{' '}
            Lưu vector
          </label>
        </div>
        <label>
          Chế độ xem trước ảnh
          <select value={form.imageMode} onChange={set('imageMode')} disabled={form.licenseStatus === 'blocked'}>
            <option value="none">Không hiển thị</option>
            <option value="remote-preview">Xem trước từ xa</option>
          </select>
        </label>
        <label>
          Chế độ video
          <select value={form.videoMode} onChange={set('videoMode')} disabled={form.licenseStatus === 'blocked'}>
            <option value="none">Không hiển thị</option>
            <option value="link-only">Chỉ link nguồn</option>
          </select>
        </label>
        <label className="admin-form-full">
          Host media được duyệt
          <input
            value={form.allowedHosts}
            onChange={set('allowedHosts')}
            maxLength="5200"
            placeholder="cdn.example.com, media.example.com"
            disabled={form.licenseStatus === 'blocked'}
          />
          <small className="admin-form-hint">Nhập hostname HTTPS chính xác, phân tách bằng dấu phẩy. Không dùng wildcard.</small>
        </label>
        <label>
          Ghi công media
          <input
            type="checkbox"
            checked={form.mediaAttributionRequired}
            onChange={set('mediaAttributionRequired')}
            disabled={form.licenseStatus === 'blocked'}
          />{' '}
          Bắt buộc ghi công media
        </label>
        <label className="admin-form-full">
          Bằng chứng chính sách media
          <textarea
            value={form.mediaEvidenceNote}
            onChange={set('mediaEvidenceNote')}
            maxLength="4000"
            rows="3"
            disabled={form.licenseStatus === 'blocked'}
          />
        </label>
        <label className="admin-form-full">
          Bằng chứng chính sách
          <textarea
            value={form.evidenceNote}
            onChange={set('evidenceNote')}
            minLength="3"
            maxLength="4000"
            rows="4"
            required
          />
        </label>
      </div>
      <AdminButton
        type="submit"
        variant="primary"
        icon="shield"
        disabled={busy || reviewBlockedByLifecycle}
      >
        Lưu quyết định đánh giá
      </AdminButton>
    </form>
  )
}
