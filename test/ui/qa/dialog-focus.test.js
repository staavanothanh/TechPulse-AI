import { describe, expect, it, vi } from 'vitest'
import { dialogFocusAction } from '../../../client/features/qa/dialog-focus.js'

describe('Step 10 dialog keyboard boundary', () => {
  it('cycles Tab and Shift+Tab inside the current dialog', () => {
    const first = { focus: vi.fn() }
    const last = { focus: vi.fn() }
    const middle = { focus: vi.fn() }
    const focusables = [first, middle, last]

    expect(dialogFocusAction({ key: 'Tab', shiftKey: false, activeElement: last, focusables })).toEqual({ type: 'focus', target: first })
    expect(dialogFocusAction({ key: 'Tab', shiftKey: true, activeElement: first, focusables })).toEqual({ type: 'focus', target: last })
    expect(dialogFocusAction({ key: 'Tab', shiftKey: false, activeElement: middle, focusables })).toBeNull()
  })

  it('uses Escape as the only keyboard close action', () => {
    expect(dialogFocusAction({ key: 'Escape', focusables: [] })).toEqual({ type: 'close' })
    expect(dialogFocusAction({ key: 'Enter', focusables: [] })).toBeNull()
  })

  it('keeps Tab inside a pending dialog with no enabled controls', () => {
    const dialog = { focus: vi.fn() }
    expect(dialogFocusAction({ key: 'Tab', focusables: [], fallbackTarget: dialog })).toEqual({ type: 'focus', target: dialog })
  })
})
