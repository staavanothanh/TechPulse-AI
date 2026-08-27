import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
const vercelConfig = JSON.parse(readFileSync(resolve(projectRoot, 'vercel.json'), 'utf8'))

function isCronExpression(value) {
  return (
    typeof value === 'string' &&
    value.trim().split(/\s+/).length === 5 &&
    value
      .trim()
      .split(/\s+/)
      .every((part) => /^[0-9*/?,-]+$/.test(part))
  )
}

describe('Vercel deployment contract', () => {
  it('builds the Vite client from the repository build command', () => {
    expect(vercelConfig.buildCommand).toBe('npm run build')
    expect(vercelConfig.outputDirectory).toBe('dist')
  })

  it('routes API subpaths directly to the single Express Vercel function', () => {
    const route = vercelConfig.routes?.find((entry) => entry.src === '^/api(?:/.*)?$')
    expect(route).toEqual(expect.objectContaining({ src: '^/api(?:/.*)?$', dest: '/api/index.js' }))
  })

  it('registers the protected due-work endpoint as a production cron', () => {
    const cron = vercelConfig.crons?.find((entry) => entry.path === '/api/internal/cron/due-work')
    expect(cron).toEqual(expect.objectContaining({ path: '/api/internal/cron/due-work' }))
    expect(isCronExpression(cron.schedule)).toBe(true)
    expect(cron.schedule).toBe('0 21 * * *')
  })

  it('allows the due-work function to run for the bounded five-minute drain window', () => {
    expect(vercelConfig.functions?.['api/index.js']).toEqual(expect.objectContaining({ maxDuration: 300 }))
  })
})
