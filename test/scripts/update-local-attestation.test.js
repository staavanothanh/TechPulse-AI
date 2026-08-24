import { describe, expect, it, vi } from 'vitest'
import { runLocalAttestation } from '../../scripts/update-local-attestation.js'

const COMMIT = 'b'.repeat(40)

describe('local attestation refresh', () => {
  it('reuses a precomputed registry supplied by the pre-push hook', async () => {
    const readFileImpl = vi.fn(async () => 'PORT=3000\n')
    const writeFileImpl = vi.fn(async () => undefined)
    const generateRegistry = vi.fn()

    await expect(runLocalAttestation({
      commit: COMMIT,
      environment: {},
      generatedRegistry: { value: '{"auth-core":{}}' },
      generateRegistry,
      readFileImpl,
      writeFileImpl,
      envPath: 'C:/tmp/.env',
    })).resolves.toMatchObject({ commit: COMMIT, updated: true })

    expect(generateRegistry).not.toHaveBeenCalled()
    expect(writeFileImpl).toHaveBeenCalledWith(
      'C:/tmp/.env',
      expect.stringContaining(`SCHEMA_ATTESTATION_COMMIT=${COMMIT}`),
      'utf8',
    )
    expect(writeFileImpl.mock.calls[0][1]).toContain(`RUNTIME_SCHEMA_ATTESTATIONS_JSON='{"auth-core":{}}'`)
  })
})
