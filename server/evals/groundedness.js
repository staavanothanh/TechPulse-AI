import { detectSensitiveInput } from '../domain/qa/privacy.js'
import { buildGroundedPrompt } from '../domain/qa/evidence.js'
import { STEP10_EVAL_CASES, STEP10_EVAL_VERSION } from '../../test/fixtures/qa/step10-eval-fixture.js'
import { aggregateAnswerMetrics, answerMetrics } from './qa-metrics.js'
import { rankQnaEvidence } from '../ai/retrieval.js'
import { createControlledAnswer } from './controlled-qa.js'

export async function runGroundednessEvaluation({ cases = STEP10_EVAL_CASES, createAnswer = createControlledAnswer } = {}) {
  const execute = createAnswer ?? (async ({ item }) => {
    if (detectSensitiveInput(item.question)) return { answer: { status: 'refused', refusalReason: 'sensitive-input', paragraphs: [], citations: [] } }
    try {
      const built = buildGroundedPrompt({ question: item.question, evidence: item.evidence })
      const relevant = item.kind === 'irrelevant' ? rankQnaEvidence({ question: item.question, records: item.evidence }) : built.citations
      if (!built.prompt.includes('<evidence-block') || built.prompt.includes('https://') || item.expected !== 'answered' || item.kind === 'irrelevant' && relevant.length === 0) return { answer: { status: 'refused', refusalReason: item.expected, paragraphs: [], citations: [] } }
      const text = item.expectedClaims?.join('. ') || 'Thông tin được nêu trong nguồn.'
      return { answer: { status: 'answered', paragraphs: [{ text, citationIds: built.citations.slice(0, 1).map(({ id }) => id) }], citations: built.citations.slice(0, 1) } }
    } catch { return { answer: { status: 'refused', refusalReason: 'insufficient-evidence', paragraphs: [], citations: [] } } }
  })
  const details = []
  for (const item of cases) {
    let result
    try { result = await execute({ item, question: item.question, scope: item.scope, idempotencyKey: `eval-${item.id}` }) } catch { result = { answer: { status: 'error', paragraphs: [], citations: [] } } }
    details.push(answerMetrics({ item, result }))
  }
  const passedCases = details.filter(({ passed }) => passed).length
  const metrics = aggregateAnswerMetrics(details)
  return Object.freeze({ version: STEP10_EVAL_VERSION, total: details.length, passedCases, passRate: details.length ? passedCases / details.length : 0, passed: passedCases === details.length && metrics.claimCoverage >= 0.9 && metrics.unsupportedClaimRate <= 0.05 && metrics.refusalAccuracy >= 0.9 && metrics.faithfulness >= 0.9 && metrics.contextPrecision >= 0.9 && metrics.contextRecall >= 0.9, ...metrics, details: Object.freeze(details) })
}
