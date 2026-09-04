import { CHAT_SESSION_COLLECTIONS } from './chat-sessions.js'

// Optional sourceName permitted only on the historical-citation branch whose
// status is 'available'. Every other constraint of the base chatSessions
// validator is preserved verbatim; sourceName is never added to any required
// array and all non-available branches / $and expressions are untouched.

const sourceName = Object.freeze({ bsonType: 'string', minLength: 1, maxLength: 120 })

const baseChatSessionsValidator = CHAT_SESSION_COLLECTIONS.chatSessions.validator
const baseSchema = baseChatSessionsValidator.$and[0].$jsonSchema
const messagesProperty = baseSchema.properties.messages
const messageOneOf = messagesProperty.items.oneOf
const answeredMessage = messageOneOf[1]
const citationsProperty = answeredMessage.properties.citations
const historicalCitation = citationsProperty.items
const availableBranch = historicalCitation.oneOf[0]

const availableCitationWithSourceName = Object.freeze({
  ...availableBranch,
  properties: Object.freeze({
    ...availableBranch.properties,
    sourceName,
  }),
})

const historicalCitationWithSourceName = Object.freeze({
  ...historicalCitation,
  oneOf: Object.freeze([availableCitationWithSourceName, ...historicalCitation.oneOf.slice(1)]),
})

const answeredMessageWithSourceName = Object.freeze({
  ...answeredMessage,
  properties: Object.freeze({
    ...answeredMessage.properties,
    citations: Object.freeze({ ...citationsProperty, items: historicalCitationWithSourceName }),
  }),
})

const messageWithSourceName = Object.freeze({
  ...messagesProperty.items,
  oneOf: Object.freeze([messageOneOf[0], answeredMessageWithSourceName, messageOneOf[2]]),
})

export const CHAT_SESSION_SOURCE_NAME_VALIDATOR = Object.freeze({
  ...baseChatSessionsValidator,
  $and: Object.freeze([
    Object.freeze({
      ...baseChatSessionsValidator.$and[0],
      $jsonSchema: Object.freeze({
        ...baseSchema,
        properties: Object.freeze({
          ...baseSchema.properties,
          messages: Object.freeze({ ...messagesProperty, items: messageWithSourceName }),
        }),
      }),
    }),
    ...baseChatSessionsValidator.$and.slice(1),
  ]),
})

export function buildChatSessionsSourceNameMigration({ dryRun = false } = {}) {
  const operations = [
    {
      type: 'collMod',
      collection: 'chatSessions',
      options: {
        validator: CHAT_SESSION_SOURCE_NAME_VALIDATOR,
        validationLevel: 'strict',
        validationAction: 'error',
      },
    },
  ]
  return dryRun ? operations.map((operation) => ({ ...operation, dryRun: true })) : operations
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export async function assertChatSessionsSourceNameMigrationSafe({ db, target } = {}) {
  if (target !== 'chat-sessions') return
  if (typeof db?.listCollections !== 'function') throw new Error('MongoDB database is required')
  const collections = await db.listCollections({ name: 'chatSessions' }, { nameOnly: false }).toArray()
  const installed = collections.find((collection) => collection.name === 'chatSessions')?.options?.validator
  if (stableJson(installed) === stableJson(CHAT_SESSION_SOURCE_NAME_VALIDATOR)) throw new Error('Migration target chat-sessions would downgrade chat-sessions-source-name-v1')
}

async function assertPredecessor(db) {
  if (typeof db.listCollections !== 'function') throw new Error('MongoDB database is required')
  const collections = await db.listCollections({}, { nameOnly: false }).toArray()
  const byName = new Map(collections.map((collection) => [collection.name, collection]))
  const installed = byName.get('chatSessions')?.options?.validator
  const accepted = [baseChatSessionsValidator, CHAT_SESSION_SOURCE_NAME_VALIDATOR]
  if (!accepted.some((validator) => stableJson(installed) === stableJson(validator))) {
    throw new Error('chat-sessions migration must be applied before chat-sessions-source-name-v1')
  }
}

export async function runChatSessionsSourceNameMigration({ db, dryRun = false } = {}) {
  const plan = buildChatSessionsSourceNameMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.command !== 'function') throw new Error('MongoDB database is required')
  await assertPredecessor(db)
  for (const operation of plan) await db.command({ collMod: operation.collection, ...operation.options })
  return plan
}
