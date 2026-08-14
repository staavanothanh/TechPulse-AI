const date = Object.freeze({ bsonType: 'date' })
const objectId = Object.freeze({ bsonType: 'objectId' })

export const RUNTIME_CAPABILITY_PROBE_COLLECTION = 'runtimeCapabilityProbes'

export const RUNTIME_CAPABILITY_PROBE_DEFINITION = Object.freeze({
  validator: Object.freeze({
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', 'probeId', 'probeKind', 'expiresAt', 'createdAt'],
      properties: {
        _id: objectId,
        probeId: { bsonType: 'string', pattern: '^runtime-capability:[0-9a-f-]{36}$', minLength: 55, maxLength: 55 },
        probeKind: { enum: ['commit', 'abort'] },
        expiresAt: date,
        createdAt: date,
      },
    },
  }),
})

export const RUNTIME_CAPABILITY_PROBE_INDEXES = Object.freeze([
  Object.freeze({ name: 'runtime_capability_probe_id_unique', key: { probeId: 1 }, options: { unique: true } }),
  Object.freeze({ name: 'runtime_capability_probe_expiry', key: { expiresAt: 1 }, options: { expireAfterSeconds: 0 } }),
])

export function buildGovernanceCapabilityProbeMigration({ dryRun = false } = {}) {
  const operations = [
    { type: 'createCollection', collection: RUNTIME_CAPABILITY_PROBE_COLLECTION, options: { validator: RUNTIME_CAPABILITY_PROBE_DEFINITION.validator, validationLevel: 'strict', validationAction: 'error' } },
    { type: 'collMod', collection: RUNTIME_CAPABILITY_PROBE_COLLECTION, options: { validator: RUNTIME_CAPABILITY_PROBE_DEFINITION.validator, validationLevel: 'strict', validationAction: 'error' } },
    ...RUNTIME_CAPABILITY_PROBE_INDEXES.map((index) => ({ type: 'createIndex', collection: RUNTIME_CAPABILITY_PROBE_COLLECTION, ...index })),
  ]
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

async function runOperations(db, plan) {
  if (!db || typeof db.createCollection !== 'function') throw new Error('MongoDB database is required')
  for (const operation of plan) {
    if (operation.type === 'createCollection') {
      try { await db.createCollection(operation.collection, operation.options) } catch (error) { if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error }
    } else if (operation.type === 'collMod') {
      await db.command({ collMod: operation.collection, ...operation.options })
    } else {
      await db.collection(operation.collection).createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
    }
  }
  return plan
}

export async function runGovernanceCapabilityProbeMigration({ db, dryRun = false } = {}) {
  const plan = buildGovernanceCapabilityProbeMigration({ dryRun })
  return dryRun ? plan : runOperations(db, plan)
}
