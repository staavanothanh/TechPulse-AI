import { describe, expect, it } from 'vitest'
import { createHmacKeyring } from '../../server/security/hmac-keyring.js'
import { reconcileQuotaHmacLifecycle } from '../../server/security/hmac-lifecycle.js'

function keyring({ currentVersion = 10, retiringVersions = [8, 9] } = {}) {
  const values = { CURRENT: 'c'.repeat(32), OLD_8: 'a'.repeat(32), OLD_9: 'b'.repeat(32) }
  return createHmacKeyring({
    currentEnv: 'CURRENT',
    retiringEnvs: retiringVersions.map((version) => `OLD_${version}`),
    currentVersion,
    retiringVersions,
    values,
  })
}

function memoryRepository() {
  const state = { snapshots: [], dependents: new Map() }
  return {
    state,
    async withTransaction(work) {
      const before = structuredClone(state.snapshots)
      try {
        return await work('memory-session')
      } catch (error) {
        state.snapshots = before
        throw error
      }
    },
    async listHmacLifecycleSnapshots() { return structuredClone(state.snapshots) },
    async appendHmacLifecycleSnapshot(snapshot) { state.snapshots.push(structuredClone(snapshot)); return snapshot },
    async countHmacDependentsByKeyVersion(version) {
      return state.dependents.get(version) ?? { rateLimitBuckets: 0, sessions: 0, adminAuditLogs: 0, total: 0 }
    },
  }
}

describe('durable quota HMAC lifecycle', () => {
  it('does not forget a predecessor when the operator removes both key 8 and its runtime declaration', async () => {
    const repository = memoryRepository()
    await reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring(),
      now: new Date('2026-07-01T00:00:00.000Z'),
    })

    const runtimeWithoutKeyOrRecord8 = keyring({ retiringVersions: [9] })
    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: runtimeWithoutKeyOrRecord8,
      now: new Date('2026-07-02T00:00:00.000Z'),
    })).rejects.toThrow(/30 days/)

    expect(repository.state.snapshots).toHaveLength(1)
    expect(repository.state.snapshots[0].versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 8, state: 'retiring', successorVersion: 10 }),
      expect.objectContaining({ version: 9, state: 'retiring', successorVersion: 10 }),
    ]))
  })

  it('retires one predecessor only after durable age and zero-dependent evidence while preserving history', async () => {
    const repository = memoryRepository()
    await reconcileQuotaHmacLifecycle({ repository, keyring: keyring(), now: new Date('2026-07-01T00:00:00.000Z') })
    repository.state.dependents.set(8, { rateLimitBuckets: 1, sessions: 0, adminAuditLogs: 0, total: 1 })

    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring({ retiringVersions: [9] }),
      now: new Date('2026-08-02T00:00:00.000Z'),
    })).rejects.toThrow(/dependent/)

    repository.state.dependents.delete(8)
    const result = await reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring({ retiringVersions: [9] }),
      now: new Date('2026-08-02T00:00:00.000Z'),
    })

    expect(result.snapshot.revision).toBe(2)
    expect(result.snapshot.versions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: 8, state: 'retired', dependentEvidence: { rateLimitBuckets: 0, sessions: 0, adminAuditLogs: 0 } }),
      expect.objectContaining({ version: 9, state: 'retiring' }),
    ]))
    expect(repository.state.snapshots[0].versions.find((entry) => entry.version === 8)?.state).toBe('retiring')
  })

  it('fails closed when the durable revision chain loses lifecycle history', async () => {
    const repository = memoryRepository()
    await reconcileQuotaHmacLifecycle({ repository, keyring: keyring(), now: new Date('2026-07-01T00:00:00.000Z') })
    repository.state.snapshots[0].versions = repository.state.snapshots[0].versions.filter((entry) => entry.version !== 8)

    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring(),
      now: new Date('2026-07-02T00:00:00.000Z'),
    })).rejects.toThrow(/lifecycle|snapshot|history/i)
  })

  it('rejects config rollback and same-version fingerprint contradiction', async () => {
    const repository = memoryRepository()
    await reconcileQuotaHmacLifecycle({ repository, keyring: keyring(), now: new Date('2026-07-01T00:00:00.000Z') })

    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: keyring({ currentVersion: 9, retiringVersions: [8] }),
      now: new Date('2026-07-02T00:00:00.000Z'),
    })).rejects.toThrow(/rollback/)

    const changedMaterial = createHmacKeyring({
      currentEnv: 'CURRENT', retiringEnvs: ['OLD_8', 'OLD_9'], currentVersion: 10, retiringVersions: [8, 9],
      values: { CURRENT: 'x'.repeat(32), OLD_8: 'a'.repeat(32), OLD_9: 'b'.repeat(32) },
    })
    await expect(reconcileQuotaHmacLifecycle({
      repository,
      keyring: changedMaterial,
      now: new Date('2026-07-02T00:00:00.000Z'),
    })).rejects.toThrow(/contradicts/)
  })
})
