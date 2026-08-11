import { describe, expect, it } from 'vitest'
import { createDevViteOptions } from '../../server/dev-vite.js'

describe('Vite development transport', () => {
  it('binds HMR upgrades to the Express HTTP server instead of a fallback port', () => {
    const httpServer = { on() {} }
    const options = createDevViteOptions(httpServer)
    expect(options.server.middlewareMode).toBe(true)
    expect(options.server.hmr).toEqual({ server: httpServer })
  })
})
