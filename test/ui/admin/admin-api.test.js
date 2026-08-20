import { describe, expect, it, vi } from 'vitest'
import { createAdminReadApi } from '../../../client/features/admin/operations/admin-api.js'

describe('Step 11 admin read boundary', () => {
  it('serializes allowlisted filters/cursor and keeps Retry-After local to one invocation', async () => {
    const generatedApi = {
      listAdminArticles: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/articles', {})
        throw Object.assign(new Error('limited'), { status: 429 })
      }),
    }
    const fetchImpl = vi.fn(async (_input) => ({
      status: 429,
      headers: { get: (name) => (name === 'Retry-After' ? '12' : null) },
      clone: () => ({ json: async () => ({}) }),
    }))
    const api = createAdminReadApi(generatedApi, fetchImpl)
    await expect(
      api.listAdminArticles({
        query: {
          status: 'review-needed',
          sourceId: 's1',
          cursor: 'opaque',
          limit: 20,
          ignored: 'drop',
        },
      }),
    ).rejects.toMatchObject({ status: 429, retryAfter: 12 })
    expect(new URL(fetchImpl.mock.calls[0][0]).search).toBe(
      '?status=review-needed&sourceId=s1&cursor=opaque&limit=20',
    )
  })

  it('bounds invalid Retry-After instead of exposing arbitrary transport values', async () => {
    const generatedApi = {
      getAdminArticle: vi.fn(async ({ fetchImpl }) => {
        await fetchImpl('https://techpulse.test/api/v1/admin/articles/a1', {})
        throw Object.assign(new Error('limited'), { status: 429 })
      }),
    }
    const fetchImpl = vi.fn(async () => ({
      status: 429,
      headers: { get: () => '999999999999999999' },
      clone: () => ({ json: async () => ({}) }),
    }))
    const api = createAdminReadApi(generatedApi, fetchImpl)
    await expect(api.getAdminArticle({ pathParams: { articleId: 'a1' } })).rejects.toMatchObject({
      status: 429,
    })
    await expect(
      api.getAdminArticle({ pathParams: { articleId: 'a1' } }),
    ).rejects.not.toHaveProperty('retryAfter')
  })
})
