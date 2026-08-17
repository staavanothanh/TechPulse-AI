import { describe, expect, it } from 'vitest'
import handler from '../../api/index.js'

describe('Vercel API entrypoint', () => {
  it('exports a Node-compatible request handler', () => {
    expect(handler).toBeTypeOf('function')
  })
})
