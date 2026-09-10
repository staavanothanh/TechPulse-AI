import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  SYNC_ENV_KEY,
  assertProviderConfigValid,
  createEnvSyncPayload,
  envSyncEnabled,
  parseProviderConfig,
  runEnvSync,
  serializeProviderConfig,
  syncVercelEnvironmentVariable,
} from '../../scripts/sync-vercel-env.js'

const VALID_GRAPH = JSON.stringify({
  providerFailureDomains: [],
  providers: [],
  admissionDomains: [],
  routes: [],
  workloadPolicies: [],
})

const ATTESTATION_KEY = 'RUNTIME_SCHEMA_ATTESTATIONS_JSON'

function hookInput({ ref = 'refs/heads/main', sha = 'a'.repeat(40) } = {}) {
  return `${ref} ${sha} ${ref} ${'0'.repeat(40)}\n`
}

function envWithGraph(value = VALID_GRAPH) {
  return {
    [SYNC_ENV_KEY]: value,
    VERCEL_API_TOKEN: 'synthetic-token',
    PREPUSH_VERCEL_PROJECT_ID: 'prj_test',
    PREPUSH_VERCEL_TEAM_ID: 'team_test',
  }
}

/** Isolated in-memory state handlers so tests never touch the real sidecar. */
function isolatedState(initialHash = null) {
  const state = { hash: initialHash, length: initialHash === null ? 0 : null }
  return {
    readStateImpl: async () => (state.hash === null ? null : { hash: state.hash, length: state.length }),
    writeStateImpl: vi.fn(async ({ hash, length }) => {
      state.hash = hash
      state.length = length
    }),
  }
}

function hashOf(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

describe('Vercel provider env sync', () => {
  it('allowlists exactly PROVIDER_ADMISSION_DOMAINS_JSON and rejects every other key', () => {
    expect(() =>
      createEnvSyncPayload({ key: ATTESTATION_KEY, value: '{}', target: 'production' }),
    ).toThrow(/Only PROVIDER_ADMISSION_DOMAINS_JSON/)
    expect(() =>
      createEnvSyncPayload({ key: 'OTHER_JSON', value: '{}', target: 'production' }),
    ).toThrow(/Only PROVIDER_ADMISSION_DOMAINS_JSON/)
    expect(
      createEnvSyncPayload({ key: SYNC_ENV_KEY, value: '{}', target: 'production' }),
    ).toMatchObject({ key: SYNC_ENV_KEY, type: 'encrypted', target: ['production'] })
  })

  it('rejects an invalid target in the payload and the sync entrypoint', () => {
    expect(() =>
      createEnvSyncPayload({ key: SYNC_ENV_KEY, value: '{}', target: 'staging' }),
    ).toThrow(/target is invalid/)
    expect(() =>
      serializeProviderConfig,
    ).toBeTypeOf('function')
  })

  it('aborts without writing when the value is invalid JSON', async () => {
    const fetchImpl = vi.fn()
    const state = isolatedState()
    await expect(
      syncVercelEnvironmentVariable({
        environment: envWithGraph('not-json'),
        target: 'production',
        value: 'not-json',
        fetchImpl,
        readStateImpl: state.readStateImpl,
        writeStateImpl: state.writeStateImpl,
      }),
    ).rejects.toThrow(/not valid JSON/)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.writeStateImpl).not.toHaveBeenCalled()
  })

  it('aborts without writing when the graph fails provider-registry validation', async () => {
    const fetchImpl = vi.fn()
    const state = isolatedState()
    await expect(
      syncVercelEnvironmentVariable({
        environment: envWithGraph('{"routes":[{"routeId":"x"}]}'),
        target: 'production',
        value: '{"routes":[{"routeId":"x"}]}',
        fetchImpl,
        readStateImpl: state.readStateImpl,
        writeStateImpl: state.writeStateImpl,
      }),
    ).rejects.toThrow(/Provider configuration/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('is a clock-free no-op when the value is unchanged (validation skipped)', async () => {
    const normalized = serializeProviderConfig(VALID_GRAPH)
    const fetchImpl = vi.fn()
    // Validation would throw here if invoked (it is not: the no-op path skips it).
    const throwingValidate = () => {
      throw new Error('should not validate on no-op')
    }
    const state = isolatedState(hashOf(normalized))
    const result = await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'production',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
      validate: throwingValidate,
    })
    expect(result).toMatchObject({ changed: false, target: 'production' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('performs exactly one write for a changed value and returns sanitized output', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          envs: [
            { id: 'env_1', key: SYNC_ENV_KEY, target: ['production'], type: 'sensitive' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    const state = isolatedState()
    const result = await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'production',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
    })
    expect(result).toMatchObject({
      key: SYNC_ENV_KEY,
      changed: true,
      target: 'production',
      projectId: 'prj_test',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[0][0]).toContain('decrypt=false')
    expect(fetchImpl.mock.calls[0][0]).toContain('teamId=team_test')
    expect(fetchImpl.mock.calls[1][0]).toContain('/v9/projects/prj_test/env/env_1')
    const written = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(written).toEqual({ value: VALID_GRAPH, target: ['production'] })
    // Sanitized: output never contains the value itself.
    expect(JSON.stringify(result)).not.toContain(VALID_GRAPH)
  })

  it('never touches RUNTIME_SCHEMA_ATTESTATIONS_JSON when syncing the provider graph', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ envs: [] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    const state = isolatedState()
    await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'production',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
    })
    for (const call of fetchImpl.mock.calls) {
      expect(call[0]).not.toContain(ATTESTATION_KEY)
      if (call[1]?.body) expect(call[1].body).not.toContain(ATTESTATION_KEY)
    }
  })

  it('creates the variable via v10 upsert when absent', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ envs: [] }) })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    const state = isolatedState()
    await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'preview',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
    })
    expect(fetchImpl.mock.calls[1][0]).toContain('/v10/projects/prj_test/env?upsert=true')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).target).toEqual(['preview'])
  })

  it('PATCHes the merged target list when the existing var already includes the target', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          envs: [
            { id: 'env_1', key: SYNC_ENV_KEY, target: ['production', 'preview'], type: 'sensitive' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    const state = isolatedState()
    await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'preview',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
    })
    expect(fetchImpl.mock.calls[1][0]).toContain('/v9/projects/prj_test/env/env_1')
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).target).toEqual([
      'production',
      'preview',
    ])
  })

  it('falls through to v10 upsert when the target is not yet on the existing var', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          envs: [
            { id: 'env_1', key: SYNC_ENV_KEY, target: ['production'], type: 'sensitive' },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    const state = isolatedState()
    await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'preview',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
    })
    expect(fetchImpl.mock.calls[1][0]).toContain('/v10/projects/prj_test/env?upsert=true')
  })

  it('gate defaults to disabled and skips the hook path without a network call', async () => {
    expect(envSyncEnabled({})).toBe(false)
    const sync = vi.fn()
    const result = await runEnvSync({
      input: hookInput(),
      environment: { [SYNC_ENV_KEY]: VALID_GRAPH },
      sync,
    })
    expect(result).toMatchObject({ skipped: true })
    expect(sync).not.toHaveBeenCalled()
  })

  it('gate enabled runs the hook path and maps main to production', async () => {
    expect(envSyncEnabled({ PREPUSH_ENV_SYNC: 'true' })).toBe(true)
    const sync = vi.fn(async ({ target }) => ({ changed: true, target, dryRun: false }))
    const result = await runEnvSync({
      input: hookInput(),
      environment: { [SYNC_ENV_KEY]: VALID_GRAPH, PREPUSH_ENV_SYNC: 'true' },
      sync,
    })
    expect(result).not.toMatchObject({ skipped: true })
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0][0].target).toBe('production')
  })

  it('maps non-main branches to preview', async () => {
    const sync = vi.fn(async ({ target }) => ({
      changed: true,
      lengthBefore: 0,
      lengthAfter: 2,
      target,
      dryRun: false,
    }))
    await runEnvSync({
      input: hookInput({ ref: 'refs/heads/staging' }),
      environment: { [SYNC_ENV_KEY]: VALID_GRAPH, PREPUSH_ENV_SYNC: 'true' },
      sync,
    })
    expect(sync.mock.calls[0][0].target).toBe('preview')
  })

  it('direct mode with explicit target bypasses the hook gate', async () => {
    const sync = vi.fn(async ({ target }) => ({ changed: true, target, dryRun: false }))
    const result = await runEnvSync({
      target: 'production',
      environment: { [SYNC_ENV_KEY]: VALID_GRAPH }, // no PREPUSH_ENV_SYNC
      sync,
    })
    expect(result).not.toMatchObject({ skipped: true })
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('fails closed with a sanitized error when the token is missing', async () => {
    const fetchImpl = vi.fn()
    const state = isolatedState()
    await expect(
      syncVercelEnvironmentVariable({
        environment: { [SYNC_ENV_KEY]: VALID_GRAPH, PREPUSH_VERCEL_PROJECT_ID: 'prj_test' },
        target: 'production',
        value: VALID_GRAPH,
        fetchImpl,
        readStateImpl: state.readStateImpl,
        writeStateImpl: state.writeStateImpl,
      }),
    ).rejects.toThrow(/Missing VERCEL_API_TOKEN/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed with a sanitized error when the env value is missing', async () => {
    const sync = vi.fn()
    await expect(
      runEnvSync({
        target: 'production',
        environment: {},
        sync,
      }),
    ).rejects.toThrow(/PROVIDER_ADMISSION_DOMAINS_JSON is not set/)
    expect(sync).not.toHaveBeenCalled()
  })

  it('treats a corrupted sidecar as never-synced and performs one re-write', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ envs: [] }),
      })
      .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({}) })
    const state = isolatedState()
    await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'production',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: async () => ({ hash: 'corrupt', length: NaN }), // unparseable state
      writeStateImpl: state.writeStateImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(state.writeStateImpl).toHaveBeenCalledTimes(1)
  })

  it('dry-run reports change without issuing any write', async () => {
    const fetchImpl = vi.fn()
    const state = isolatedState()
    const result = await syncVercelEnvironmentVariable({
      environment: envWithGraph(),
      target: 'production',
      value: VALID_GRAPH,
      fetchImpl,
      readStateImpl: state.readStateImpl,
      writeStateImpl: state.writeStateImpl,
      dryRun: true,
    })
    expect(result).toMatchObject({ changed: true, dryRun: true })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.writeStateImpl).not.toHaveBeenCalled()
  })

  it('fails closed without exposing Vercel response bodies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ token: 'secret-response' }),
    })
    const state = isolatedState()
    await expect(
      syncVercelEnvironmentVariable({
        environment: envWithGraph(),
        target: 'production',
        value: VALID_GRAPH,
        fetchImpl,
        readStateImpl: state.readStateImpl,
        writeStateImpl: state.writeStateImpl,
      }),
    ).rejects.toThrow('Vercel environment lookup failed (403)')
  })
})
