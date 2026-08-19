import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readProjectFile = (path) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8')
const contentCss = readProjectFile('client/features/feed/content.css')
const rootCss = readProjectFile('client/styles.css')

describe('content visual tokens', () => {
  it('uses the approved destructive semantic tokens instead of duplicating danger colors', () => {
    expect(rootCss).toMatch(/--danger:\s*oklch\(0\.54\s*0\.16\s*30\);/)
    expect(rootCss).toMatch(/--danger-soft:\s*color-mix\(in\s*oklch,\s*var\(--danger\)\s*12%,\s*transparent\);/)
    expect(contentCss).toMatch(/\.content-button-danger\s*\{[^}]*color:\s*var\(--danger\);[^}]*background:\s*var\(--danger-soft\);/s)
    expect(contentCss).toMatch(/\.content-mutation-error\s*\{[^}]*color:\s*var\(--danger\);[^}]*background:\s*var\(--danger-soft\);/s)
    expect(contentCss).toMatch(/\.content-field-error\s*\{[^}]*color:\s*var\(--danger\);/s)
  })

  it('keeps major reader surfaces on the approved surface radius token', () => {
    for (const selector of ['.content-card {', '.content-filter-rail,', '.content-state {']) {
      const start = contentCss.indexOf(selector)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(contentCss.slice(start, start + 340)).toContain('border-radius: var(--radius);')
    }
  })
})
