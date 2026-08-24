import { useState } from 'react'
import { AdminButton } from './AdminShared.jsx'
import { buildPolicyReview } from '../sources/source-form.js'

export function SourcePolicy({ source }) {
  return (
    <dl className="admin-policy-grid">
      <div>
        <dt>Policy</dt>
        <dd>v{source.policyVersion ?? 'n/a'}</dd>
      </div>
      <div>
        <dt>License</dt>
        <dd>{source.licenseStatus ?? 'Chưa ghi nhận'}</dd>
      </div>
      <div>
        <dt>LLM scope</dt>
        <dd>{source.llmInputScope ?? 'none'}</dd>
      </div>
      <div>
        <dt>Technical check</dt>
        <dd>{source.technicalCheck?.status ?? 'Chưa chạy'}</dd>
      </div>
      <div>
        <dt>Reconciliation</dt>
        <dd>{source.reconciliation?.status ?? 'Chưa ghi nhận'}</dd>
      </div>
      <div>
        <dt>Connector</dt>
        <dd>
          {source.connectorType ?? 'Chưa ghi nhận'} · {source.accessMethod ?? 'n/a'}
        </dd>
      </div>
    </dl>
  )
}

export function SourceCreateForm({ onSubmit, busy }) {
  const [form, setForm] = useState({
    name: '',
    sourceKey: '',
    publisherName: '',
    domain: '',
    feedUrl: '',
    batchSize: '20',
  })
  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }))
  return (
    <form
      className="admin-source-create"
      onSubmit={(event) => {
        event.preventDefault()
        void onSubmit({
          name: form.name.trim(),
          sourceKey: form.sourceKey.trim(),
          publisherName: form.publisherName.trim(),
          domain: form.domain.trim().toLowerCase(),
          connectorType: 'rss',
          accessMethod: 'rss',
          authorityTier: 'primary',
          connectorConfig: {
            kind: 'rss',
            feedUrl: form.feedUrl.trim(),
            batchSize: Number(form.batchSize),
          },
          mediaPolicy: {
            imageMode: 'none',
            videoMode: 'none',
            allowedHosts: [],
            attributionRequired: false,
            evidenceNote: null,
          },
        })
      }}
    >
      <div className="admin-form-heading">
        <div>
          <p className="admin-eyebrow">Draft source</p>
          <h3>Thêm nguồn mới</h3>
        </div>
        <span className="admin-chip">fail closed</span>
      </div>
      <p className="admin-form-hint">
        Chỉ nhập metadata connector. Quyền xử lý vẫn cần policy review của admin.
      </p>
      <div className="admin-form-grid">
        <label>
          Tên nguồn
          <input value={form.name} onChange={set('name')} maxLength="120" required />
        </label>
        <label>
          Source key
          <input
            value={form.sourceKey}
            onChange={set('sourceKey')}
            pattern="[a-z0-9][a-z0-9:-]{2,119}"
            maxLength="120"
            required
          />
        </label>
        <label>
          Tên publisher
          <input
            value={form.publisherName}
            onChange={set('publisherName')}
            maxLength="160"
            required
          />
        </label>
        <label>
          Domain
          <input value={form.domain} onChange={set('domain')} maxLength="253" required />
        </label>
        <label>
          Batch size
          <input
            type="number"
            min="1"
            max="100"
            value={form.batchSize}
            onChange={set('batchSize')}
            required
          />
        </label>
        <label className="admin-form-full">
          RSS URL
          <input
            type="url"
            value={form.feedUrl}
            onChange={set('feedUrl')}
            maxLength="2048"
            placeholder="https://example.test/feed.xml"
            required
          />
        </label>
      </div>
      <AdminButton type="submit" variant="primary" icon="arrow" disabled={busy}>
        Tạo draft source
      </AdminButton>
    </form>
  )
}

export function SourcePolicyReviewForm({ source, onSubmit, busy }) {
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
    const blocked = form.licenseStatus === 'blocked'
    void onSubmit(buildPolicyReview({ ...form, blocked }))
  }
  return (
    <form className="admin-source-create admin-policy-review-form" onSubmit={submit}>
      <div className="admin-form-heading">
        <div>
          <p className="admin-eyebrow">Human policy review</p>
          <h3>Quyết định quyền xử lý</h3>
        </div>
        <span className="admin-chip">v{source.policyVersion ?? 'n/a'}</span>
      </div>
      <p className="admin-form-hint">
        Ghi bằng chứng review trước khi lưu. Server vẫn kiểm tra policy và trạng thái nguồn. Sau khi đổi host preview, cần reload/restart runtime để cập nhật CSP; trước khi reload, preview mới sẽ fail closed.
      </p>
      <div className="admin-form-grid">
        <label>
          Quyền sử dụng
          <select value={form.licenseStatus} onChange={set('licenseStatus')}>
            <option value="metadata-only">Chỉ metadata</option>
            <option value="permitted">Được phép</option>
            <option value="blocked">Chặn</option>
          </select>
        </label>
        <label>
          LLM input
          <select
            value={form.llmInputScope}
            onChange={set('llmInputScope')}
            disabled={form.licenseStatus === 'blocked'}
          >
            <option value="none">Không gửi</option>
            <option value="metadata">Metadata</option>
            <option value="excerpt">Excerpt</option>
            <option value="fulltext-temporary">Full text tạm thời</option>
          </select>
        </label>
        <label>
          Attribution
          <input
            value={form.attributionText}
            onChange={set('attributionText')}
            maxLength="500"
            required={form.attributionRequired}
          />
        </label>
        <label>
          Terms URL
          <input type="url" value={form.termsUrl} onChange={set('termsUrl')} maxLength="2048" />
        </label>
        <label>
          License URL
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
            Lưu summary
          </label>
          <label>
            <input
              type="checkbox"
              checked={form.storeEmbedding}
              onChange={set('storeEmbedding')}
              disabled={form.licenseStatus === 'blocked' || form.llmInputScope === 'none'}
            />{' '}
            Lưu embedding
          </label>
        </div>
        <label>
          Chế độ preview ảnh
          <select value={form.imageMode} onChange={set('imageMode')} disabled={form.licenseStatus === 'blocked'}>
            <option value="none">Không hiển thị</option>
            <option value="remote-preview">Remote preview</option>
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
          Attribution media
          <input
            type="checkbox"
            checked={form.mediaAttributionRequired}
            onChange={set('mediaAttributionRequired')}
            disabled={form.licenseStatus === 'blocked'}
          />{' '}
          Bắt buộc attribution media
        </label>
        <label className="admin-form-full">
          Bằng chứng media policy
          <textarea
            value={form.mediaEvidenceNote}
            onChange={set('mediaEvidenceNote')}
            maxLength="4000"
            rows="3"
            disabled={form.licenseStatus === 'blocked'}
          />
        </label>
        <label className="admin-form-full">
          Bằng chứng policy
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
      <AdminButton type="submit" variant="primary" icon="shield" disabled={busy}>
        Lưu quyết định review
      </AdminButton>
    </form>
  )
}
