import { describe, expect, it, vi } from 'vitest'
import { scrollToDocumentTop } from '../../../client/features/public/components/scroll-top.js'

describe('public scroll-to-top control', () => {
  it('resets the document scroll root and window to the exact top', () => {
    const scrollingElement = { scrollTop: 840, scrollTo: vi.fn() }
    const documentElement = { scrollTop: 840, scrollTo: vi.fn() }
    const body = { scrollTop: 840 }
    const windowObject = { scrollTo: vi.fn() }

    scrollToDocumentTop({
      document: { scrollingElement, documentElement, body },
      window: windowObject,
      smooth: false,
    })

    expect(scrollingElement.scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    })
    expect(windowObject.scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    })
    expect(scrollingElement.scrollTop).toBe(0)
    expect(documentElement.scrollTop).toBe(0)
    expect(body.scrollTop).toBe(0)
  })

  it('falls back to direct scrollTop assignment when scroll APIs are unavailable', () => {
    const scrollingElement = { scrollTop: 240 }
    const windowObject = {}

    scrollToDocumentTop({
      document: { scrollingElement, documentElement: scrollingElement, body: scrollingElement },
      window: windowObject,
      smooth: false,
    })

    expect(scrollingElement.scrollTop).toBe(0)
  })

  it('resets an ancestor scroll host when the app is mounted inside a scroll container', () => {
    const scrollHost = { scrollTop: 540, scrollTo: vi.fn() }
    const button = { parentElement: scrollHost }

    scrollToDocumentTop({ target: button, document: {}, window: {}, smooth: false })

    expect(scrollHost.scrollTo).toHaveBeenCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    })
    expect(scrollHost.scrollTop).toBe(0)
  })

  it('animates to the top over a bounded frame sequence', () => {
    const scrollingElement = { scrollTop: 840, scrollTo: vi.fn() }
    const windowObject = { scrollY: 840, scrollTo: vi.fn() }
    const frames = []

    scrollToDocumentTop({
      document: { scrollingElement },
      window: windowObject,
      smooth: true,
      now: () => 100,
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
    })

    expect(frames).toHaveLength(1)
    frames.shift()(310)
    expect(windowObject.scrollTo).toHaveBeenCalledWith({
      top: expect.any(Number),
      left: 0,
      behavior: 'instant',
    })
    expect(frames).toHaveLength(1)
    frames.shift()(520)
    expect(scrollingElement.scrollTop).toBe(0)
    expect(windowObject.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      left: 0,
      behavior: 'instant',
    })
  })
})
