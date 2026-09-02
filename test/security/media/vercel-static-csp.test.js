import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')
const vercelConfig = JSON.parse(readFileSync(resolve(projectRoot, 'vercel.json'), 'utf8'))
const donateSources = ['/donate', '/donate/']
const expectedCsp = "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' https://img.vietqr.io"

function cspRules() {
  return (vercelConfig.headers ?? []).filter((entry) =>
    entry.headers?.some(({ key }) => key.toLowerCase() === 'content-security-policy'),
  )
}

function cspValueFor(source) {
  return cspRules()
    .find((entry) => entry.source === source)
    ?.headers.find(({ key }) => key.toLowerCase() === 'content-security-policy')?.value
}

describe('Vercel static Donate CSP', () => {
  it('declares the exact strict policy for clean and trailing-slash Donate paths', () => {
    expect(cspRules().map(({ source }) => source).sort()).toEqual([...donateSources].sort())

    for (const source of donateSources) {
      expect(cspValueFor(source)).toBe(expectedCsp)
    }
  })

  it('rejects wildcard, insecure, credentialed, and blanket HTTPS image sources', () => {
    for (const source of donateSources) {
      const policy = cspValueFor(source)
      expect(policy).toBe(expectedCsp)
      expect(policy).not.toContain('*')
      expect(policy).not.toContain('http://')
      expect(policy).not.toMatch(/(^|[;\s])https:(?=$|[;\s])/)
      expect(policy).not.toMatch(/(^|[;\s])[^;\s]*@/)
    }
  })

  it('leaves API and filesystem route precedence unchanged', () => {
    expect(vercelConfig.routes).toEqual([
      { src: '^/api(?:/.*)?$', dest: '/api/index.js' },
      { handle: 'filesystem' },
      { src: '/.*', dest: '/index.html' },
    ])
  })
})
