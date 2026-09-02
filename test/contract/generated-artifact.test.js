import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApiClient, operations } from '../../shared/generated/api-client.js'

describe('generated contract boundary', () => {
  it('publishes the generated client and schema artifacts', () => {
    expect(fs.existsSync('shared/generated/api-client.js')).toBe(true)
    expect(fs.existsSync('shared/generated/api-schema.js')).toBe(true)
  })

  it('requires every contract-declared header before calling the provider', async () => {
    let calls = 0
    const client = createApiClient({
      fetchImpl: async () => {
        calls += 1
        return new Response(JSON.stringify({ data: {} }), { status: 200 })
      },
    })

    await expect(client.createGroundedAnswer({ body: '{}', headers: { Origin: 'http://localhost:3000' } })).rejects.toThrow(
      'Missing required header: X-CSRF-Token',
    )
    expect(calls).toBe(0)

    await expect(
      client.createGroundedAnswer({
        body: '{}',
        headers: { Origin: 'http://localhost:3000', 'X-CSRF-Token': 'csrf' },
      }),
    ).rejects.toThrow('Missing required header: Idempotency-Key')
    expect(calls).toBe(0)
  })

  it('sends a grounded answer when all required headers are present', async () => {
    let request
    const client = createApiClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl: async (url, init) => {
        request = { url: String(url), init }
        return new Response(JSON.stringify({ data: { answer: 'ok' } }), { status: 200 })
      },
    })

    await expect(
      client.createGroundedAnswer({
        body: '{}',
        headers: {
          'X-CSRF-Token': 'csrf',
          'Idempotency-Key': 'answer-12345678',
        },
      }),
    ).resolves.toEqual({ data: { answer: 'ok' } })
    expect(request.url).toBe('http://localhost:3000/api/v1/answers')
    expect(request.init.method).toBe('POST')
    expect(request.init.headers.Origin).toBeUndefined()
    const answerOperation = operations.find(({ operationId }) => operationId === 'createGroundedAnswer')
    expect(answerOperation.requiredHeaders).toEqual(['X-CSRF-Token', 'Idempotency-Key'])
    expect(answerOperation.browserManagedHeaders).toEqual(['Origin'])
    const articleOperation = operations.find(({ operationId }) => operationId === 'updateAdminArticle')
    expect(articleOperation.requiredHeaders).toEqual(['X-CSRF-Token', 'Idempotency-Key'])
  })

  it('requires bearer auth for generated machine operations', async () => {
    const client = createApiClient({ fetchImpl: async () => new Response('{}', { status: 200 }) })
    await expect(client.runDueWork()).rejects.toThrow('Missing required header: Authorization')
  })

  it('encodes generated path parameters instead of leaving placeholders in the URL', async () => {
    let requestedUrl
    const client = createApiClient({
      baseUrl: 'http://localhost:3000',
      fetchImpl: async (url) => {
        requestedUrl = String(url)
        return new Response(JSON.stringify({ data: {} }), { status: 200 })
      },
    })

    await client.getArticle({ pathParams: { articleId: 'a/b' } })
    expect(requestedUrl).toBe('http://localhost:3000/api/v1/articles/a%2Fb')
  })
})
