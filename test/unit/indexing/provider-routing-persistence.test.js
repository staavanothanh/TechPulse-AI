import { ObjectId } from 'mongodb'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_ROUTING_V2_COLLECTIONS,
  PROVIDER_ROUTING_V2_INDEXES,
  assertMigrationTargetDoesNotDowngradeProviderRoutingV2,
  buildProviderRoutingV2Migration,
  invalidateLegacyReadyEmbeddings,
  runProviderRoutingV2Migration,
  upgradeProviderAdmissionDocument,
} from '../../../scripts/migrations/provider-routing-v2.js'
import {
  MongoProviderFailureDomainRepository,
  applyProviderFailureDomainAdmission,
  applyProviderFailureDomainOutcome,
} from '../../../server/repositories/mongo/provider-failure-domain-repository.js'
import { applyProviderReservation } from '../../../server/repositories/mongo/provider-admission-repository.js'
import { INDEXING_JOB_COLLECTIONS } from '../../../scripts/migrations/indexing-jobs.js'
import { INDEXING_ARTICLE_INDEXES } from '../../../scripts/migrations/indexing-jobs.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../../scripts/migrations/chat-sessions.js'
import { ARTICLE_GOVERNANCE_HARDENING_VALIDATOR } from '../../../scripts/migrations/article-governance-hardening.js'
import { ARTICLE_INDEXES } from '../../../scripts/migrations/articles.js'
import { QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } from '../../../scripts/migrations/qa-evidence-fence.js'
import { SUMMARY_DETAIL_ARTICLE_VALIDATOR } from '../../../scripts/migrations/summary-detail-v1.js'
import { TOPIC_TAXONOMY_ARTICLE_VALIDATOR, TOPIC_TAXONOMY_USERS_VALIDATOR } from '../../../scripts/migrations/topic-taxonomy-v1.js'

const now = new Date('2026-08-15T00:00:00.000Z')
const failureDomain = Object.freeze({
  providerFailureDomainId: 'provider-main',
  configVersion: 4,
  failureThreshold: 3,
  cooldownSeconds: 60,
})

describe('ADR-0013 provider-routing persistence migration', () => {
  it('upgrades the admission provider identity without changing reservations or budget state', () => {
    const legacy = {
      _id: new ObjectId('507f1f77bcf86cd799439011'),
      admissionDomainId: 'credential-main',
      provider: 'provider-main',
      activeReservations: [{
        reservationId: 'reservation-live',
        routeId: 'summary-primary',
        attemptId: new ObjectId('507f1f77bcf86cd799439012'),
        kind: 'summary',
        expiresAt: new Date('2026-08-15T00:01:00.000Z'),
      }],
      maxConcurrency: 2,
      budgetWindowStart: now,
      spentUnits: 7,
      budgetLimit: 20,
      routeCircuits: [{ routeId: 'summary-primary', state: 'closed', consecutiveRetryableFailures: 1 }],
      updatedAt: now,
    }

    expect(upgradeProviderAdmissionDocument(legacy)).toEqual({
      ...legacy,
      providerId: 'provider-main',
      provider: undefined,
    })
    expect(upgradeProviderAdmissionDocument(legacy)).toMatchObject({
      activeReservations: legacy.activeReservations,
      spentUnits: 7,
      budgetLimit: 20,
      routeCircuits: legacy.routeCircuits,
    })
  })

  it('defines strict target validators, exact indexes, and an ordered compatibility plan', () => {
    const plan = buildProviderRoutingV2Migration({ dryRun: true })
    const admissionSchema = PROVIDER_ROUTING_V2_COLLECTIONS.providerAdmissionStates.validator.$and[0].$jsonSchema
    const failureSchema = PROVIDER_ROUTING_V2_COLLECTIONS.providerFailureDomainStates.validator.$jsonSchema
    const answerSchema = PROVIDER_ROUTING_V2_COLLECTIONS.answerAttempts.validator.$and[0].$jsonSchema
    const indexingSchema = PROVIDER_ROUTING_V2_COLLECTIONS.indexingJobs.validator.$and[0].$jsonSchema
    const articleSchema = PROVIDER_ROUTING_V2_COLLECTIONS.articles.validator.$or[0].$and[0].$jsonSchema

    expect(admissionSchema.additionalProperties).toBe(false)
    expect(admissionSchema.required).toContain('providerId')
    expect(admissionSchema.properties.provider).toBeUndefined()
    expect(failureSchema).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['providerFailureDomainId', 'configVersion', 'state', 'consecutiveRetryableFailures', 'updatedAt']),
    })
    expect(answerSchema.properties).toMatchObject({
      providerFailureDomainId: { bsonType: 'string', pattern: expect.any(String) },
      fallbackKind: { enum: ['none', 'model', 'provider'] },
    })
    expect(indexingSchema.properties.targetEmbeddingArtifactCompatibilityId).toEqual({ bsonType: 'string', pattern: expect.any(String) })
    expect(JSON.stringify(PROVIDER_ROUTING_V2_COLLECTIONS.indexingJobs.validator)).toContain('targetEmbeddingArtifactCompatibilityId')
    expect(articleSchema.properties.embeddingArtifactCompatibilityId).toEqual({
      bsonType: 'string',
      pattern: expect.any(String),
    })
    expect(articleSchema.properties.embeddingCutover).toMatchObject({
      bsonType: 'object',
      additionalProperties: false,
      required: ['epoch', 'status', 'requestedAt'],
    })
    expect(PROVIDER_ROUTING_V2_COLLECTIONS.articles.validator.$or[0].$and).toContainEqual({
      $expr: {
        $cond: [
          { $eq: ['$embeddingStatus', 'ready'] },
          { $eq: [{ $type: '$embeddingArtifactCompatibilityId' }, 'string'] },
          { $eq: [{ $type: '$embeddingArtifactCompatibilityId' }, 'missing'] },
        ],
      },
    })
    expect(PROVIDER_ROUTING_V2_INDEXES).toMatchObject({
      providerAdmissionStates: expect.arrayContaining([
        expect.objectContaining({ name: 'provider_admission_domain_unique', options: { unique: true } }),
        expect.objectContaining({ name: 'provider_route_circuit' }),
      ]),
      providerFailureDomainStates: expect.arrayContaining([
        expect.objectContaining({ name: 'provider_failure_domain_unique', options: { unique: true } }),
        expect.objectContaining({ name: 'provider_failure_domain_cooldown' }),
      ]),
      answerAttempts: expect.arrayContaining(CHAT_SESSION_INDEXES.answerAttempts.map(({ name }) => expect.objectContaining({ name }))),
      articles: expect.arrayContaining([
        ...ARTICLE_INDEXES.articles.map(({ name }) => expect.objectContaining({ name })),
        ...INDEXING_ARTICLE_INDEXES.map(({ name }) => expect.objectContaining({ name })),
        expect.objectContaining({
        name: 'articles_embedding_compatibility',
        key: { embeddingStatus: 1, embeddingArtifactCompatibilityId: 1, embeddingVersion: 1 },
        }),
      ]),
    })
    expect(plan.slice(0, 11).map(({ type, collection }) => `${type}:${collection}`)).toEqual([
      'collMod:providerAdmissionStates',
      'updateMany:providerAdmissionStates',
      'collMod:providerAdmissionStates',
      'createCollection:providerFailureDomainStates',
      'collMod:providerFailureDomainStates',
      'collMod:answerAttempts',
      'updateMany:indexingJobs',
      'collMod:indexingJobs',
      'collMod:articles',
      'invalidateLegacyEmbeddings:articles',
      'collMod:articles',
    ])
    expect(plan.filter(({ type }) => type === 'createIndex').map(({ collection, name }) => `${collection}:${name}`)).toEqual(
      Object.entries(PROVIDER_ROUTING_V2_INDEXES).flatMap(([collection, indexes]) => indexes.map(({ name }) => `${collection}:${name}`)),
    )
  })

  it('blocks older schema targets after any v2 marker is installed but permits governance repair', async () => {
    const installed = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'providerFailureDomainStates', options: {} }] })),
    }
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'articles' })).rejects.toThrow(/downgrade/i)
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'indexing-jobs' })).rejects.toThrow(/downgrade/i)
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'chat-sessions' })).rejects.toThrow(/downgrade/i)
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'sources' })).rejects.toThrow(/downgrade/i)
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'auth-core' })).resolves.toBeUndefined()
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'google-oauth' })).resolves.toBeUndefined()
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'governance' })).resolves.toBeUndefined()
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'provider-routing-v2' })).resolves.toBeUndefined()
  })
  it('blocks older auth, article, and composite targets after taxonomy is installed', async () => {
    const installed = {
      listCollections: vi.fn(() => ({ toArray: async () => [
        { name: 'articles', options: { validator: TOPIC_TAXONOMY_ARTICLE_VALIDATOR } },
        { name: 'users', options: { validator: TOPIC_TAXONOMY_USERS_VALIDATOR } },
      ] })),
    }
    for (const target of ['auth-core', 'google-oauth', 'articles', 'summary-detail-v1', 'governance']) {
      await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target })).rejects.toThrow(/topic-taxonomy/i)
    }
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'topic-taxonomy-v1' })).resolves.toBeUndefined()
  })

  it('allows provider and QA reruns while blocking governance downgrade after successor install', async () => {
    const installed = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR } }] })),
    }
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'provider-routing-v2' })).resolves.toBeUndefined()
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'qa-evidence-fence' })).resolves.toBeUndefined()
    await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target: 'governance' })).rejects.toThrow(/successor article schema/i)
  })

  it('blocks provider, QA and governance reruns after summary-detail is installed', async () => {
    const installed = {
      listCollections: vi.fn(() => ({ toArray: async () => [{ name: 'articles', options: { validator: SUMMARY_DETAIL_ARTICLE_VALIDATOR } }] })),
    }
    for (const target of ['provider-routing-v2', 'qa-evidence-fence', 'governance']) {
      await expect(assertMigrationTargetDoesNotDowngradeProviderRoutingV2({ db: installed, target })).rejects.toThrow(/successor article schema/i)
    }
  })

  it('persists bounded cutover intent and resets a processing source whose cursor passed the article', async () => {
    const articleOne = new ObjectId('507f1f77bcf86cd799439061')
    const articleTwo = new ObjectId('507f1f77bcf86cd799439062')
    const sourceOne = new ObjectId('507f1f77bcf86cd799439071')
    const sourceTwo = new ObjectId('507f1f77bcf86cd799439072')
    let legacySelected = false
    let intentSelected = false
    const findOneAndUpdate = vi.fn(async ({ _id }) => _id.equals(articleOne) ? { sourceId: sourceOne } : null)
    const sourceUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const materializeIntent = vi.fn(async () => ({ modifiedCount: 1 }))
    const db = {
      collection: vi.fn((name) => name === 'articles' ? {
        find: vi.fn((filter) => ({
          sort: vi.fn(() => ({
            limit: vi.fn(() => ({
              project: vi.fn(() => ({
                toArray: async () => {
                  if (filter.embeddingStatus === 'ready') {
                    if (legacySelected) return []
                    legacySelected = true
                    return [{ _id: articleOne, sourceId: sourceOne }, { _id: articleTwo, sourceId: sourceTwo }]
                  }
                  if (intentSelected) return []
                  intentSelected = true
                  return [{ _id: articleOne, sourceId: sourceOne }]
                },
              })),
            })),
          })),
        })),
        findOneAndUpdate,
        updateMany: materializeIntent,
      } : { updateOne: sourceUpdate }),
    }

    await expect(invalidateLegacyReadyEmbeddings({ db, batchSize: 2 })).resolves.toEqual({ invalidatedCount: 1, sourceCount: 1 })
    expect(findOneAndUpdate).toHaveBeenCalledTimes(2)
    expect(findOneAndUpdate.mock.calls[0][1]).toEqual(expect.arrayContaining([
      { $set: expect.objectContaining({
        embeddingStatus: 'pending',
        embedding: null,
        embeddingModel: null,
        embeddingCutover: {
          epoch: 'provider-routing-v2',
          status: 'pending',
          requestedAt: '$$NOW',
        },
      }) },
      { $unset: 'embeddingArtifactCompatibilityId' },
    ]))
    expect(sourceUpdate).toHaveBeenCalledOnce()
    expect(sourceUpdate.mock.calls[0][0]).toEqual({ _id: sourceOne })
    expect(sourceUpdate.mock.calls[0][1]).toEqual([{
      $set: {
        reconciliation: {
          status: 'pending',
          requiredPolicyVersion: '$policyVersion',
          completedPolicyVersion: null,
          requestedAt: '$$NOW',
          error: null,
        },
        updatedAt: '$$NOW',
      },
    }])
    expect(materializeIntent).toHaveBeenCalledWith(
      {
        _id: { $in: [articleOne] },
        'embeddingCutover.epoch': 'provider-routing-v2',
        'embeddingCutover.status': 'pending',
      },
      [{ $set: { 'embeddingCutover.status': 'materialized', 'embeddingCutover.materializedAt': '$$NOW' } }],
    )
    expect(findOneAndUpdate.mock.invocationCallOrder[0]).toBeLessThan(sourceUpdate.mock.invocationCallOrder[0])
  })

  it('retries a durable pending cutover after a crash and is idempotent after materialization', async () => {
    const articleId = new ObjectId('507f1f77bcf86cd799439081')
    const sourceId = new ObjectId('507f1f77bcf86cd799439091')
    let hasPendingIntent = true
    const sourceUpdate = vi.fn(async () => ({ matchedCount: 1 }))
    const materializeIntent = vi.fn(async () => {
      hasPendingIntent = false
      return { modifiedCount: 1 }
    })
    const db = {
      collection: vi.fn((name) => name === 'articles' ? {
        find: vi.fn((filter) => ({ sort: vi.fn(() => ({ limit: vi.fn(() => ({ project: vi.fn(() => ({
          toArray: async () => filter.embeddingStatus === 'ready' || !hasPendingIntent
            ? []
            : [{ _id: articleId, sourceId }],
        })) })) })) })),
        findOneAndUpdate: vi.fn(),
        updateMany: materializeIntent,
      } : { updateOne: sourceUpdate }),
    }

    await expect(invalidateLegacyReadyEmbeddings({ db, batchSize: 10 })).resolves.toEqual({ invalidatedCount: 0, sourceCount: 1 })
    await expect(invalidateLegacyReadyEmbeddings({ db, batchSize: 10 })).resolves.toEqual({ invalidatedCount: 0, sourceCount: 0 })
    expect(sourceUpdate).toHaveBeenCalledOnce()
    expect(materializeIntent).toHaveBeenCalledOnce()
    await expect(invalidateLegacyReadyEmbeddings({ db, batchSize: 0 })).rejects.toThrow(/batchSize/i)
  })

  it('checks the indexing predecessor before applying any write', async () => {
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [] })),
      createCollection: vi.fn(),
      command: vi.fn(),
      collection: vi.fn(),
    }

    await expect(runProviderRoutingV2Migration({ db })).rejects.toThrow(/indexing-jobs migration/i)
    expect(db.command).not.toHaveBeenCalled()
    expect(db.createCollection).not.toHaveBeenCalled()
  })

  it('also requires the chat and governed-article validator revisions', async () => {
    const baseCollections = [{
      name: 'providerAdmissionStates',
      options: { validator: INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator },
    }]
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => baseCollections })),
      createCollection: vi.fn(), command: vi.fn(), collection: vi.fn(),
    }

    await expect(runProviderRoutingV2Migration({ db })).rejects.toThrow(/chat-sessions migration/i)
    baseCollections.push({
      name: 'answerAttempts',
      options: { validator: CHAT_SESSION_COLLECTIONS.answerAttempts.validator },
    })
    baseCollections.push({
      name: 'indexingJobs',
      options: { validator: INDEXING_JOB_COLLECTIONS.indexingJobs.validator },
    })
    await expect(runProviderRoutingV2Migration({ db })).rejects.toThrow(/governance article hardening/i)
  })

  it('accepts the exact indexing validator as its predecessor', async () => {
    const calls = []
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{
        name: 'providerAdmissionStates',
        options: { validator: INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator },
      }, {
        name: 'answerAttempts',
        options: { validator: CHAT_SESSION_COLLECTIONS.answerAttempts.validator },
      }, {
        name: 'indexingJobs',
        options: { validator: INDEXING_JOB_COLLECTIONS.indexingJobs.validator },
      }, {
        name: 'articles',
        options: { validator: ARTICLE_GOVERNANCE_HARDENING_VALIDATOR },
      }] })),
      createCollection: vi.fn(async (name) => calls.push(['createCollection', name])),
      command: vi.fn(async ({ collMod }) => calls.push(['collMod', collMod])),
      collection: vi.fn((name) => name === 'articles' ? {
        find: vi.fn(() => ({ sort: vi.fn(() => ({ limit: vi.fn(() => ({ project: vi.fn(() => ({ toArray: async () => [] })) })) })) })),
        createIndex: vi.fn(async (_key, options) => calls.push(['createIndex', name, options.name])),
      } : {
        updateMany: vi.fn(async () => calls.push(['updateMany', name])),
        createIndex: vi.fn(async (_key, options) => calls.push(['createIndex', name, options.name])),
      }),
    }

    await expect(runProviderRoutingV2Migration({ db })).resolves.toHaveLength(buildProviderRoutingV2Migration().length)
    expect(calls.slice(0, 9)).toEqual([
      ['collMod', 'providerAdmissionStates'],
      ['updateMany', 'providerAdmissionStates'],
      ['collMod', 'providerAdmissionStates'],
      ['createCollection', 'providerFailureDomainStates'],
      ['collMod', 'providerFailureDomainStates'],
      ['collMod', 'answerAttempts'],
      ['updateMany', 'indexingJobs'],
      ['collMod', 'indexingJobs'],
      ['collMod', 'articles'],
    ])
  })

  it('accepts the QA evidence-fence article successor when provider-routing-v2 is reapplied', async () => {
    const articleValidators = []
    const db = {
      listCollections: vi.fn(() => ({ toArray: async () => [{
        name: 'providerAdmissionStates',
        options: { validator: INDEXING_JOB_COLLECTIONS.providerAdmissionStates.validator },
      }, {
        name: 'answerAttempts',
        options: { validator: CHAT_SESSION_COLLECTIONS.answerAttempts.validator },
      }, {
        name: 'indexingJobs',
        options: { validator: INDEXING_JOB_COLLECTIONS.indexingJobs.validator },
      }, {
        name: 'articles',
        options: { validator: QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR },
      }] })),
      createCollection: vi.fn(async () => undefined),
      command: vi.fn(async (command) => {
        if (command.collMod === 'articles') articleValidators.push(command.validator)
        return { ok: 1 }
      }),
      collection: vi.fn((name) => name === 'articles' ? {
        find: vi.fn(() => ({ sort: vi.fn(() => ({ limit: vi.fn(() => ({ project: vi.fn(() => ({ toArray: async () => [] })) })) })) })),
        createIndex: vi.fn(async () => undefined),
      } : {
        updateMany: vi.fn(async () => undefined),
        createIndex: vi.fn(async () => undefined),
      }),
    }

    await expect(runProviderRoutingV2Migration({ db })).resolves.toHaveLength(buildProviderRoutingV2Migration().length)
    expect(articleValidators).toHaveLength(2)
    expect(articleValidators.every((validator) => JSON.stringify(validator).includes('qnaFenceToken'))).toBe(true)
  })

  it('wires the versioned migration and readiness verification as separate targets', () => {
    const migrateSource = readFileSync(new URL('../../../scripts/db-migrate.js', import.meta.url), 'utf8')
    const verifySource = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')

    expect(migrateSource).toContain("./migrations/provider-routing-v2.js")
    expect(migrateSource).toContain("'provider-routing-v2'")
    expect(migrateSource).toContain('runProviderRoutingV2Migration')
    expect(migrateSource).toContain('assertMigrationTargetDoesNotDowngradeProviderRoutingV2')
    expect(migrateSource).toMatch(/buildArticleGovernanceHardeningMigration\(\{ dryRun: true \}\)[\s\S]*buildProviderRoutingV2Migration\(\{ dryRun: true \}\)[\s\S]*buildGovernanceCapabilityProbeMigration/)
    expect(migrateSource).toMatch(/runArticleGovernanceHardeningMigration\(\{ db: appDb \}\)[\s\S]*runProviderRoutingV2Migration\(\{ db: appDb \}\)[\s\S]*runGovernanceCapabilityProbeMigration/)
    expect(verifySource).toContain("./migrations/provider-routing-v2.js")
    expect(verifySource).toContain("'provider-routing-v2'")
    expect(verifySource).toContain('provider_failure_domain_cooldown')
    expect(verifySource).toContain('embedding-compatibility-state')
  })
})

describe('ADR-0013 provider admission identity', () => {
  it('persists providerId for new target-schema state', () => {
    const admitted = applyProviderReservation(null, {
      domain: { admissionDomainId: 'credential-main', providerId: 'provider-main', maxConcurrency: 1, budgetLimit: 2, budgetWindow: 'day' },
      route: { routeId: 'summary-primary', admissionDomainId: 'credential-main' },
      reservationId: 'reservation-main',
      attemptId: '507f1f77bcf86cd799439012',
      kind: 'summary',
      units: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })

    expect(admitted.allowed).toBe(true)
    expect(admitted.state).toMatchObject({ providerId: 'provider-main' })
    expect(admitted.state.provider).toBeUndefined()
  })
})

describe('ADR-0013 shared provider failure-domain circuit', () => {
  it('opens the shared domain at the configured threshold and blocks every caller', () => {
    let state = null
    for (let failure = 0; failure < 3; failure += 1) {
      const admitted = applyProviderFailureDomainAdmission(state, {
        domain: failureDomain,
        reservationId: `reservation-${failure}`,
        now,
      })
      expect(admitted.allowed).toBe(true)
      state = applyProviderFailureDomainOutcome(admitted.state, {
        domain: failureDomain,
        reservationId: `reservation-${failure}`,
        outcome: 'provider-retryable-failure',
        now,
      }).state
    }

    expect(state).toMatchObject({
      providerFailureDomainId: 'provider-main',
      configVersion: 4,
      state: 'open',
      consecutiveRetryableFailures: 3,
      cooldownUntil: new Date(now.getTime() + 60_000),
    })
    expect(applyProviderFailureDomainAdmission(state, {
      domain: failureDomain,
      reservationId: 'different-credential-route',
      now,
    })).toMatchObject({ allowed: false, reason: 'provider-domain-open', retryAfterSeconds: 60 })
  })

  it('atomically permits only one half-open probe after cooldown', () => {
    const open = {
      providerFailureDomainId: 'provider-main',
      configVersion: 4,
      state: 'open',
      consecutiveRetryableFailures: 3,
      cooldownUntil: new Date(now.getTime() - 1),
      updatedAt: new Date(now.getTime() - 60_000),
    }
    const first = applyProviderFailureDomainAdmission(open, {
      domain: failureDomain,
      reservationId: 'half-open-probe-one',
      now,
    })
    const second = applyProviderFailureDomainAdmission(first.state, {
      domain: failureDomain,
      reservationId: 'half-open-probe-two',
      now,
    })

    expect(first).toMatchObject({ allowed: true, probe: true })
    expect(first.reservationId).toBe('half-open-probe-one')
    expect(first.state).toMatchObject({ state: 'half-open', halfOpenProbeReservationId: 'half-open-probe-one' })
    expect(second).toMatchObject({ allowed: false, reason: 'provider-domain-open' })
    expect(applyProviderFailureDomainAdmission(first.state, {
      domain: failureDomain,
      reservationId: 'half-open-probe-one',
      now,
    })).toMatchObject({ allowed: true, reused: true, reservationId: 'half-open-probe-one' })
  })

  it('recovers a stale half-open probe lease after one cooldown window', () => {
    const staleHalfOpen = {
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'half-open',
      consecutiveRetryableFailures: 3, halfOpenProbeReservationId: 'abandoned-probe',
      updatedAt: new Date(now.getTime() - 61_000),
    }

    const recovered = applyProviderFailureDomainAdmission(staleHalfOpen, {
      domain: failureDomain,
      reservationId: 'replacement-probe',
      now,
    })

    expect(recovered).toMatchObject({ allowed: true, probe: true, reservationId: 'replacement-probe' })
    expect(recovered.state).toMatchObject({ state: 'half-open', halfOpenProbeReservationId: 'replacement-probe', consecutiveRetryableFailures: 3, updatedAt: now })
  })

  it('closes a successful half-open probe and ignores model-specific failures', () => {
    const halfOpen = {
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'half-open',
      consecutiveRetryableFailures: 3, halfOpenProbeReservationId: 'half-open-probe-one', updatedAt: now,
    }
    const unchanged = applyProviderFailureDomainOutcome(halfOpen, {
      domain: failureDomain,
      reservationId: 'half-open-probe-one',
      outcome: 'model-retryable-failure',
      now,
    })
    const closed = applyProviderFailureDomainOutcome(halfOpen, {
      domain: failureDomain,
      reservationId: 'half-open-probe-one',
      outcome: 'succeeded',
      now,
    })

    expect(unchanged.state).toEqual({
      ...halfOpen,
      halfOpenProbeReservationId: undefined,
    })
    expect(applyProviderFailureDomainAdmission(unchanged.state, {
      domain: failureDomain,
      reservationId: 'replacement-half-open-probe',
      now,
    })).toMatchObject({ allowed: true, probe: true })
    expect(closed.state).toMatchObject({ state: 'closed', consecutiveRetryableFailures: 0 })
    expect(closed.state.halfOpenProbeReservationId).toBeUndefined()
  })

  it('cancels a local-control probe without healing the provider failure domain', () => {
    const halfOpen = {
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'half-open',
      consecutiveRetryableFailures: 3, halfOpenProbeReservationId: 'half-open-probe-one', updatedAt: now,
    }

    const cancelled = applyProviderFailureDomainOutcome(halfOpen, {
      domain: failureDomain,
      reservationId: 'half-open-probe-one',
      outcome: 'cancelled',
      now,
    })

    expect(cancelled.recorded).toBe(true)
    expect(cancelled.state).toEqual({
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'half-open',
      consecutiveRetryableFailures: 3, updatedAt: now,
    })
  })

  it('fails closed on stale config before either admission or outcome mutation', () => {
    const stale = {
      providerFailureDomainId: 'provider-main', configVersion: 3, state: 'closed',
      consecutiveRetryableFailures: 0, updatedAt: now,
    }
    const input = { domain: failureDomain, reservationId: 'reservation-stale', now }

    expect(() => applyProviderFailureDomainAdmission(stale, input)).toThrow(expect.objectContaining({ code: 'provider_failure_domain_config_stale' }))
    expect(() => applyProviderFailureDomainOutcome(stale, { ...input, outcome: 'provider-retryable-failure' })).toThrow(expect.objectContaining({ code: 'provider_failure_domain_config_stale' }))
    expect(stale).toEqual({
      providerFailureDomainId: 'provider-main', configVersion: 3, state: 'closed',
      consecutiveRetryableFailures: 0, updatedAt: now,
    })
  })

  it('rejects invalid state-machine input and does not let another caller report a probe', () => {
    expect(() => applyProviderFailureDomainAdmission(null, {
      domain: { ...failureDomain, failureThreshold: 4 },
      reservationId: 'reservation-invalid-config',
      now,
    })).toThrow(/configuration/i)
    expect(() => applyProviderFailureDomainOutcome(null, {
      domain: failureDomain,
      reservationId: 'reservation-invalid-outcome',
      outcome: 'unknown',
      now,
    })).toThrow(/outcome/i)
    expect(() => applyProviderFailureDomainAdmission({
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'invalid',
      consecutiveRetryableFailures: 0, updatedAt: now,
    }, {
      domain: failureDomain,
      reservationId: 'reservation-invalid-state',
      now,
    })).toThrow(expect.objectContaining({ code: 'provider_failure_domain_config_stale' }))

    const halfOpen = {
      providerFailureDomainId: 'provider-main', configVersion: 4, state: 'half-open',
      consecutiveRetryableFailures: 3, halfOpenProbeReservationId: 'owned-probe-reservation', updatedAt: now,
    }
    expect(applyProviderFailureDomainOutcome(halfOpen, {
      domain: failureDomain,
      reservationId: 'different-reservation',
      outcome: 'provider-retryable-failure',
      now,
    })).toEqual({ recorded: false, state: halfOpen })
  })

  it('inserts the first closed state once and reuses it without another write', async () => {
    let current = null
    const insertOne = vi.fn(async (document) => { current = document })
    const collection = {
      findOne: vi.fn(async () => current),
      insertOne,
      replaceOne: vi.fn(),
    }
    const session = { withTransaction: vi.fn(async (work) => work()), endSession: vi.fn() }
    const repository = new MongoProviderFailureDomainRepository({
      db: { collection: vi.fn(() => collection) },
      client: { startSession: vi.fn(() => session) },
    })
    const input = { domain: failureDomain, reservationId: 'first-reservation', now }

    await expect(repository.admitProviderCall(input)).resolves.toMatchObject({ allowed: true, probe: false })
    await expect(repository.admitProviderCall(input)).resolves.toMatchObject({ allowed: true, probe: false })
    expect(insertOne).toHaveBeenCalledOnce()
    expect(collection.replaceOne).not.toHaveBeenCalled()
  })

  it('uses configVersion in the Mongo compare-and-set filter', async () => {
    const current = {
      _id: new ObjectId('507f1f77bcf86cd799439031'),
      providerFailureDomainId: 'provider-main',
      configVersion: 4,
      state: 'open',
      consecutiveRetryableFailures: 3,
      cooldownUntil: new Date(now.getTime() - 1),
      updatedAt: new Date(now.getTime() - 60_000),
    }
    const replaceOne = vi.fn(async () => ({ matchedCount: 1 }))
    const collection = {
      findOne: vi.fn(async () => current),
      replaceOne,
      insertOne: vi.fn(),
    }
    const session = {
      withTransaction: vi.fn(async (work) => work()),
      endSession: vi.fn(),
    }
    const repository = new MongoProviderFailureDomainRepository({
      db: { collection: vi.fn(() => collection) },
      client: { startSession: vi.fn(() => session) },
    })

    await expect(repository.admitProviderDomain({
      domain: failureDomain,
      reservationId: 'half-open-mongo-probe',
      now,
    })).resolves.toMatchObject({ allowed: true, reservationId: 'half-open-mongo-probe' })
    expect(replaceOne).toHaveBeenCalledWith(
      expect.objectContaining({ configVersion: 4 }),
      expect.objectContaining({ configVersion: 4, halfOpenProbeReservationId: 'half-open-mongo-probe' }),
      expect.objectContaining({ session }),
    )
  })
})
