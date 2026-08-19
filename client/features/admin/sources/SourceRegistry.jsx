import { useCallback, useEffect, useRef, useState } from 'react'
import { createSourceRegistryActions, sourceActionPrerequisites, sourceRegistryErrorState } from './source-actions.js'
import { createRequestSequence } from '../request-sequence.js'
import { buildPolicyReview, buildSourceConfigurationPatch, buildSourceCreateInput, policyDraftForSource } from './source-form.js'

const INITIAL_CREATE = Object.freeze({ connectorType: 'rss', accessMethod: 'rss', name: '', sourceKey: '', publisherName: '', domain: '', endpoint: '', batchSize: '20' })

function CreateSourceForm({ onSubmit, busy, error }) {
  const [form, setForm] = useState(INITIAL_CREATE)
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))
  const endpointLabel = form.connectorType === 'rss' ? 'URL RSS/Atom' : form.connectorType === 'arxiv' ? 'Truy vấn arXiv' : 'Luồng Hacker News'
  return (
    <form className="source-form" onSubmit={(event) => { event.preventDefault(); onSubmit(buildSourceCreateInput(form)) }} aria-describedby={error ? 'source-form-error' : undefined}>
      <div className="form-heading"><h3>Tạo nguồn draft</h3><span className="policy-chip">fail closed</span></div>
      <div className="source-form-grid">
        <label htmlFor="source-name">Tên nguồn<input id="source-name" required value={form.name} onChange={set('name')} /></label>
        <label htmlFor="source-key">Source key<input id="source-key" required pattern="[a-z0-9][a-z0-9:-]{2,119}" value={form.sourceKey} onChange={set('sourceKey')} /></label>
        <label htmlFor="source-publisher">Publisher<input id="source-publisher" required value={form.publisherName} onChange={set('publisherName')} /></label>
        <label htmlFor="source-domain">Hostname công khai<input id="source-domain" required value={form.domain} onChange={set('domain')} /></label>
        <label htmlFor="source-connector">Connector<select id="source-connector" value={form.connectorType} onChange={(event) => setForm((current) => ({ ...current, connectorType: event.target.value, endpoint: event.target.value === 'hacker-news' ? 'topstories' : '' }))}><option value="rss">RSS / Atom</option><option value="arxiv">arXiv API</option><option value="hacker-news">Hacker News API</option></select></label>
        {form.connectorType === 'rss' ? <label htmlFor="source-access">Định dạng feed<select id="source-access" value={form.accessMethod} onChange={set('accessMethod')}><option value="rss">RSS</option><option value="atom">Atom</option></select></label> : null}
        <label htmlFor="source-endpoint">{endpointLabel}{form.connectorType === 'hacker-news' ? <select id="source-endpoint" value={form.endpoint || 'topstories'} onChange={set('endpoint')}><option value="topstories">Top stories</option><option value="newstories">New stories</option><option value="beststories">Best stories</option></select> : <input id="source-endpoint" required type={form.connectorType === 'rss' ? 'url' : 'text'} value={form.endpoint} onChange={set('endpoint')} />}</label>
        <label htmlFor="source-batch">Batch size<input id="source-batch" required type="number" min="1" max="100" value={form.batchSize} onChange={set('batchSize')} /></label>
      </div>
      {error ? <p id="source-form-error" className="form-error" role="alert">{error}</p> : null}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Đang tạo…' : 'Tạo draft'}</button>
    </form>
  )
}

function PolicyReviewForm({ source, onSubmit, busy, error }) {
  const [form, setForm] = useState(() => policyDraftForSource(source))
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }))
  const setLicense = (event) => setForm((current) => {
    const licenseStatus = event.target.value
    const llmInputScope = licenseStatus === 'blocked' ? 'none' : licenseStatus === 'metadata-only' && !['none', 'metadata'].includes(current.llmInputScope) ? 'metadata' : current.llmInputScope
    return { ...current, licenseStatus, llmInputScope }
  })
  const requiresReReview = source.operationalStatus === 'active'
  return (
    <form className="source-form policy-form" onSubmit={(event) => { event.preventDefault(); onSubmit(buildPolicyReview(form)) }} aria-describedby={[error ? 'policy-form-error' : null, requiresReReview ? 'policy-review-prerequisite' : null].filter(Boolean).join(' ') || undefined}>
      <div className="form-heading"><h3>Human policy review</h3><span className="policy-chip">v{source.policyVersion}</span></div>
      <div className="source-form-grid">
        <label htmlFor="policy-license">Quyền sử dụng<select id="policy-license" value={form.licenseStatus} onChange={setLicense}><option value="metadata-only">Chỉ metadata</option><option value="permitted">Được phép</option><option value="blocked">Chặn</option></select></label>
        <label htmlFor="policy-input">LLM input<select id="policy-input" value={form.llmInputScope} onChange={set('llmInputScope')} disabled={form.licenseStatus === 'blocked'}><option value="none">Không gửi</option><option value="metadata">Metadata</option>{form.licenseStatus === 'permitted' ? <><option value="excerpt">Excerpt</option><option value="fulltext-temporary">Full text tạm thời</option></> : null}</select></label>
        <label htmlFor="policy-attribution">Dòng ghi nguồn<input id="policy-attribution" required={form.attributionRequired} value={form.attributionText} onChange={set('attributionText')} /></label>
        <label htmlFor="policy-terms">Terms URL<input id="policy-terms" type="url" value={form.termsUrl} onChange={set('termsUrl')} /></label>
        <label htmlFor="policy-license-url">License URL<input id="policy-license-url" type="url" value={form.licenseUrl} onChange={set('licenseUrl')} /></label>
        <label htmlFor="policy-image-mode">Ảnh<select id="policy-image-mode" value={form.imageMode} onChange={set('imageMode')} disabled={form.licenseStatus === 'blocked'}><option value="none">Tắt</option><option value="remote-preview">Remote preview</option></select></label>
        <label htmlFor="policy-video-mode">Video<select id="policy-video-mode" value={form.videoMode} onChange={set('videoMode')} disabled={form.licenseStatus === 'blocked'}><option value="none">Tắt</option><option value="link-only">Chỉ liên kết</option></select></label>
        <label htmlFor="policy-hosts">Media host đã duyệt<input id="policy-hosts" value={form.allowedHosts} onChange={set('allowedHosts')} placeholder="media.example.com" /></label>
      </div>
      <fieldset className="policy-options"><legend>Phạm vi và attribution</legend><label><input type="checkbox" checked={form.attributionRequired} onChange={set('attributionRequired')} /> Bắt buộc ghi nguồn</label><label><input type="checkbox" checked={form.licenseStatus === 'metadata-only' ? true : form.licenseStatus === 'blocked' ? false : form.storeMetadata} onChange={set('storeMetadata')} disabled={form.licenseStatus !== 'permitted'} /> Lưu metadata</label><label><input type="checkbox" checked={form.licenseStatus === 'permitted' && form.storeExcerpt} onChange={set('storeExcerpt')} disabled={form.licenseStatus !== 'permitted'} /> Lưu excerpt</label><label><input type="checkbox" checked={form.storeSummary} onChange={set('storeSummary')} disabled={form.llmInputScope === 'none' || form.licenseStatus === 'blocked'} /> Lưu summary</label><label><input type="checkbox" checked={form.storeEmbedding} onChange={set('storeEmbedding')} disabled={form.llmInputScope === 'none' || form.licenseStatus === 'blocked'} /> Lưu embedding</label><label><input type="checkbox" checked={form.mediaAttributionRequired} onChange={set('mediaAttributionRequired')} disabled={form.licenseStatus === 'blocked'} /> Media cần attribution</label></fieldset>
      <label htmlFor="policy-evidence">Bằng chứng review<textarea id="policy-evidence" required minLength="3" value={form.evidenceNote} onChange={set('evidenceNote')} rows="4" /></label>
      <label htmlFor="policy-media-evidence">Ghi chú quyền media<textarea id="policy-media-evidence" value={form.mediaEvidenceNote} onChange={set('mediaEvidenceNote')} rows="2" /></label>
      {requiresReReview ? <p id="policy-review-prerequisite" className="form-error">Tạm dừng và gửi duyệt lại trước khi lưu quyết định quyền mới.</p> : null}
      {error ? <p id="policy-form-error" className="form-error" role="alert">{error}</p> : null}
      <button className="primary-button" type="submit" disabled={busy || requiresReReview}>{busy ? 'Đang lưu…' : 'Lưu quyết định review'}</button>
    </form>
  )
}

function SourceConfigurationForm({ source, onSubmit, busy }) {
  const endpoint = source.connectorConfig.feedUrl ?? source.connectorConfig.arxivQuery ?? source.connectorConfig.hackerNewsStream ?? ''
  const [form, setForm] = useState({ name: source.name, publisherName: source.publisherName, domain: source.domain, endpoint, batchSize: String(source.connectorConfig.batchSize) })
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))
  const endpointLabel = source.connectorType === 'rss' ? 'URL RSS/Atom' : source.connectorType === 'arxiv' ? 'Truy vấn arXiv' : 'Luồng Hacker News'
  const requiresReReview = source.licenseStatus !== 'review-needed'
  return (
    <form className="source-form" onSubmit={(event) => { event.preventDefault(); onSubmit(buildSourceConfigurationPatch(source, form)) }} aria-describedby={requiresReReview ? 'source-config-prerequisite' : undefined}>
      <div className="form-heading"><h3>Cấu hình nguồn</h3><span className="policy-chip">{source.connectorType}</span></div>
      <div className="source-form-grid">
        <label htmlFor="source-config-name">Tên nguồn<input id="source-config-name" required value={form.name} onChange={set('name')} /></label>
        <label htmlFor="source-config-publisher">Publisher<input id="source-config-publisher" required value={form.publisherName} onChange={set('publisherName')} /></label>
        <label htmlFor="source-config-domain">Hostname công khai<input id="source-config-domain" required value={form.domain} onChange={set('domain')} /></label>
        <label htmlFor="source-config-endpoint">{endpointLabel}{source.connectorType === 'hacker-news' ? <select id="source-config-endpoint" value={form.endpoint} onChange={set('endpoint')}><option value="topstories">Top stories</option><option value="newstories">New stories</option><option value="beststories">Best stories</option></select> : <input id="source-config-endpoint" required type={source.connectorType === 'rss' ? 'url' : 'text'} value={form.endpoint} onChange={set('endpoint')} />}</label>
        <label htmlFor="source-config-batch">Batch size<input id="source-config-batch" required type="number" min="1" max="100" value={form.batchSize} onChange={set('batchSize')} /></label>
      </div>
      {requiresReReview ? <p id="source-config-prerequisite" className="form-error">Gửi duyệt lại trước khi đổi publisher, domain, authority hoặc connector.</p> : null}
      <button className="primary-button" type="submit" disabled={busy || requiresReReview}>{busy ? 'Đang lưu…' : 'Lưu cấu hình'}</button>
    </form>
  )
}

export function SourceDetails({ source, handlers, busy, error, headingRef }) {
  const canActivate = ['testing', 'paused'].includes(source.operationalStatus)
  const canPause = ['testing', 'active'].includes(source.operationalStatus)
  const canTest = source.operationalStatus === 'draft'
  const canReReview = source.operationalStatus !== 'archived' && source.licenseStatus !== 'review-needed'
  const prerequisites = sourceActionPrerequisites(source)
  return (
    <section className="source-details" aria-labelledby="source-detail-title">
      <div className="source-title-row"><div><span className="eyebrow">{source.sourceKey}</span><h2 id="source-detail-title" ref={headingRef} tabIndex="-1">{source.name}</h2></div><div className="source-badges"><span>{source.operationalStatus}</span><span>{source.licenseStatus}</span></div></div>
      <dl className="policy-rail"><div><dt>Policy</dt><dd>v{source.policyVersion}</dd></div><div><dt>Reconciliation</dt><dd>{source.reconciliation.status} · v{source.reconciliation.requiredPolicyVersion}</dd></div><div><dt>Technical</dt><dd>{source.technicalCheck.status}</dd></div><div><dt>LLM scope</dt><dd>{source.llmInputScope}</dd></div></dl>
      <div className="source-actions" aria-label="Thao tác trạng thái nguồn">
        {canTest ? <button type="button" onClick={() => handlers.onStatus(source, 'testing')} disabled={busy}>Chuyển sang kiểm thử</button> : null}
        {canActivate ? <button type="button" onClick={() => handlers.onStatus(source, 'active')} disabled={busy || !prerequisites.activationReady} aria-describedby={!prerequisites.activationReady ? 'source-activation-prerequisites' : undefined}>Kích hoạt</button> : null}
        {canPause ? <button type="button" onClick={() => handlers.onStatus(source, 'paused')} disabled={busy}>Tạm dừng</button> : null}
        <button type="button" onClick={() => handlers.onTechnicalCheck(source)} disabled={busy || !prerequisites.technicalCheckReady} aria-describedby="source-technical-check-prerequisite">Chạy kiểm tra kỹ thuật</button>
        <button type="button" onClick={() => handlers.onReReview(source)} disabled={busy || !canReReview} aria-describedby={!canReReview ? 'source-re-review-prerequisite' : undefined}>Gửi duyệt lại</button>
      </div>
      {canActivate && !prerequisites.activationReady ? <p id="source-activation-prerequisites" className="form-error">{prerequisites.activationReason}</p> : null}
      <p id="source-technical-check-prerequisite" className="operator-copy">{prerequisites.technicalCheckReason}</p>
      {!canReReview ? <p id="source-re-review-prerequisite" className="operator-copy">Nguồn đã ở trạng thái cần review hoặc đã archived.</p> : null}
      <SourceConfigurationForm key={`config:${source.id}:${source.updatedAt}`} source={source} onSubmit={(patch) => handlers.onConfig(source, patch)} busy={busy} />
      <PolicyReviewForm key={`${source.id}:${source.policyVersion}`} source={source} onSubmit={(review) => handlers.onPolicyReview(source, review)} busy={busy} error={error} />
    </section>
  )
}

export function SourceRegistryView({ state, sources, selected, busy = false, error, notice, handlers, detailHeadingRef }) {
  return (
    <section className="source-registry" aria-labelledby="source-registry-title">
      <div className="operator-header"><div><span className="eyebrow">Source Registry</span><h1 id="source-registry-title">Nguồn, quyền và trạng thái vận hành.</h1></div><button className="text-button" type="button" onClick={handlers.onReload} disabled={busy}>Tải lại</button></div>
      <p className="operator-copy">Mọi nguồn bắt đầu ở draft và fail closed. Chỉ quyết định review của admin mới thay đổi quyền xử lý.</p>
      <div className="source-live" role="status" aria-live="polite" aria-atomic="true">{notice ?? (busy ? 'Đang xử lý thay đổi…' : '')}</div>
      {state === 'loading' ? <div className="source-state" aria-busy="true">Đang tải Source Registry…</div> : null}
      {state === 'error' ? <div className="source-state" role="alert"><p>{error}</p><button type="button" onClick={handlers.onReload}>Thử lại</button></div> : null}
      {state === 'ready' ? <div className="source-workspace"><aside className="source-list" aria-label="Danh sách nguồn">{sources.length === 0 ? <p>Chưa có nguồn nào. Tạo draft đầu tiên ở biểu mẫu bên dưới.</p> : sources.map((item) => <button type="button" key={item.id} className={selected?.id === item.id ? 'selected' : ''} aria-pressed={selected?.id === item.id} onClick={() => handlers.onSelect(item)}><strong>{item.name}</strong><span>{item.connectorType} · {item.operationalStatus}</span><small>policy v{item.policyVersion}</small></button>)}</aside><div className="source-editor">{selected ? <SourceDetails source={selected} handlers={handlers} busy={busy} error={error} headingRef={detailHeadingRef} /> : <div className="source-state"><p>Chọn một nguồn để xem policy và trạng thái.</p></div>}<CreateSourceForm onSubmit={handlers.onCreate} busy={busy} error={error} /></div></div> : null}
    </section>
  )
}

export default function SourceRegistry({ api, csrfToken, onSessionExpired }) {
  const [state, setState] = useState('loading')
  const [sources, setSources] = useState([])
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState(null)
  const [focusDetailRequest, setFocusDetailRequest] = useState(0)
  const detailHeadingRef = useRef(null)
  const [requestSequence] = useState(createRequestSequence)

  const handleError = useCallback((requestError) => {
    const failure = sourceRegistryErrorState(requestError)
    if (failure.sessionExpiredNotice) onSessionExpired?.(failure.sessionExpiredNotice)
    setError(failure.message)
  }, [onSessionExpired])

  const reload = useCallback(async () => {
    const sequence = requestSequence.start()
    setState('loading'); setError(null)
    try {
      const response = await api.listSources({ credentials: 'same-origin' })
      if (!requestSequence.isCurrent(sequence)) return
      setSources(response.data)
      setSelected((current) => response.data.find((item) => item.id === current?.id) ?? response.data[0] ?? null)
      setState('ready')
    } catch (requestError) { handleError(requestError); setState('error') }
  }, [api, handleError, requestSequence])

  useEffect(() => {
    let active = true
    const sequence = requestSequence.start()
    api.listSources({ credentials: 'same-origin' }).then((response) => {
      if (!active || !requestSequence.isCurrent(sequence)) return
      setSources(response.data)
      setSelected(response.data[0] ?? null)
      setState('ready')
    }).catch((requestError) => {
      if (!active || !requestSequence.isCurrent(sequence)) return
      handleError(requestError)
      setState('error')
    })
    return () => { active = false; requestSequence.invalidate() }
  }, [api, handleError, requestSequence])

  useEffect(() => {
    if (focusDetailRequest === 0 || !selected?.id) return
    detailHeadingRef.current?.focus({ preventScroll: true })
  }, [selected?.id, focusDetailRequest])

  function selectSource(source) {
    setFocusDetailRequest((current) => current + 1)
    setSelected(source)
  }

  async function mutate(action, successMessage) {
    if (!csrfToken) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const response = await action()
      const next = response.data?.sourceId ? null : response.data
      if (next?.id) {
        setSources((current) => current.map((item) => item.id === next.id ? next : item))
        if (next.id !== selected?.id) setFocusDetailRequest((current) => current + 1)
        setSelected(next)
      } else await reload()
      setNotice(successMessage)
    } catch (requestError) { handleError(requestError) } finally { setBusy(false) }
  }

  const handlers = {
    onReload: reload,
    onSelect: selectSource,
    onCreate: (input) => createSourceRegistryActions({ api, csrfToken, mutate }).onCreate(input),
    onConfig: (source, patch) => createSourceRegistryActions({ api, csrfToken, mutate }).onConfig(source, patch),
    onStatus: (source, status) => createSourceRegistryActions({ api, csrfToken, mutate }).onStatus(source, status),
    onTechnicalCheck: (source) => createSourceRegistryActions({ api, csrfToken, mutate }).onTechnicalCheck(source),
    onPolicyReview: (source, review) => createSourceRegistryActions({ api, csrfToken, mutate }).onPolicyReview(source, review),
    onReReview: (source) => createSourceRegistryActions({ api, csrfToken, mutate }).onReReview(source),
  }
  return <SourceRegistryView state={state} sources={sources} selected={selected} busy={busy} error={error} notice={notice} handlers={handlers} detailHeadingRef={detailHeadingRef} />
}
