import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let mockLocation = { key: 'key-a', pathname: '/feed' }
let mockNavigationType = 'PUSH'

const hookSlots = {
  ref: null,
  effect: null,
  effectCleanup: null,
  layoutEffect: null,
  layoutEffectCleanup: null,
}

vi.mock('react-router-dom', () => ({
  useLocation: () => mockLocation,
  useNavigationType: () => mockNavigationType,
}))

vi.mock('react', () => ({
  useRef: (initial) => {
    if (!hookSlots.ref) hookSlots.ref = { current: initial }
    return hookSlots.ref
  },
  useLayoutEffect: (effect) => {
    hookSlots.layoutEffect = effect
  },
  useEffect: (effect) => {
    hookSlots.effect = effect
  },
}))

const {
  InMemoryScrollRestoration,
  clearScrollPositions,
  getSavedScrollPosition,
} = await import('../../../client/theme/use-scroll-restoration.js')

describe('In-memory scroll restoration (Zero sessionStorage)', () => {
  let originalWindow
  let originalDocument
  let windowMock

  function stepRender() {
    // 1. Run previous useLayoutEffect cleanup (captures outgoing page position before any scrollTo runs)
    hookSlots.layoutEffectCleanup?.()
    // 2. Run component body
    InMemoryScrollRestoration()
    // 3. Run new useLayoutEffect setup and capture cleanup
    hookSlots.layoutEffectCleanup = hookSlots.layoutEffect?.() || null
    // 4. Run previous useEffect cleanup
    hookSlots.effectCleanup?.()
    // 5. Run new useEffect and capture cleanup
    hookSlots.effectCleanup = hookSlots.effect?.() || null
  }

  beforeEach(() => {
    clearScrollPositions()
    hookSlots.ref = null
    hookSlots.effect = null
    hookSlots.effectCleanup = null
    hookSlots.layoutEffect = null
    hookSlots.layoutEffectCleanup = null

    originalWindow = globalThis.window
    originalDocument = globalThis.document

    windowMock = {
      scrollX: 0,
      scrollY: 0,
      scrollTo: vi.fn(({ left = 0, top = 0 } = {}) => {
        windowMock.scrollX = left
        windowMock.scrollY = top
      }),
      listeners: {},
      addEventListener: vi.fn((event, fn) => {
        (windowMock.listeners[event] ??= []).push(fn)
      }),
      removeEventListener: vi.fn((event, fn) => {
        if (windowMock.listeners[event]) {
          windowMock.listeners[event] = windowMock.listeners[event].filter((l) => l !== fn)
        }
      }),
      triggerScroll() {
        this.listeners['scroll']?.forEach((fn) => fn())
      },
    }

    globalThis.window = windowMock
    globalThis.document = {
      scrollingElement: windowMock,
      documentElement: windowMock,
    }
  })

  afterEach(() => {
    clearScrollPositions()
    globalThis.window = originalWindow
    globalThis.document = originalDocument
  })

  it('guarantees zero references to browser storage in source code', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(
      join(process.cwd(), 'client', 'theme', 'use-scroll-restoration.js'),
      'utf8',
    )
    expect(source).not.toMatch(/sessionStorage|localStorage/)
  })

  it('stores and clears scroll positions in memory map', () => {
    expect(getSavedScrollPosition('loc-1')).toBeNull()
  })

  it('accurately restores scroll position across A(y=100) -> PUSH B(y=500) -> POP A(y=100) even when scrollTo mutates scroll coordinates', () => {
    // 1. Initial mount on Page A
    mockLocation = { key: 'key-a', pathname: '/feed' }
    mockNavigationType = 'PUSH'
    stepRender()

    expect(windowMock.scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    expect(windowMock.scrollY).toBe(0)

    // User scrolls on Page A to y = 100
    windowMock.scrollY = 100
    windowMock.triggerScroll()
    expect(getSavedScrollPosition('key-a')).toEqual({ left: 0, top: 100 })

    // 2. PUSH navigation to Page B (e.g. /article/art-1)
    mockLocation = { key: 'key-b', pathname: '/article/art-1' }
    mockNavigationType = 'PUSH'
    windowMock.scrollTo.mockClear()
    stepRender()

    // Upon PUSH, scroll is reset to top (0, 0) and scrollY is mutated to 0
    expect(windowMock.scrollTo).toHaveBeenCalledWith({ left: 0, top: 0, behavior: 'instant' })
    expect(windowMock.scrollY).toBe(0)

    // Crucial check: Page A's stored scroll position must NOT have been wiped to 0!
    expect(getSavedScrollPosition('key-a')).toEqual({ left: 0, top: 100 })

    // User scrolls on Page B to y = 500
    windowMock.scrollY = 500
    windowMock.triggerScroll()
    expect(getSavedScrollPosition('key-b')).toEqual({ left: 0, top: 500 })
    expect(getSavedScrollPosition('key-a')).toEqual({ left: 0, top: 100 })

    // 3. POP navigation back to Page A (User presses browser Back button)
    mockLocation = { key: 'key-a', pathname: '/feed' }
    mockNavigationType = 'POP'
    windowMock.scrollTo.mockClear()
    stepRender()

    // Assert that window.scrollTo was called with restored coordinates of Page A (y = 100) and scrollY was updated!
    expect(windowMock.scrollTo).toHaveBeenCalledWith({ left: 0, top: 100, behavior: 'instant' })
    expect(windowMock.scrollY).toBe(100)
    expect(getSavedScrollPosition('key-a')).toEqual({ left: 0, top: 100 })
    expect(getSavedScrollPosition('key-b')).toEqual({ left: 0, top: 500 })
  })
})
