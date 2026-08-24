import { describe, expect, it } from 'vitest'
import { loadOpenApi, runContractChecks } from '../../scripts/contracts/openapi-utils.js'

describe('canonical OpenAPI inventory', () => {
  it('closes persistence and body-response completeness for all operations', () => {
    const result = runContractChecks(loadOpenApi())
    expect(result.failures).toEqual([])
    expect(result.operations).toHaveLength(58)
  })

  it('rejects an operation without x-persistence', () => {
    const document = structuredClone(loadOpenApi())
    delete document.paths['/api/v1/health'].get['x-persistence']
    expect(runContractChecks(document).failures).toContain('getHealth must declare x-persistence none|mongo')
  })

  it('rejects a mongo operation without a 503 response', () => {
    const document = structuredClone(loadOpenApi())
    delete document.paths['/api/v1/auth/login'].post.responses['503']
    expect(runContractChecks(document).failures).toContain('login missing 503 for mongo persistence')
  })

  it.each(['400', '413', '415'])('rejects a JSON-body operation without %s', (status) => {
    const document = structuredClone(loadOpenApi())
    delete document.paths['/api/v1/auth/login'].post.responses[status]
    expect(runContractChecks(document).failures).toContain(`login missing ${status}`)
  })
})
