import { describe, expect, it } from 'vitest'
import { validateAnswerPayload, validateQuestionScope, refusalCopy, hasQaScope } from '../../../client/features/qa/qa-validation.js'

describe('Step 10 Q&A validation', () => {
  it('requires a Vietnamese question and one complete scope branch', () => {
    expect(validateQuestionScope('', {})).toMatchObject({ valid: false, firstInvalid: 'question' })
    expect(validateQuestionScope('ab', { articleId: 'article-1' })).toMatchObject({ valid: false, firstInvalid: 'question' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', {})).toMatchObject({ valid: false, firstInvalid: 'scope' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', null)).toMatchObject({ valid: false, firstInvalid: 'scope' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { publishedAfter: '2026-08-01T00:00:00.000Z' })).toMatchObject({ valid: false, firstInvalid: 'publishedBefore' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { topics: ['AI'] }).valid).toBe(true)
  })

  it('detects when the answer scope has no selectable source constraint', () => {
    expect(hasQaScope({})).toBe(false)
    expect(hasQaScope({ topics: [] })).toBe(false)
    expect(hasQaScope({ topics: [''] })).toBe(false)
    expect(hasQaScope({ articleId: '  ' })).toBe(false)
    expect(hasQaScope({ topics: ['AI'], articleId: '  ' })).toBe(true)
    expect(hasQaScope({ articleId: '', topics: ['AI'] })).toBe(true)
    expect(validateQuestionScope('Câu hỏi hợp lệ', { articleId: '', topics: ['AI'] }).valid).toBe(true)
    expect(hasQaScope({ publishedAfter: 'not-a-date', publishedBefore: '2026-08-02T00:00:00.000Z' })).toBe(false)
    expect(hasQaScope({ articleId: 'article-1' })).toBe(false)
    expect(hasQaScope({ articleId: '507f1f77bcf86cd799439011' })).toBe(true)
    expect(hasQaScope({ publishedAfter: '2026-08-01T00:00:00.000Z', publishedBefore: '2026-08-02T00:00:00.000Z' })).toBe(true)
  })

  it('bounds topics, ids and time order without exposing transport details', () => {
    expect(validateQuestionScope('Câu hỏi hợp lệ', { topics: Array.from({ length: 11 }, (_, index) => `topic-${index}`) })).toMatchObject({ valid: false, firstInvalid: 'topics' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { articleId: 'x'.repeat(129) })).toMatchObject({ valid: false, firstInvalid: 'articleId' })
    expect(validateQuestionScope('Câu hỏi hợp lệ', { publishedAfter: '2026-08-12T00:00:00.000Z', publishedBefore: '2026-08-11T00:00:00.000Z' })).toMatchObject({ valid: false, firstInvalid: 'publishedAfter' })
  })

  it('validates the observed temporal question against its effective derived UTC scope', () => {
    const result = validateQuestionScope(
      'tháng 9 này có tin tức gì về các model AI mới không',
      { topics: ['AI'] },
      { now: new Date('2026-09-04T15:30:00.000Z') },
    )
    expect(result).toMatchObject({
      valid: true,
      scope: {
        topics: ['AI'],
        publishedAfter: '2026-09-01T00:00:00.000Z',
        publishedBefore: '2026-09-30T23:59:59.999Z',
      },
    })
  })

  it('rejects a one-sided explicit bound instead of completing it from the question', () => {
    expect(validateQuestionScope(
      'tháng 9 này có tin tức gì mới không',
      { topics: ['AI'], publishedAfter: '2026-09-01T00:00:00.000Z' },
      { now: new Date('2026-09-04T15:30:00.000Z') },
    )).toMatchObject({ valid: false, firstInvalid: 'publishedBefore' })
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
