import { useState } from 'react'
import { AdminButton } from '../ui/AdminShared.jsx'
import { submitSourceCreate } from './source-create.js'

const INITIAL_CREATE = Object.freeze({
  connectorType: 'rss',
  accessMethod: 'rss',
  name: '',
  sourceKey: '',
  publisherName: '',
  domain: '',
  endpoint: '',
  batchSize: '20',
})

const SOURCE_PANEL_ID = 'admin-source-create-panel'

export function SourceCreateForm({ onSubmit, busy = false, error = null, onClose }) {
  const [form, setForm] = useState(INITIAL_CREATE)
  const [submitError, setSubmitError] = useState(null)
  const visibleError = error ?? submitError

  function set(field) {
    return (event) => {
      setSubmitError(null)
      setForm((current) => ({
        ...current,
        [field]: event.target.value,
      }))
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    setSubmitError(null)
    await submitSourceCreate({
      form,
      onSubmit,
      onClose,
      onError: setSubmitError,
    })
  }

  const endpointLabel =
    form.connectorType === 'rss'
      ? 'URL RSS/Atom'
      : form.connectorType === 'arxiv'
        ? 'Truy vấn arXiv'
        : 'Luồng Hacker News'

  function setConnector(event) {
    const connectorType = event.target.value
    setSubmitError(null)
    setForm((current) => ({
      ...current,
      connectorType,
      accessMethod: connectorType === 'rss' ? current.accessMethod : 'api',
      endpoint: connectorType === 'hacker-news' ? 'topstories' : '',
    }))
  }

  return (
    <form
      className="admin-source-create admin-add-source-form"
      onSubmit={handleSubmit}
      aria-describedby={visibleError ? 'source-form-error' : undefined}
    >
      <div className="admin-form-heading">
        <div>
          <p className="admin-eyebrow">Draft source</p>
          <h3 id="source-create-title">Tạo nguồn draft</h3>
        </div>
        <span className="admin-chip">fail closed</span>
      </div>
      <p className="admin-form-hint">
        Chỉ nhập metadata connector. Quyền xử lý vẫn cần policy review của admin.
      </p>
      <div className="admin-form-grid">
        <label htmlFor="source-name">
          Tên nguồn
          <input id="source-name" required value={form.name} onChange={set('name')} />
        </label>
        <label htmlFor="source-key">
          Source key
          <input
            id="source-key"
            required
            pattern="[a-z0-9][a-z0-9:-]{2,119}"
            value={form.sourceKey}
            onChange={set('sourceKey')}
          />
        </label>
        <label htmlFor="source-publisher">
          Publisher
          <input
            id="source-publisher"
            required
            value={form.publisherName}
            onChange={set('publisherName')}
          />
        </label>
        <label htmlFor="source-domain">
          Hostname công khai
          <input id="source-domain" required value={form.domain} onChange={set('domain')} />
        </label>
        <label htmlFor="source-connector">
          Connector
          <select id="source-connector" value={form.connectorType} onChange={setConnector}>
            <option value="rss">RSS / Atom</option>
            <option value="arxiv">arXiv API</option>
            <option value="hacker-news">Hacker News API</option>
          </select>
        </label>
        {form.connectorType === 'rss' ? (
          <label htmlFor="source-access">
            Định dạng feed
            <select id="source-access" value={form.accessMethod} onChange={set('accessMethod')}>
              <option value="rss">RSS</option>
              <option value="atom">Atom</option>
            </select>
          </label>
        ) : null}
        <label htmlFor="source-endpoint">
          {endpointLabel}
          {form.connectorType === 'hacker-news' ? (
            <select
              id="source-endpoint"
              value={form.endpoint || 'topstories'}
              onChange={set('endpoint')}
            >
              <option value="topstories">Top stories</option>
              <option value="newstories">New stories</option>
              <option value="beststories">Best stories</option>
            </select>
          ) : (
            <input
              id="source-endpoint"
              required
              type={form.connectorType === 'rss' ? 'url' : 'text'}
              value={form.endpoint}
              onChange={set('endpoint')}
            />
          )}
        </label>
        <label htmlFor="source-batch">
          Batch size
          <input
            id="source-batch"
            required
            type="number"
            min="1"
            max="100"
            value={form.batchSize}
            onChange={set('batchSize')}
          />
        </label>
      </div>
      {visibleError ? (
        <p id="source-form-error" className="admin-inline-error" role="alert">
          {visibleError}
        </p>
      ) : null}
      <div className="admin-row-actions admin-add-source-actions">
        <AdminButton type="submit" variant="primary" icon="arrow" disabled={busy}>
          {busy ? 'Đang tạo…' : 'Tạo draft'}
        </AdminButton>
        {onClose ? (
          <AdminButton type="button" variant="secondary" onClick={onClose}>
            Hủy
          </AdminButton>
        ) : null}
      </div>
    </form>
  )
}

export function AddSourcePanel({ onSubmit, busy = false, error = null, initialOpen = false }) {
  const [open, setOpen] = useState(initialOpen)

  return (
    <div className="source-add-panel">
      <AdminButton
        variant="primary"
        icon="arrow"
        type="button"
        aria-expanded={open}
        aria-controls={open ? SOURCE_PANEL_ID : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Đóng thêm nguồn' : '+ Thêm nguồn'}
      </AdminButton>
      {open ? (
        <div
          id={SOURCE_PANEL_ID}
          className="source-modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="source-create-title"
        >
          <SourceCreateForm
            onSubmit={onSubmit}
            busy={busy}
            error={error}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  )
}

export default AddSourcePanel
