import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('App integration boundary', () => {
  it('mounts the public and admin feature roots from the App-owned session gate', () => {
    const source = readFileSync(join(process.cwd(), 'client', 'App.jsx'), 'utf8')
    expect(source).toContain("import PublicApp from './features/public/index.js'")
    expect(source).toContain("import AdminRedesign from './features/admin/ui/AdminShell.jsx'")
    expect(source).toMatch(/createApiClient\(\)/)
    expect(source).toMatch(/sessionSurface\(session\)/)
    expect(source).toMatch(/<AdminRedesign[\s\S]*api=\{adminApi\}[\s\S]*session=\{session\}/)
    expect(source).toMatch(
      /<PublicSurface[\s\S]*key=\{publicSessionKey\(publicSession\)\}[\s\S]*api=\{api\}/,
    )
    expect(source).toMatch(/function PublicSurface[\s\S]*usePublicIntegration[\s\S]*<PublicApp/)
  })

  it('keeps transport and credentials out of feature presentation code', () => {
    const roots = [
      join(process.cwd(), 'client', 'features', 'public'),
      join(process.cwd(), 'client', 'features', 'admin', 'ui'),
      join(process.cwd(), 'client', 'app', 'integration'),
    ]
    const files = []
    function collect(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) collect(path)
        else if (/\.(js|jsx)$/.test(entry.name)) files.push(path)
      }
    }
    roots.forEach(collect)
    const source = files.map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sessionStorage/)
    expect(source).not.toMatch(/password123|admin@techpulse|user@techpulse/i)
  })

  it('loads one final stylesheet from the Vite entry', () => {
    const source = readFileSync(join(process.cwd(), 'client', 'main.jsx'), 'utf8')
    expect(source).toContain("import './styles.css'")
  })
})
