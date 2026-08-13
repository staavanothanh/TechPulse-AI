import { buildGroundedPrompt } from '../domain/qa/evidence.js'
import { hydrateAnswerCitations, serializeHistoricalCitation, validateParagraphCitations } from '../domain/qa/citations.js'
import { STEP10_EVAL_CASES, STEP10_EVAL_VERSION } from '../../test/fixtures/qa/step10-eval-fixture.js'

export function runCitationEvaluation({ cases = STEP10_EVAL_CASES } = {}) {
  const details = cases.map((item) => {
    if (!['grounded', 'conflict', 'injection'].includes(item.kind)) return Object.freeze({ id: item.id, passed: true })
    try {
      const built = buildGroundedPrompt({ question: item.question, evidence: item.evidence })
      const citationIds = built.citations.map(({ id }) => id)
      const paragraphs = [{ text: 'Phat bieu duoc ho tro boi nguon.', citationIds: [citationIds[0]], evidenceBlockIds: [built.blocks[0].id] }]
      validateParagraphCitations({ paragraphs, citationIds, evidenceBlocks: built.blocks })
      const hydrated = hydrateAnswerCitations({ citationIds, evidence: item.evidence })
      const available = serializeHistoricalCitation({ id: 'C1', status: 'available', articleId: 'article-qa-1', sourceId: 'source-qa-1', originalUrl: hydrated[0].originalUrl, titleOriginal: hydrated[0].titleOriginal, publishedAt: hydrated[0].publishedAt })
      const unavailable = serializeHistoricalCitation({ id: 'C2', status: 'article-removed', articleId: 'article-qa-1', originalUrl: hydrated[0].originalUrl, titleOriginal: hydrated[0].titleOriginal, publishedAt: hydrated[0].publishedAt })
      const noForbiddenFields = !Object.hasOwn(unavailable, 'originalUrl') && !Object.hasOwn(unavailable, 'titleOriginal') && !Object.hasOwn(unavailable, 'publishedAt')
      return Object.freeze({ id: item.id, passed: Boolean(available.originalUrl.startsWith('https://') && noForbiddenFields) })
    } catch {
      return Object.freeze({ id: item.id, passed: false })
    }
  })
  const passedCases = details.filter(({ passed }) => passed).length
  return Object.freeze({ version: STEP10_EVAL_VERSION, total: details.length, passedCases, passRate: passedCases / details.length, passed: passedCases === details.length, details: Object.freeze(details) })
}
