import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  ATTESTATION_SCOPES,
  ROLE_PROBE_SCOPES,
  buildAttestationRegistry,
  buildVerifierEnvironment,
  createVercelEnvironmentPayload,
  parsePrePushInput,
  parseVerifierOutput,
  runPrePushAttestation,
  updateVercelEnvironmentVariable,
} from '../../scripts/pre-push-attestation.js'

const COMMIT = 'a'.repeat(40)
const ZERO_SHA = '0'.repeat(40)

function hookInput({ ref = 'refs/heads/main', sha = COMMIT } = {}) {
  return `${ref} ${sha} ${ref} ${ZERO_SHA}\n`
}

function verifierResult(scope) {
  return {
    verified: true,
    runtimeSchemaAttestation: {
      payload: { scope, commit: COMMIT, generation: `${scope}-v1` },
      signature: `signature-${scope}`,
    },
  }
}

describe('pre-push release attestation', () => {
  it('maps main pushes to production and other branch pushes to preview', () => {
    expect(parsePrePushInput(hookInput())).toEqual({
      branch: 'main',
      commit: COMMIT,
      target: 'production',
    })
    expect(parsePrePushInput(hookInput({ ref: 'refs/heads/feature/release-gate' }))).toEqual({
      branch: 'feature/release-gate',
      commit: COMMIT,
      target: 'preview',
    })
    expect(
      parsePrePushInput(
        'refs/heads/feature/release-gate aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main 0000000000000000000000000000000000000000\n',
      ),
    ).toMatchObject({
      branch: 'main',
      target: 'production',
    })
  })

  it('skips tag-only and delete pushes, but rejects multiple branch updates', () => {
    expect(parsePrePushInput(hookInput({ ref: 'refs/tags/v1.0.0' }))).toBeNull()
    expect(parsePrePushInput(hookInput({ sha: ZERO_SHA }))).toBeNull()
    expect(() =>
      parsePrePushInput(`${hookInput()}${hookInput({ ref: 'refs/heads/other' })}`),
    ).toThrow(/one branch/i)
  })

  it('pins verifier children to the pushed commit and never keeps a Vercel SHA override', () => {
    const environment = buildVerifierEnvironment({
      environment: {
        SCHEMA_ATTESTATION_COMMIT: 'old-commit',
        VERCEL_GIT_COMMIT_SHA: 'old-commit',
        TEST_FLAG: 'keep',
      },
      commit: COMMIT,
    })
    expect(environment.SCHEMA_ATTESTATION_COMMIT).toBe(COMMIT)
    expect(environment.VERCEL_GIT_COMMIT_SHA).toBeUndefined()
    expect(environment.TEST_FLAG).toBe('keep')
  })

  it('parses the final JSON line without exposing verifier output', () => {
    expect(
      parseVerifierOutput(`warning\n${JSON.stringify(verifierResult('auth-core'))}\n`, 'auth-core'),
    ).toEqual(verifierResult('auth-core'))
    expect(() => parseVerifierOutput('{"verified":false}\n', 'auth-core')).toThrow(
      /failed.*auth-core/i,
    )
  })

  it('builds one registry containing every required scope and rejects omissions', () => {
    expect(ATTESTATION_SCOPES.length).toBeGreaterThanOrEqual(8)
    const results = ATTESTATION_SCOPES.map((scope) => verifierResult(scope))
    const registry = buildAttestationRegistry(results)
    expect(Object.keys(registry)).toEqual([...ATTESTATION_SCOPES])
    expect(registry['auth-core'].payload.commit).toBe(COMMIT)
    expect(() => buildAttestationRegistry(results.slice(1))).toThrow(/missing.*auth-core/i)
  })

  it('keeps role probing explicit for scopes with registered live probes', () => {
    expect(ROLE_PROBE_SCOPES).toEqual(
      expect.arrayContaining([
        'auth-core',
        'sources',
        'provider-routing-v2',
        'chat-sessions',
        'qa-evidence-fence',
        'governance',
      ]),
    )
    expect(ROLE_PROBE_SCOPES).not.toContain('durable-jobs')
  })

  it('runs scopes sequentially, then updates only the selected Vercel environment', async () => {
    const calls = []
    const updateVercel = vi.fn(async (input) => calls.push(input))
    const updateLocal = vi.fn(async (input) => calls.push({ local: true, ...input }))
    const runVerifier = vi.fn(async ({ scope }) => verifierResult(scope))
    const result = await runPrePushAttestation({
      input: hookInput(),
      environment: { PREPUSH_VERCEL_UPDATE: 'true' },
      scopes: ['auth-core', 'sources'],
      runVerifier,
      updateVercel,
      updateLocal,
    })
    expect(runVerifier.mock.calls.map(([input]) => input.scope)).toEqual(['auth-core', 'sources'])
    expect(calls).toHaveLength(2)
    expect(calls[0].target).toBe('production')
    expect(calls[0].value).toContain('"auth-core"')
    expect(calls[1]).toMatchObject({ local: true, commit: COMMIT, value: calls[0].value })
    expect(result).toMatchObject({ branch: 'main', commit: COMMIT, target: 'production' })
  })

  it('blocks the push when local attestation cannot be written', async () => {
    await expect(runPrePushAttestation({
      input: hookInput(),
      environment: { PREPUSH_VERCEL_UPDATE: 'true' },
      scopes: ['auth-core'],
      runVerifier: vi.fn(async ({ scope }) => verifierResult(scope)),
      updateVercel: vi.fn(async () => undefined),
      updateLocal: vi.fn(async () => { throw new Error('local attestation write failed') }),
    })).rejects.toThrow(/local attestation write failed/i)
  })

  it('fails closed when Vercel update is disabled or fails', async () => {
    const options = {
      input: hookInput(),
      environment: {},
      scopes: ['auth-core'],
      runVerifier: vi.fn(async ({ scope }) => verifierResult(scope)),
      updateVercel: vi.fn(),
    }
    await expect(runPrePushAttestation(options)).rejects.toThrow(/PREPUSH_VERCEL_UPDATE/i)
    await expect(
      runPrePushAttestation({
        ...options,
        environment: { PREPUSH_VERCEL_UPDATE: 'true' },
        updateVercel: vi.fn(async () => {
          throw new Error('vercel update failed')
        }),
      }),
    ).rejects.toThrow(/vercel update failed/i)
  })

  it('creates an encrypted Vercel environment payload without adding private release keys', () => {
    const payload = createVercelEnvironmentPayload({
      key: 'RUNTIME_SCHEMA_ATTESTATIONS_JSON',
      value: '{"auth-core":{}}',
      target: 'preview',
    })
    expect(payload).toEqual({
      key: 'RUNTIME_SCHEMA_ATTESTATIONS_JSON',
      value: '{"auth-core":{}}',
      type: 'encrypted',
      target: ['preview'],
    })
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_KEY|MONGODB_URI/i)
  })

  it('updates an existing Vercel variable without reading or printing its value', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          envs: [
            {
              id: 'env_1',
              key: 'RUNTIME_SCHEMA_ATTESTATIONS_JSON',
              target: ['production'],
              type: 'sensitive',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    const result = await updateVercelEnvironmentVariable({
      environment: {
        VERCEL_API_TOKEN: 'synthetic-token',
        PREPUSH_VERCEL_PROJECT_ID: 'prj_test',
        PREPUSH_VERCEL_TEAM_ID: 'team_test',
      },
      target: 'production',
      value: '{"auth-core":{}}',
      fetchImpl,
    })
    expect(result).toMatchObject({ updated: true, target: 'production', projectId: 'prj_test' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toContain('decrypt=false')
    expect(fetchImpl.mock.calls[0][0]).toContain('teamId=team_test')
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-token')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      value: '{"auth-core":{}}',
      target: ['production'],
    })
  })

  it('creates a new Vercel variable when the target has no record', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ envs: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    await expect(
      updateVercelEnvironmentVariable({
        environment: { VERCEL_API_TOKEN: 'synthetic-token', PREPUSH_VERCEL_PROJECT_ID: 'prj_test' },
        target: 'preview',
        value: '{"auth-core":{}}',
        fetchImpl,
      }),
    ).resolves.toMatchObject({ updated: false, target: 'preview' })
    expect(fetchImpl.mock.calls[1][0]).toContain('/v10/projects/prj_test/env?upsert=true')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).target).toEqual(['preview'])
  })

  it('fails without exposing Vercel response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ token: 'secret-response' }),
    })
    await expect(
      updateVercelEnvironmentVariable({
        environment: { VERCEL_API_TOKEN: 'synthetic-token', PREPUSH_VERCEL_PROJECT_ID: 'prj_test' },
        target: 'production',
        value: '{"auth-core":{}}',
        fetchImpl,
      }),
    ).rejects.toThrow('Vercel environment lookup failed (403)')
  })

  it('documents the tracked hook and setup command instead of relying on .git/hooks samples', () => {
    const hook = readFileSync(new URL('../../.githooks/pre-push', import.meta.url), 'utf8')
    const prettierIgnore = readFileSync(new URL('../../.prettierignore', import.meta.url), 'utf8')
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    expect(hook).toContain('scripts/pre-push-attestation.js')
    expect(prettierIgnore).toContain('.githooks/')
    expect(packageJson.scripts['setup:hooks']).toBe('node scripts/setup-git-hooks.js')
  })
})
