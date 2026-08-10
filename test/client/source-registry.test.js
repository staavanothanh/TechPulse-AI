import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import SourceRegistry, { SourceDetails, SourceRegistryView } from '../../client/features/admin/sources/SourceRegistry.jsx'
import { createSourceRegistryActions, sourceActionPrerequisites, sourceRegistryErrorState } from '../../client/features/admin/sources/source-actions.js'
import { buildPolicyReview, buildSourceCreateInput, policyDraftForSource } from '../../client/features/admin/sources/source-form.js'

const source = {
  id: '507f1f77bcf86cd799439011', name: 'Example', sourceKey: 'rss:example', publisherName: 'Example Publisher', domain: 'example.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: { kind: 'rss', feedUrl: 'https://example.com/feed.xml', batchSize: 20 },
  operationalStatus: 'testing', licenseStatus: 'metadata-only', llmInputScope: 'metadata', storageScope: { metadata: true, excerpt: false, summary: true, embedding: true }, mediaPolicy: { imageMode: 'none', videoMode: 'none', allowedHosts: [], attributionRequired: false, evidenceNote: null }, attributionRequired: true, attributionText: 'Example Publisher', evidenceNote: 'Human review evidence.', reviewedAt: '2026-08-10T00:00:00.000Z', reviewedBy: '507f1f77bcf86cd799439012', policyVersion: 2, reconciliation: { status: 'pending', requiredPolicyVersion: 2 }, technicalCheck: { status: 'passed' },
}
const handlers = { onCreate: vi.fn(), onSelect: vi.fn(), onConfig: vi.fn(), onStatus: vi.fn(), onTechnicalCheck: vi.fn(), onPolicyReview: vi.fn(), onReReview: vi.fn(), onReload: vi.fn() }

describe('Admin Source Registry UI', () => {
  it('derives connector/access/authority as one closed unit without credential fields', () => {
    expect(buildSourceCreateInput({ connectorType: 'arxiv', name: 'arXiv AI', sourceKey: 'arxiv:ai', publisherName: 'arXiv', domain: 'arxiv.org', endpoint: 'cat:cs.AI', batchSize: '25' })).toEqual(expect.objectContaining({ connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', connectorConfig: { kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 25 } }))
    expect(buildSourceCreateInput({ connectorType: 'hacker-news', name: 'HN', sourceKey: 'hn:top', publisherName: 'Hacker News', domain: 'news.ycombinator.com', endpoint: 'topstories', batchSize: '20' }).authorityTier).toBe('community-signal')
    expect(JSON.stringify(buildSourceCreateInput({ connectorType: 'rss', name: 'Feed', sourceKey: 'rss:feed', publisherName: 'Feed', domain: 'example.com', endpoint: 'https://example.com/feed.xml', batchSize: '20' }))).not.toMatch(/password|secret|credential/i)
  })

  it('preloads the complete current policy and defaults only review-needed to metadata-only', () => {
    const permitted = policyDraftForSource({ ...source, licenseStatus: 'permitted', llmInputScope: 'excerpt', storageScope: { metadata: true, excerpt: true, summary: false, embedding: true }, mediaPolicy: { imageMode: 'remote-preview', videoMode: 'link-only', allowedHosts: ['media.example.com'], attributionRequired: true, evidenceNote: 'Media rights reviewed.' }, evidenceNote: 'Text rights reviewed.' })
    expect(permitted).toEqual(expect.objectContaining({ licenseStatus: 'permitted', llmInputScope: 'excerpt', storeMetadata: true, storeExcerpt: true, storeSummary: false, storeEmbedding: true, imageMode: 'remote-preview', videoMode: 'link-only', allowedHosts: 'media.example.com', mediaEvidenceNote: 'Media rights reviewed.', evidenceNote: 'Text rights reviewed.' }))
    expect(buildPolicyReview(permitted).storageScope).toEqual({ metadata: true, excerpt: true, summary: false, embedding: true })
    expect(policyDraftForSource({ ...source, licenseStatus: 'review-needed', llmInputScope: 'none' })).toEqual(expect.objectContaining({ licenseStatus: 'metadata-only', llmInputScope: 'metadata' }))
    expect(buildPolicyReview({ ...permitted, licenseStatus: 'metadata-only', llmInputScope: 'excerpt', storeMetadata: false, storeExcerpt: true }).storageScope).toEqual({ metadata: true, excerpt: false, summary: false, embedding: true })
    expect(buildPolicyReview({ ...permitted, licenseStatus: 'blocked' }).storageScope).toEqual({ metadata: false, excerpt: false, summary: false, embedding: false })
  })

  it('announces loading, empty and error states', () => {
    expect(renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'loading', sources: [], handlers }))).toContain('aria-busy="true"')
    expect(renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'ready', sources: [], handlers }))).toContain('Chưa có nguồn nào')
    const error = renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'error', sources: [], error: 'Không thể tải nguồn.', handlers }))
    expect(error).toContain('role="alert"')
    expect(error).toContain('Thử lại')
  })

  it('renders accessible create/review controls and status actions without credential input', () => {
    const html = renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'ready', sources: [source], selected: source, busy: false, handlers }))
    for (const id of ['source-name', 'source-key', 'source-publisher', 'source-domain', 'source-connector', 'source-endpoint', 'source-config-domain', 'source-config-endpoint', 'policy-license', 'policy-evidence']) {
      expect(html).toContain(`for="${id}"`)
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('Kích hoạt')
    expect(html).toContain('Lưu cấu hình')
    expect(html).toContain('Chạy kiểm tra kỹ thuật')
    expect(html).toContain('Gửi duyệt lại')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('id="source-detail-title" tabindex="-1"')
    expect(html).not.toMatch(/type="password"|credential|api key/i)
  })

  it('disables activation and technical checks with connected prerequisite explanations', () => {
    const blocked = { ...source, licenseStatus: 'review-needed', reviewedAt: null, reviewedBy: null, evidenceNote: null, technicalCheck: { status: 'not-run' } }
    const prerequisites = sourceActionPrerequisites(blocked)
    expect(prerequisites.activationReady).toBe(false)
    expect(prerequisites.activationReason).toMatch(/kiểm tra kỹ thuật|duyệt quyền/i)

    const html = renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'ready', sources: [blocked], selected: blocked, busy: false, handlers }))
    expect(html).toContain('id="source-activation-prerequisites"')
    expect(html).toContain('aria-describedby="source-activation-prerequisites"')
    expect(html).toContain('id="source-technical-check-prerequisite"')
    expect(html).toContain('aria-describedby="source-technical-check-prerequisite"')
    expect(html).toMatch(/Kích hoạt<\/button>/)
  })

  it('wires ready activation to the status handler and keeps native button semantics', () => {
    const localHandlers = { ...handlers, onStatus: vi.fn() }
    const tree = SourceDetails({ source, handlers: localHandlers, busy: false, error: null, headingRef: null })
    const findButton = (node, label) => {
      if (!node || typeof node !== 'object') return null
      if (node.type === 'button' && node.props.children === label) return node
      const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
      return children.map((child) => findButton(child, label)).find(Boolean) ?? null
    }
    const activate = findButton(tree, 'Kích hoạt')
    expect(activate.type).toBe('button')
    expect(activate.props.disabled).toBe(false)
    activate.props.onClick()
    expect(localHandlers.onStatus).toHaveBeenCalledWith(source, 'active')
  })

  it('executes create/config/review/activate API interactions and classifies session expiry', async () => {
    const api = {
      createSource: vi.fn(async () => ({ data: source })),
      updateSource: vi.fn(async () => ({ data: source })),
      reviewSourcePolicy: vi.fn(async () => ({ data: source })),
      requestSourcePolicyReReview: vi.fn(async () => ({ data: source })),
      runSourceTechnicalCheck: vi.fn(async () => ({ data: { sourceId: source.id } })),
    }
    const mutate = vi.fn(async (action) => action())
    const actions = createSourceRegistryActions({ api, csrfToken: 'csrf', mutate, createIdempotencyKey: () => 'interaction-key-1' })
    await actions.onCreate({ name: 'Created' })
    await actions.onConfig(source, { name: 'Configured', reasonCode: 'source_configuration_changed' })
    await actions.onStatus(source, 'active')
    await actions.onPolicyReview(source, { reasonCode: 'source_policy_reviewed' })
    await actions.onReReview(source)
    await actions.onTechnicalCheck(source)
    expect(api.createSource).toHaveBeenCalledTimes(1)
    expect(api.updateSource).toHaveBeenCalledTimes(2)
    expect(api.reviewSourcePolicy).toHaveBeenCalledTimes(1)
    expect(api.requestSourcePolicyReReview).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ 'Idempotency-Key': 'interaction-key-1' }) }))
    expect(api.runSourceTechnicalCheck).toHaveBeenCalledTimes(1)
    expect(sourceRegistryErrorState({ status: 401, message: 'expired' })).toEqual(expect.objectContaining({ sessionExpiredNotice: expect.stringMatching(/hết hạn/i) }))
    expect(sourceRegistryErrorState({ status: 503, message: 'down' }).sessionExpiredNotice).toBeNull()
  })

  it('renders the stateful controller loading shell and covers status-specific prerequisite branches', () => {
    const shell = renderToStaticMarkup(React.createElement(SourceRegistry, { api: { listSources: vi.fn() }, csrfToken: 'csrf' }))
    expect(shell).toContain('Đang tải Source Registry')
    for (const candidate of [
      { ...source, operationalStatus: 'draft', licenseStatus: 'review-needed', technicalCheck: { status: 'not-run' } },
      { ...source, operationalStatus: 'active' },
      { ...source, operationalStatus: 'archived' },
    ]) {
      const html = renderToStaticMarkup(React.createElement(SourceRegistryView, { state: 'ready', sources: [candidate], selected: candidate, busy: false, handlers }))
      expect(html).toContain(candidate.operationalStatus)
    }
    expect(sourceRegistryErrorState({ status: 403 }).message).toMatch(/quyền/i)
    expect(sourceRegistryErrorState({ status: 409 }).message).toMatch(/thay đổi|Idempotency/i)
    expect(sourceRegistryErrorState({ status: 422 }).message).toMatch(/hợp lệ/i)
    expect(sourceRegistryErrorState(new Error('custom failure')).message).toBe('custom failure')
    expect(sourceRegistryErrorState({}).message).toMatch(/Không thể/i)
    expect(sourceActionPrerequisites(source)).toEqual(expect.objectContaining({ activationReady: true, activationReason: 'Đủ điều kiện kích hoạt.' }))
  })
})
