import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { appendSessionPage, boundedQaCooldown, firstQaFieldError } from '../../../client/features/qa/qa-validation.js'

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')

describe('Step 10 independent-review UI regressions', () => {
  it('appends opaque session pages without parsing or duplicating rows', () => {
    expect(appendSessionPage([{ id: 's1' }], [{ id: 's1' }, { id: 's2' }])).toEqual([{ id: 's1' }, { id: 's2' }])
  })

  it('bounds Retry-After for Q&A mutations', () => {
    expect(boundedQaCooldown({ status: 429, retryAfter: 9999 })).toBe(300)
    expect(boundedQaCooldown({ status: 429, retryAfter: 17 })).toBe(17)
    expect(boundedQaCooldown({ status: 429 })).toBe(60)
    expect(boundedQaCooldown({ status: 503, retryAfter: 17 })).toBe(0)
  })

  it('uses stable form order when focusing a 422 field', () => {
    expect(firstQaFieldError({ topics: 'x', question: 'y' })).toBe('question')
    expect(firstQaFieldError({ publishedBefore: 'x', publishedAfter: 'y' })).toBe('publishedAfter')
  })

  it('routes all Q&A 401 failures through the existing session-expired callback', () => {
    const workspace = read('client/features/feed/ContentWorkspace.jsx')
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(workspace).toMatch(/GroundedQaScreen[^>]+onSessionExpired=/s)
    expect(screen).toContain('handleSessionExpired')
    expect(screen.match(/handleSessionExpired\(nextError\)/g)).toHaveLength(4)
    expect(screen).toMatch(/current\.kind === 'clear'[\s\S]*api\.clearSessions[\s\S]*api\.deleteSession/)
  })

  it('keeps delete confirmation mounted and busy until the request settles', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(screen).toMatch(/aria-busy=\{deletePending \|\| undefined\}/)
    expect(screen).toMatch(/disabled=\{deletePending\}/)
    expect(screen).not.toMatch(/async function executeDelete\(\) \{[\s\S]{0,120}setConfirm\(null\)/)
    expect(screen).toContain('disabled={deletePending || currentDeleteCooldown > 0}')
  })

  it('keeps only the workspace live region and adds explicit focus targets', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    const progress = read('client/features/qa/GenerationProgress.jsx')
    expect(screen).not.toContain('aria-live=')
    expect(progress).not.toContain('aria-live=')
    expect(screen).toContain('conversationHeadingRef')
    expect(screen).toContain('resultHeadingRef')
  })

  it('uses a five-column single-row mobile nav and wraps long session titles', () => {
    const contentCss = read('client/features/feed/content.css')
    const qaCss = read('client/styles.css')
    expect(contentCss).toMatch(/grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/)
    expect(contentCss).toMatch(/padding-bottom:\s*76px/)
    expect(qaCss).toMatch(/\.qa-session-select strong[^}]*overflow-wrap:\s*anywhere/s)
    expect(qaCss).not.toMatch(/\.qa-session-select strong[^}]*white-space:\s*nowrap/s)
  })

  it('does not expose a duplicate history trigger while the tablet rail is permanent', () => {
    const css = read('client/styles.css')
    expect(css).toMatch(/@media \(max-width:\s*1000px\)[\s\S]*?\.qa-history-action\s*\{\s*display:\s*none;/)
    expect(css).toMatch(/@media \(max-width:\s*1000px\)[\s\S]*?\.qa-rail-modal\s*\{[^}]*position:\s*static;[^}]*display:\s*block;/)
    expect(css).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.qa-history-action\s*\{\s*display:\s*inline-flex;/)
    expect(css).toMatch(/@media \(max-width:\s*600px\)[\s\S]*?\.qa-history-scrim\s*\{[^}]*position:\s*fixed;[^}]*display:\s*none;/)
  })

  it('opens and focuses the compact scope dialog for server 422 fields', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(screen).toContain('focusInvalidField(first)')
    expect(screen).toMatch(/focusInvalidField = useCallback[\s\S]*setScopeOpen\(true\)[\s\S]*qa-dialog/)
  })

  it('fences stale selection responses and locks selection while an answer is pending', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(screen).toContain('selectionRequestRef')
    expect(screen).toMatch(/requestId !== selectionRequestRef\.current/)
    expect(screen).toMatch(/selectionLocked=\{Boolean\(phase\)\}/)
  })

  it('uses a true modal history backdrop and focuses visible 404 and clear targets', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(screen).toContain('qa-history-scrim')
    expect(screen).toContain('emptyHeadingRef')
    expect(screen).toContain('focusListDestination')
  })

  it('keeps citation close callback stable across parent renders', () => {
    const screen = read('client/features/qa/GroundedQaScreen.jsx')
    expect(screen).toContain('closeCitation = useCallback')
    expect(screen).toContain('onClose={closeCitation}')
  })
})
