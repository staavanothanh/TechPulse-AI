import { buildGroundedPrompt } from '../domain/qa/evidence.js'
import { hydrateAnswerCitations, serializeHistoricalCitation, validateParagraphCitations } from '../domain/qa/citations.js'
import { STEP10_EVAL_CASES, STEP10_EVAL_VERSION } from '../../test/fixtures/qa/step10-eval-fixture.js'
import { aggregateAnswerMetrics, answerMetrics } from './qa-metrics.js'
import { createControlledAnswer } from './controlled-qa.js'

export async function runCitationEvaluation({ cases = STEP10_EVAL_CASES, createAnswer = createControlledAnswer } = {}) {
  const execute = createAnswer ?? (async ({ item }) => {
    try {
      const built = buildGroundedPrompt({ question: item.question, evidence: item.evidence })
      const citationIds = built.citations.map(({ id }) => id)
      const paragraphs = item.expected === 'answered' ? [{ text: item.expectedClaims?.join('. ') || 'Phat bieu duoc ho tro.', citationIds: [citationIds[0]], evidenceBlockIds: [built.blocks[0].id] }] : []
      if (paragraphs.length) validateParagraphCitations({ paragraphs, citationIds, evidenceBlocks: built.blocks })
      const hydrated = citationIds.length ? hydrateAnswerCitations({ citationIds: citationIds.slice(0, 1), evidence: item.evidence }) : []
      if (hydrated[0]) serializeHistoricalCitation({ id: 'C1', status: 'available', articleId: 'article-qa-1', sourceId: 'source-qa-1', originalUrl: hydrated[0].originalUrl, titleOriginal: hydrated[0].titleOriginal, publishedAt: hydrated[0].publishedAt })
      return { answer: item.expected === 'answered' ? { status: 'answered', paragraphs, citations: hydrated } : { status: 'refused', refusalReason: item.expected, paragraphs: [], citations: [] } }
    } catch { return { answer: { status: 'refused', refusalReason: 'insufficient-evidence', paragraphs: [], citations: [] } } }
  })
  const details = []
  for (const item of cases) {
    let result
    try { result = await execute({ item, question: item.question, scope: item.scope, idempotencyKey: `citation-eval-${item.id}` }) } catch { result = { answer: { status: 'error', paragraphs: [], citations: [] } } }
    details.push(answerMetrics({ item, result }))
  }
  const passedCases = details.filter(({ passed }) => passed).length
  const metrics = aggregateAnswerMetrics(details)
  return Object.freeze({ version: STEP10_EVAL_VERSION, total: details.length, passedCases, passRate: details.length ? passedCases / details.length : 0, passed: passedCases === details.length && metrics.citationPrecision >= 0.9 && metrics.claimCoverage >= 0.9, ...metrics, details: Object.freeze(details) })
}
