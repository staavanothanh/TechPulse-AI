import { describe, expect, it, vi } from 'vitest'
import { bindDialogFocus, dialogFocusAction } from '../../../client/features/qa/dialog-focus.js'

describe('Step 10 dialog keyboard boundary', () => {
  it('cycles Tab and Shift+Tab inside the current dialog', () => {
    const first = { focus: vi.fn() }
    const last = { focus: vi.fn() }
    const middle = { focus: vi.fn() }
    const focusables = [first, middle, last]

    expect(
      dialogFocusAction({ key: 'Tab', shiftKey: false, activeElement: last, focusables }),
    ).toEqual({ type: 'focus', target: first })
    expect(
      dialogFocusAction({ key: 'Tab', shiftKey: true, activeElement: first, focusables }),
    ).toEqual({ type: 'focus', target: last })
    expect(
      dialogFocusAction({ key: 'Tab', shiftKey: false, activeElement: middle, focusables }),
    ).toBeNull()
  })
  it('redirects Tab from body or backdrop focus to the nearest dialog boundary', () => {
    const body = {}
    const first = { focus: vi.fn() }
    const last = { focus: vi.fn() }
    const focusables = [first, last]

    expect(dialogFocusAction({ key: 'Tab', activeElement: body, focusables })).toEqual({
      type: 'focus',
      target: first,
    })
    expect(dialogFocusAction({ key: 'Tab', shiftKey: true, activeElement: body, focusables })).toEqual({
      type: 'focus',
      target: last,
    })
  })


  it('uses Escape as the only keyboard close action', () => {
    expect(dialogFocusAction({ key: 'Escape', focusables: [] })).toEqual({ type: 'close' })
    expect(dialogFocusAction({ key: 'Enter', focusables: [] })).toBeNull()
  })

  it('keeps Tab inside a pending dialog with no enabled controls', () => {
    const dialog = { focus: vi.fn() }
    expect(dialogFocusAction({ key: 'Tab', focusables: [], fallbackTarget: dialog })).toEqual({
      type: 'focus',
      target: dialog,
    })
  })
  it('handles Escape from body or backdrop focus through the document binding', () => {
    const eventTarget = { addEventListener: vi.fn(), removeEventListener: vi.fn() }
    const body = {}
    const onClose = vi.fn()
    const cleanup = bindDialogFocus(eventTarget, {
      getActiveElement: () => body,
      getFocusables: () => [],
      fallbackTarget: { focus: vi.fn() },
      onClose,
    })
    const listener = eventTarget.addEventListener.mock.calls[0][1]
    const event = { key: 'Escape', target: body, preventDefault: vi.fn() }

    listener(event)

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(eventTarget.addEventListener).toHaveBeenCalledWith('keydown', listener, true)

    cleanup()
    expect(eventTarget.removeEventListener).toHaveBeenCalledWith('keydown', listener, true)
  })
})
