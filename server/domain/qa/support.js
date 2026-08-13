import { validateParagraphCitations } from './citations.js'

export function assertSupportedAnswer({ verdict, verdictEvidenceBlockIds, paragraphs, citationIds, evidenceBlocks } = {}) {
  if (verdict !== 'supported') throw new Error('Answer support verdict is not sufficient')
  const expected = evidenceBlocks.map(({ id }) => id)
  if (!Array.isArray(verdictEvidenceBlockIds) || verdictEvidenceBlockIds.length !== expected.length || new Set(verdictEvidenceBlockIds).size !== expected.length || expected.some((id) => !verdictEvidenceBlockIds.includes(id))) {
    const error = new Error('Answer support verdict evidence set is invalid')
    error.code = 'uncertain'
    throw error
  }
  validateParagraphCitations({ paragraphs, citationIds, evidenceBlocks })
  return true
}

export function deterministicRefusal(verdict) {
  if (!['unsupported', 'uncertain'].includes(verdict)) throw new Error('Support verdict is invalid')
  return 'insufficient-evidence'
}
