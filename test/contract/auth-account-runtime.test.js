import { describe, expect, it } from 'vitest'
import { runAuthAccountContractFixtures } from '../../scripts/contracts/auth-account-fixtures.js'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'

describe('auth/account contract runtime fixtures', () => {
  it('validates runtime success and canonical error envelopes for every Step 2 auth/account operation', async () => {
    const result = await runAuthAccountContractFixtures({ document: loadOpenApi() })
    expect(result).toEqual(expect.objectContaining({ cases: expect.any(Number) }))
    expect(result.cases).toBeGreaterThanOrEqual(10)
  })
})
