import React from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import AnswerResult from '../../../client/features/qa/AnswerResult.jsx'
import AnswerScopeControls from '../../../client/features/qa/AnswerScopeControls.jsx'
import ChatSessionTranscript from '../../../client/features/qa/ChatSessionTranscript.jsx'
import GroundedQaScreen from '../../../client/features/qa/GroundedQaScreen.jsx'
import { CitationDrawer } from '../../../client/features/qa/CitationDrawer.jsx'
import ChatSessionList from '../../../client/features/qa/ChatSessionList.jsx'
import QuestionComposer from '../../../client/features/qa/QuestionComposer.jsx'

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))
const citation = { id: 'C1', sourceName: 'Nguồn biên tập', titleOriginal: 'Bài nguồn cần kiểm chứng', originalUrl: 'https://example.com/source', publishedAt: '2026-08-10T00:00:00.000Z', sourceLanguage: 'vi', author: null }

describe('Step 10 grounded Q&A UI', () => {
  it('renders answered paragraphs with local citation chips and no debug fields', () => {
    const html = render(AnswerResult, { answer: { id: 'a1', status: 'answered', paragraphs: [{ text: 'Đoạn trả lời có nguồn.', citationIds: ['C1'] }], citations: [citation], refusalReason: null, chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' }, onCitation: vi.fn() })
    expect(html).toContain('Đoạn trả lời có nguồn.')
    expect(html).toContain('[C1] Nguồn biên tập')
    expect(html).not.toMatch(/score|vector|provider|evidenceBlock|prompt/i)
  })

  it('renders canonical refusal branches without paragraphs or citations', () => {
    const html = render(AnswerResult, { answer: { id: 'r1', status: 'refused', paragraphs: [], citations: [], refusalReason: 'sensitive-input', chatSessionId: 's1', createdAt: '2026-08-12T00:00:00.000Z' }, onCitation: vi.fn() })
    expect(html).toContain('Thông tin nhạy cảm chưa được gửi')
    expect(html).toMatch(/Sửa câu hỏi/i)
    expect(html).not.toContain('citation-chip')
  })

  it('renders scope controls with associated validation and transcript unavailable redaction', () => {
    const scope = render(AnswerScopeControls, { value: { topics: ['AI'] }, onChange: vi.fn(), error: 'Chọn một phạm vi.' })
    expect(scope).toContain('aria-describedby')
    expect(scope).toContain('Chọn một phạm vi.')
    const history = render(ChatSessionTranscript, { status: 'ready', detail: { id: 's1', title: null, scope: { topics: ['AI'] }, messageCount: 2, messages: [{ id: 'u1', role: 'user', text: 'Câu hỏi', createdAt: '2026-08-12T00:00:00.000Z' }, { id: 'a1', role: 'assistant', status: 'answered', paragraphs: [{ text: 'Lịch sử.', citationIds: ['H1'] }], citations: [{ id: 'H1', status: 'unavailable', unavailableReason: 'article-removed' }], refusalReason: null, createdAt: '2026-08-12T00:00:00.000Z' }], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' } })
    expect(history).toContain('Nguồn lịch sử không còn khả dụng')
    expect(history).not.toMatch(/originalUrl|titleOriginal|publishedAt|https:\/\//)
  })

  it('uses unique answer heading IDs for every historical message', () => {
    const answer = (id) => ({ id, role: 'assistant', status: 'answered', paragraphs: [{ text: `Lịch sử ${id}.`, citationIds: ['H1'] }], citations: [{ id: 'H1', status: 'unavailable', unavailableReason: 'article-removed' }], refusalReason: null, createdAt: '2026-08-12T00:00:00.000Z' })
    const html = render(ChatSessionTranscript, { status: 'ready', detail: { id: 's1', title: null, scope: { topics: ['AI'] }, messageCount: 2, messages: [answer('a1'), answer('a2')], createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' } })
    expect(html).toContain('id="qa-answer-title-a1"')
    expect(html).toContain('id="qa-answer-title-a2"')
    expect(html.match(/id="qa-answer-title-/g)).toHaveLength(2)
  })

  it('keeps three-pane landmark layout and mobile dialog actions semantic', () => {
    const html = render(GroundedQaScreen, { generatedApi: {}, csrfToken: 'csrf', api: { listSessions: vi.fn() } })
    expect(html).toContain('aria-label="Q&amp;A có nguồn"')
    expect(html).toContain('Q&amp;A')
    expect(html).toContain('Lịch sử phiên')
    expect(html).toContain('Mở phạm vi')
    expect(html).not.toMatch(/<main(?:\s|>)/)
  })

  it('limits citation drawer to server-hydrated safe fields', () => {
    const html = render(CitationDrawer, { citation, open: true, onClose: vi.fn() })
    expect(html).toContain('Mở nguồn gốc')
    expect(html).toContain('noopener noreferrer external')
    expect(html).not.toMatch(/provider|score|vector|evidenceBlock/i)
  })

  it('uses one backdrop around the citation dialog so backdrop click can close it', () => {
    const html = render(CitationDrawer, { citation, open: true, onClose: vi.fn() })
    expect(html).toContain('class="qa-dialog-scrim qa-citation-scrim"')
    expect(html).toContain('data-citation-backdrop="true"')
  })

  it('associates field errors and date IDs with their exact controls', () => {
    const html = render(AnswerScopeControls, { value: { topics: ['AI'] }, onChange: vi.fn(), errors: { topics: 'Chủ đề lỗi', publishedBefore: 'Ngày kết thúc lỗi' } })
    expect(html).toContain('id="qa-publishedAfter"')
    expect(html).toContain('id="qa-publishedBefore"')
    expect(html).toContain('aria-invalid="true"')
    expect(html).toContain('aria-describedby="qa-topics-error"')
    expect(html).toContain('aria-describedby="qa-publishedBefore-error"')
  })

  it('supports unique field IDs when scope controls render in a dialog', () => {
    const html = render(AnswerScopeControls, { value: { topics: ['AI'] }, onChange: vi.fn(), idPrefix: 'qa-dialog' })
    expect(html).toContain('id="qa-dialog-publishedAfter"')
    expect(html).toContain('for="qa-dialog-publishedAfter"')
    expect(html).not.toContain('id="qa-publishedAfter"')
  })

  it('marks question validation on the textarea and disables submit during cooldown', () => {
    const invalid = render(QuestionComposer, { scope: {}, onSubmit: vi.fn(), errors: { question: 'Câu hỏi lỗi' } })
    expect(invalid).toContain('aria-invalid="true"')
    expect(invalid).toContain('aria-describedby="qa-question-error qa-question-hint"')
    const cooldown = render(QuestionComposer, { scope: { topics: ['AI'] }, onSubmit: vi.fn(), cooldown: 17 })
    expect(cooldown).toContain('Thử lại sau 17 giây')
    expect(cooldown).toContain('disabled=""')
  })

  it('provides a validation callback so scope errors reach the owning screen', () => {
    const composer = readFileSync(new URL('../../../client/features/qa/QuestionComposer.jsx', import.meta.url), 'utf8')
    expect(composer).toContain('onInvalid?.(result)')
    expect(composer).toMatch(/result\.firstInvalid === 'question'[\s\S]*setError/)
  })

  it('clears an owning field error when its value changes', () => {
    const composer = readFileSync(new URL('../../../client/features/qa/QuestionComposer.jsx', import.meta.url), 'utf8')
    const scope = readFileSync(new URL('../../../client/features/qa/AnswerScopeControls.jsx', import.meta.url), 'utf8')
    expect(composer).toContain("onFieldChange?.('question')")
    expect(scope).toContain('onFieldChange?.(key)')
  })

  it('keeps opaque pagination state out of rendered session copy', () => {
    const html = render(ChatSessionList, { sessions: [{ id: 's1', title: 'Một phiên có tên rất dài', updatedAt: '2026-08-12T00:00:00.000Z' }], hasNext: true, onLoadMore: vi.fn() })
    expect(html).toContain('Tải thêm phiên')
    expect(html).not.toContain('opaque-next-cursor')
    expect(html).toContain('tabindex="-1"')
  })
})
