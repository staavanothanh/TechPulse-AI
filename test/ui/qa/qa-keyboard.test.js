import { describe, expect, it, vi } from 'vitest'
import { handleQaQuestionKeyDown } from '../../../client/features/qa/qa-keyboard.js'

describe('Q&A composer keyboard behavior', () => {
  it('submits on Enter without Shift and prevents a newline', () => {
    const event = { key: 'Enter', shiftKey: false, preventDefault: vi.fn() }
    const submit = vi.fn()

    expect(handleQaQuestionKeyDown(event, submit)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith(event)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('preserves a newline on Shift+Enter', () => {
    const event = { key: 'Enter', shiftKey: true, preventDefault: vi.fn() }
    const submit = vi.fn()

    expect(handleQaQuestionKeyDown(event, submit)).toBe(false)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })

  it('ignores other keys and Enter while composing text', () => {
    const submit = vi.fn()
    const preventDefault = vi.fn()

    expect(handleQaQuestionKeyDown({ key: 'a', preventDefault }, submit)).toBe(false)
    expect(handleQaQuestionKeyDown({ key: 'Enter', isComposing: true, preventDefault }, submit)).toBe(false)
    expect(handleQaQuestionKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault }, submit)).toBe(false)
    expect(handleQaQuestionKeyDown({ key: 'Enter', nativeEvent: { keyCode: 229 }, preventDefault }, submit)).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
  })
})
