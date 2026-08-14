import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../server/app.js'

let server
let origin

beforeAll(async () => {
  const maintenanceRunner = {
    async run() { throw new Error('not authorized: mongodb://user:secret@private') },
  }
  const app = createApp({ maintenanceRunner, machineSecret: 'maintenance-machine-secret' })
  server = await new Promise((resolve) => { const listener = app.listen(0, () => resolve(listener)) })
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
})

describe('maintenance failure logging', () => {
  it('does not expose wrong-role Mongo details in logs or the response', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const response = await fetch(`${origin}/api/internal/maintenance/purge-audit-ip-hmac`, {
        headers: { Authorization: 'Bearer maintenance-machine-secret' },
      })
      const payload = await response.json()
      expect(response.status).toBe(500)
      expect(payload.error).toEqual(expect.objectContaining({ code: 'internal_error', message: 'Internal server error' }))
      expect(logError).toHaveBeenCalledWith('Unhandled request error', expect.objectContaining({ requestId: expect.any(String) }))
      expect(JSON.stringify([payload, logError.mock.calls])).not.toContain('secret')
      expect(JSON.stringify([payload, logError.mock.calls])).not.toContain('mongodb://')
    } finally { logError.mockRestore() }
  })
})
