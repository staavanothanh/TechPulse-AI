import { request as httpRequest } from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { createApp } from '../../server/app.js'

const app = createApp({ machineSecret: 'test-machine-secret' })

let server
let origin

beforeAll(async () => {
  server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance))
  })
  origin = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))))

describe('GET /api/v1/health', () => {
  it('returns the canonical health envelope and request id', async () => {
    const response = await fetch(`${origin}/api/v1/health`)
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.data.status).toBe('ok')
    expect(payload.data.timestamp).toMatch(/Z$/)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()

    const document = loadOpenApi()
    document.$id = 'techpulse-openapi'
    const ajv = new Ajv({ strict: false })
    addFormats(ajv)
    ajv.addSchema(document)
    const validate = ajv.compile({ $ref: 'techpulse-openapi#/components/schemas/HealthResponse' })
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true)
  })

  it('returns the canonical error envelope for an unknown route', async () => {
    const response = await fetch(`${origin}/api/v1/not-found`)
    const payload = await response.json()
    expect(response.status).toBe(404)
    expect(payload.error.code).toBe('not_found')
    expect(payload.error.requestId).toBeTruthy()
  })

  it('rejects unknown query parameters before the handler', async () => {
    const response = await fetch(`${origin}/api/v1/health?unexpected=value`)
    const payload = await response.json()
    expect(response.status).toBe(400)
    expect(payload.error.code).toBe('bad_request')
  })

  it('rejects duplicate and pollution-shaped query values', async () => {
    const duplicate = await fetch(`${origin}/api/v1/articles?limit=1&limit=2`)
    const polluted = await fetch(`${origin}/api/v1/articles?q%5B%24gt%5D=secret`)
    expect(duplicate.status).toBe(400)
    expect(polluted.status).toBe(400)
  })

  it('rejects an oversized opaque path id before routing', async () => {
    const response = await fetch(`${origin}/api/v1/articles/${'a'.repeat(200)}`)
    expect(response.status).toBe(400)
  })

  it('rejects a path parameter value outside the documented enum', async () => {
    const response = await fetch(`${origin}/api/internal/maintenance/not-allowed`)
    expect(response.status).toBe(400)
  })

  it('requires the configured bearer secret on machine-only routes', async () => {
    const missing = await fetch(`${origin}/api/internal/cron/due-work`)
    const invalid = await fetch(`${origin}/api/internal/cron/due-work`, {
      headers: { Authorization: 'Bearer wrong-secret' },
    })
    const valid = await fetch(`${origin}/api/internal/cron/due-work`, {
      headers: { Authorization: 'Bearer test-machine-secret' },
    })
    expect(missing.status).toBe(401)
    expect(invalid.status).toBe(401)
    expect(valid.status).toBe(404)
  })

  it('rejects hostile Origin, non-JSON bodies, compressed bodies and oversized JSON', async () => {
    const hostileOrigin = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: '{}',
    })
    const plainText = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'text/plain' },
      body: '{}',
    })
    const compressed = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        Origin: 'http://localhost:3000',
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
      },
      body: '{}',
    })
    const missingOrigin = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const oversized = await fetch(`${origin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(70000) }),
    })
    expect(hostileOrigin.status).toBe(403)
    expect(missingOrigin.status).toBe(403)
    expect(plainText.status).toBe(415)
    expect(compressed.status).toBe(415)
    expect(oversized.status).toBe(413)
  })

  it('rejects an oversized chunked JSON body without trusting Content-Length', async () => {
    const address = server.address()
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/api/v1/auth/login',
          method: 'POST',
          headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
        },
        (incoming) => {
          let body = ''
          incoming.setEncoding('utf8')
          incoming.on('data', (chunk) => {
            body += chunk
          })
          incoming.on('end', () => resolve({ status: incoming.statusCode, body }))
        },
      )
      request.on('error', reject)
      request.write(`{"email":"a@example.com","password":"${'x'.repeat(40000)}`)
      request.end(`${'x'.repeat(40000)}"}`)
    })
    expect(response.status).toBe(413)
  })
})
