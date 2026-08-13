import { describe, expect, it } from 'vitest'
import { validateAnswerPayload, validateQuestionScope, refusalCopy } from '../../../client/features/qa/qa-validation.js'

describe('Step 10 Q&A validation', () => {
  it('requires a Vietnamese question and one complete scope branch', () => {
    expect(validateQuestionScope('', {})).toMatchObject({ valid: false, firstInvalid: 'question' })
    expect(validateQuestionScope('ab', { articleId: 'article-1' })).toMatchObject({ valid: false, firstInvalid: 'question' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', {})).toMatchObject({ valid: false, firstInvalid: 'scope' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { publishedAfter: '2026-08-01T00:00:00.000Z' })).toMatchObject({ valid: false, firstInvalid: 'publishedBefore' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { topics: ['AI'] }).valid).toBe(true)
  })

  it('bounds topics, ids and time order without exposing transport details', () => {
    expect(validateQuestionScope('Câu hỏi hợp lệ', { topics: Array.from({ length: 11 }, (_, index) => `topic-${index}`) })).toMatchObject({ valid: false, firstInvalid: 'topics' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { articleId: 'x'.repeat(129) })).toMatchObject({ valid: false, firstInvalid: 'articleId' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { publishedAfter: '2026-08-12T00:00:00.000Z', publishedBefore: '2026-08-11T00:00:00.000Z' })).toMatchObject({ valid: false, firstInvalid: 'publishedAfter' })
  })

  it('accepts only complete answered/refused public branches and resolves citations', () => {
    const citation = { id: 'C1', sourceName: 'Nguồn biên tập', titleOriginal: 'Bài nguồn', originalUrl: 'https://example.com/article', publishedAt: '2026-08-10T00:00:00.000Z', sourceLanguage: 'vi' }
    expect(validateAnswerPayload({ data: { id: 'a1', status: 'answered', paragraphs: [{ text: 'Kết luận có nguồn.', citationIds: ['C1'] }], citations: [citation], refusalReason: null, chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' } }).valid).toBe(true)
    expect(validateAnswerPayload({ data: { id: 'r1', status: 'refused', paragraphs: [], citations: [], refusalReason: 'insufficient-evidence', chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' } }).valid).toBe(true)
    expect(validateAnswerPayload({ data: { id: 'a1', status: 'answered', paragraphs: [{ text: 'Thiếu citation.', citationIds: ['missing'] }], citations: [citation], refusalReason: null, chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' } }).valid).toBe(false)
  })

  it('keeps refusal copy canonical and generic', () => {
    expect(refusalCopy('sensitive-input').title).toContain('nhạy cảm')
    expect(refusalCopy('community-only').reason).toBe('insufficient-evidence')
    expect(refusalCopy('provider-unavailable').body).not.toMatch(/provider|route|model/i)
  })
})
