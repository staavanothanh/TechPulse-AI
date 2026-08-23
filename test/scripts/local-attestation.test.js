import { describe, expect, it, vi } from 'vitest'
import {
  ATTESTATION_ENV_KEY,
  COMMIT_ENV_KEY,
  formatLocalAttestationValue,
  runLocalAttestation,
  updateDotEnvText,
} from '../../scripts/update-local-attestation.js'

const COMMIT = 'a'.repeat(40)
const REGISTRY = JSON.stringify({ 'auth-core': { payload: { scope: 'auth-core' }, signature: 'sig' } })

describe('local schema attestation updater', () => {
  it('replaces stale values and removes duplicate assignments without touching other settings', () => {
    const input = [
      'MONGODB_DATABASE=techpulse_app',
      `${COMMIT_ENV_KEY}=old-commit`,
      `${ATTESTATION_ENV_KEY}='old-json'`,
      `${ATTESTATION_ENV_KEY}='duplicate-old-json'`,
      'ORIGIN_ALLOWLIST=http://localhost:3000',
      '',
    ].join('\n')

    const output = updateDotEnvText(input, { commit: COMMIT, value: REGISTRY })

    expect(output).toContain('MONGODB_DATABASE=techpulse_app')
    expect(output).toContain('ORIGIN_ALLOWLIST=http://localhost:3000')
    expect(output).toContain(`${COMMIT_ENV_KEY}=${COMMIT}`)
    expect(output).toContain(`${ATTESTATION_ENV_KEY}='${REGISTRY}'`)
    expect(output.match(new RegExp(`^${ATTESTATION_ENV_KEY}=`, 'gm'))).toHaveLength(1)
    expect(output).not.toContain('old-json')
    expect(output.endsWith('\n')).toBe(true)
  })

  it('formats only a single-line, quoted JSON assignment', () => {
    expect(formatLocalAttestationValue(REGISTRY)).toBe(`${ATTESTATION_ENV_KEY}='${REGISTRY}'`)
    expect(() => formatLocalAttestationValue('value\nwith-newline')).toThrow(/single line/i)
    expect(() => formatLocalAttestationValue("value'with-quote")).toThrow(/single quote/i)
  })

  it('generates the registry before writing .env and returns no secret payload', async () => {
    const generateRegistry = vi.fn(async ({ commit }) => ({
      registry: { 'auth-core': { payload: { commit } } },
      value: REGISTRY,
    }))
    const readFileImpl = vi.fn(async () => `${COMMIT_ENV_KEY}=old\n`)
    const writeFileImpl = vi.fn(async () => undefined)

    const result = await runLocalAttestation({
      commit: COMMIT,
      environment: { TEST_FLAG: 'keep' },
      generateRegistry,
      readFileImpl,
      writeFileImpl,
    })

    expect(generateRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ commit: COMMIT, environment: { TEST_FLAG: 'keep' } }),
    )
    expect(writeFileImpl).toHaveBeenCalledTimes(1)
    expect(writeFileImpl.mock.calls[0][1]).toContain(`${COMMIT_ENV_KEY}=${COMMIT}`)
    expect(writeFileImpl.mock.calls[0][1]).toContain(`${ATTESTATION_ENV_KEY}='${REGISTRY}'`)
    expect(result).toEqual({ commit: COMMIT, updated: true })
    expect(JSON.stringify(result)).not.toContain(REGISTRY)
  })
})
