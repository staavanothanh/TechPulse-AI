import { describe, expect, it } from 'vitest'
import { validateLocalE2eEndpoints } from '../../scripts/local-e2e-config.js'

describe('local E2E endpoint configuration', () => {
  it('normalizes the localhost default', () => {
    expect(validateLocalE2eEndpoints()).toEqual({
      baseUrl: 'http://localhost:3000',
      origin: 'http://localhost:3000',
    })
  })

  it('rejects Preview URLs and mismatched Origin values', () => {
    expect(() => validateLocalE2eEndpoints({ baseUrl: 'https://techpulse-ai-preview.vercel.app', origin: 'https://techpulse-ai-preview.vercel.app' })).toThrow(/localhost/i)
    expect(() => validateLocalE2eEndpoints({ baseUrl: 'http://localhost:3000', origin: 'https://techpulse-ai-preview.vercel.app' })).toThrow(/match/i)
  })
})
