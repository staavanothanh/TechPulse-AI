import fs from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_CAPABILITY_PROBE_COLLECTION,
  RUNTIME_CAPABILITY_PROBE_DEFINITION,
  RUNTIME_CAPABILITY_PROBE_INDEXES,
  buildGovernanceCapabilityProbeMigration,
  runGovernanceCapabilityProbeMigration,
} from '../../scripts/migrations/governance-capability-probes.js'

describe('governance runtime capability probe migration', () => {
  it('defines a closed synthetic schema with unique identity and TTL expiry', () => {
    expect(RUNTIME_CAPABILITY_PROBE_COLLECTION).toBe('runtimeCapabilityProbes')
    expect(RUNTIME_CAPABILITY_PROBE_DEFINITION.validator.$jsonSchema.additionalProperties).toBe(false)
    expect(RUNTIME_CAPABILITY_PROBE_DEFINITION.validator.$jsonSchema.required).toEqual(['_id', 'probeId', 'probeKind', 'expiresAt', 'createdAt'])
    expect(RUNTIME_CAPABILITY_PROBE_INDEXES).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { probeId: 1 }, options: { unique: true } }),
      expect.objectContaining({ key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }),
    ]))
  })

  it('builds only idempotent collection, validator and index operations', () => {
    const plan = buildGovernanceCapabilityProbeMigration({ dryRun: true })
    expect(plan).toHaveLength(4)
    expect(plan.every((operation) => ['createCollection', 'collMod', 'createIndex'].includes(operation.type))).toBe(true)
    expect(plan.every((operation) => operation.dryRun === true)).toBe(true)
  })

  it('runs NamespaceExists-safe operations without destructive changes', async () => {
    const createCollection = vi.fn(async () => { const error = new Error('already exists'); error.code = 48; throw error })
    const command = vi.fn(async () => undefined)
    const createIndex = vi.fn(async () => 'index')
    const db = { createCollection, command, collection: vi.fn(() => ({ createIndex })) }
    await expect(runGovernanceCapabilityProbeMigration({ db })).resolves.toHaveLength(4)
    expect(command).toHaveBeenCalledOnce()
    expect(createIndex).toHaveBeenCalledTimes(2)
  })

  it('wires governance migration to both logical databases and the new probe migration', () => {
    const source = fs.readFileSync(new URL('../../scripts/db-migrate.js', import.meta.url), 'utf8')
    expect(source).toContain("./migrations/governance-capability-probes.js")
    expect(source).toContain("./migrations/governance-retention-hardening.js")
    expect(source).toContain("./migrations/article-governance-hardening.js")
    expect(source).toMatch(/buildGovernanceCapabilityProbeMigration[\s\S]*database: 'techpulse_app'/)
    expect(source).toMatch(/buildGovernanceCapabilityProbeMigration[\s\S]*database: 'techpulse_governance'/)
    expect(source).toMatch(/runGovernanceCapabilityProbeMigration\(\{ db: context\.db \}\)/)
    expect(source).toMatch(/runGovernanceCapabilityProbeMigration\(\{ db: governanceDb \}\)/)
    expect(source).toMatch(/runGovernanceRetentionHardeningMigration\(\{ db: context\.db \}\)/)
    expect(source).toMatch(/runArticleGovernanceHardeningMigration\(\{ db: context\.db \}\)/)
  })
})
