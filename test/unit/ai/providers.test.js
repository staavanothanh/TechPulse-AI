import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

describe('Step 9 providers focused gate', () => {
  it('keeps the empty static registry a safe text-only deployment state', () => {
    expect(validateProviderConfiguration([])).toEqual({ domains: [], routes: [] })
  })
})
