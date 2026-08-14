import { describe, expect, it } from 'vitest'
import { loadOpenApi } from '../../scripts/contracts/openapi-utils.js'
import { runAdminGovernanceContractFixtures } from '../../scripts/contracts/admin-governance-fixtures.js'

const document = loadOpenApi()

describe('Step 11 admin governance OpenAPI runtime contract', () => {
  it('validates canonical success and error responses across every governance surface', async () => {
    const result = await runAdminGovernanceContractFixtures({ document })

    expect(result.cases).toBeGreaterThanOrEqual(28)
  })

  it('rejects the unresolved post-PII-retention detail branch without inventing a DTO', () => {
    const detail = document.components.schemas.TakedownRequest

    expect(detail.required).toEqual(expect.arrayContaining(['requesterName', 'requesterContact', 'reason']))
    expect(detail.properties.requesterName.type).toBe('string')
    expect(detail.properties.requesterContact.type).toBe('string')
    expect(detail.properties.reason.type).toBe('string')
  })
})
