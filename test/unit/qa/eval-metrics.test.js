import { describe, expect, it, vi } from 'vitest'
import { runGroundednessEvaluation } from '../../../server/evals/groundedness.js'
import { runCitationEvaluation } from '../../../server/evals/citations.js'

const evidence = [{
  article: { id: 'article-eval', sourceId: 'source-eval', titleOriginal: 'Chip AI tiet kiem dien', excerptOriginal: 'Ket qua tiet kiem dien.', originalUrl: 'https://example.test/eval', publishedAt: '2026-08-10T00:00:00.000Z', status: 'published', evidenceEligible: true },
  source: { id: 'source-eval', name: 'Nguon eval', authorityTier: 'editorial', operationalStatus: 'active', licenseStatus: 'permitted', policyVersion: 1, llmInputScope: 'excerpt' },
}]

const cases = [
  { id: 'answer-grounded', kind: 'grounded', question: 'Chip AI tiet kiem dien the nao?', evidence, expected: 'answered', expectedClaims: ['tiet kiem dien'], expectedCitationIds: ['C1'] },
  { id: 'refuse-irrelevant', kind: 'irrelevant', question: 'Thoi tiet ngay mai the nao?', evidence, expected: 'insufficient-evidence', expectedClaims: [], expectedCitationIds: [] },
]

describe('Step 10 controlled createAnswer evaluation metrics', () => {
  it('executes each controlled case through createAnswer and reports groundedness metrics', async () => {
    const createAnswer = vi.fn(async ({ question, item }) => question.startsWith('Chip')
      ? { answer: { status: 'answered', paragraphs: [{ text: 'Chip AI tiet kiem dien.', citationIds: ['C1'] }], citations: [{ id: 'C1' }] } }
      : { answer: { status: 'refused', refusalReason: 'insufficient-evidence', paragraphs: [], citations: [] }, evidenceEligible: item.evidence[0].article.evidenceEligible })
    const report = await runGroundednessEvaluation({ cases, createAnswer })
    expect(report).toEqual(expect.objectContaining({ total: 2, passed: true, refusalAccuracy: 1, unsupportedClaimRate: 0, faithfulness: 1, contextPrecision: 1, contextRecall: 1 }))
    expect(report.details).toHaveLength(2)
    expect(createAnswer).toHaveBeenCalledTimes(2)
    expect(createAnswer.mock.calls[1][0].item.evidence[0].article.evidenceEligible).toBe(true)
  })

  it('reports citation precision and claim coverage from end-to-end outputs', async () => {
    const createAnswer = async () => ({ answer: { status: 'answered', paragraphs: [{ text: 'Khong du lieu.', citationIds: ['C9'] }], citations: [] } })
    const report = await runCitationEvaluation({ cases: [cases[0]], createAnswer })
    expect(report).toEqual(expect.objectContaining({ total: 1, passed: false, citationPrecision: 0, claimCoverage: 0 }))
    expect(report.details[0]).toEqual(expect.objectContaining({ citationPrecision: 0, claimCoverage: 0, passed: false }))
  })

  it('fails an insufficient-evidence slice when provider reports unavailable', async () => {
    const report = await runGroundednessEvaluation({ cases: [cases[1]], createAnswer: async () => ({ answer: { status: 'refused', refusalReason: 'provider-unavailable', paragraphs: [], citations: [] } }) })
    expect(report.passed).toBe(false)
    expect(report.details[0]).toMatchObject({ refusalAccuracy: 0, passed: false, actual: 'provider-unavailable' })
  })
})
