import { describe, expect, it } from 'vitest'

const enabled = process.env.E2E_VERCEL_ENABLED === 'true'
const vercelHost = enabled ? describe : describe.skip
const baseUrl = process.env.E2E_BASE_URL
const origin = process.env.E2E_ORIGIN || baseUrl
const cronSecret = process.env.E2E_CRON_SECRET

if (process.env.E2E_RUNNER_ENFORCE === 'true' && !enabled)
  throw new Error(
    'The Vercel Preview E2E runner requires E2E_VERCEL_ENABLED=true; refusing a skipped suite',
  )

function assertConfigured() {
  expect(baseUrl, 'E2E_BASE_URL must point to a deployed Vercel Preview URL').toMatch(/^https:\/\//)
  expect(origin, 'E2E_ORIGIN must match the deployed Preview origin').toMatch(/^https:\/\//)
  expect(cronSecret, 'E2E_CRON_SECRET must match the Preview CRON_SECRET').toEqual(
    expect.any(String),
  )
  expect(cronSecret.length).toBeGreaterThanOrEqual(16)
}

function protectionHeaders() {
  const raw = process.env.E2E_VERCEL_PROTECTION_HEADERS_JSON
  if (!raw) return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('E2E_VERCEL_PROTECTION_HEADERS_JSON must be valid JSON')
  }
  if (
    !parsed ||
    Array.isArray(parsed) ||
    typeof parsed !== 'object' ||
    Object.entries(parsed).some(([, value]) => typeof value !== 'string')
  ) {
    throw new Error('E2E_VERCEL_PROTECTION_HEADERS_JSON must be a JSON object with string values')
  }
  return parsed
}

function assertPreviewAccess(result) {
  if ([401, 403].includes(result.response.status)) {
    throw new Error(
      'Vercel Preview Deployment Protection blocked the E2E request. Keep protection enabled and provide provider-issued authenticated headers through E2E_VERCEL_PROTECTION_HEADERS_JSON; never disable protection for this test.',
    )
  }
  if (
    typeof result.payload === 'string' &&
    /deployment protection|vercel authentication|log in to vercel/i.test(result.payload)
  ) {
    throw new Error(
      'Vercel Preview returned a Deployment Protection page. Keep protection enabled and provide provider-issued authenticated headers through E2E_VERCEL_PROTECTION_HEADERS_JSON; never disable protection for this test.',
    )
  }
}

async function request(path, init = {}) {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    ...init,
    headers: { Accept: 'application/json', ...protectionHeaders(), ...(init.headers ?? {}) },
  })
  const contentType = response.headers.get('content-type') ?? ''
  const payload = contentType.includes('json') ? await response.json() : await response.text()
  return { response, payload }
}

vercelHost('Vercel Preview API and Cron smoke', () => {
  it('serves health through the deployed API function', async () => {
    assertConfigured()
    const result = await request('/api/v1/health')
    assertPreviewAccess(result)
    expect(result.response.status).toBe(200)
    expect(result.payload.data.status).toBe('ok')
    expect(result.payload.data.timestamp).toMatch(/Z$/)
  })

  it('keeps the due-work route machine-only', async () => {
    assertConfigured()
    const missing = await request('/api/internal/cron/due-work')
    const invalid = await request('/api/internal/cron/due-work', {
      headers: { Authorization: 'Bearer invalid-preview-secret' },
    })
    expect(missing.response.status).toBe(401)
    expect(invalid.response.status).toBe(401)
  })

  it('executes the protected due-work route with the Preview machine secret', async () => {
    assertConfigured()
    const result = await request('/api/internal/cron/due-work', {
      headers: { Authorization: `Bearer ${cronSecret}`, 'User-Agent': 'vercel-cron/1.0' },
    })
    expect(result.response.status).toBe(202)
    expect(result.payload.data).toEqual(
      expect.objectContaining({ runId: expect.any(String), queues: expect.any(Object) }),
    )
    expect(result.response.headers.get('cache-control')).toMatch(/no-store/)
  })
})
