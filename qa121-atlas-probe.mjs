import { MongoClient, ObjectId } from 'mongodb'
import { randomBytes } from 'node:crypto'
import { configureDns } from './scripts/configure-dns.js'
import { CHAT_SESSION_COLLECTIONS } from './scripts/migrations/chat-sessions.js'
import { historicalCitationDocument } from './server/repositories/mongo/chat-repository.js'

configureDns()

const SUMMARY = { ok: false }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function redact(value) {
  return String(value ?? '').replace(/\/\/[^/\s@]*@/g, '//***@').slice(0, 300)
}

function done() {
  console.log(JSON.stringify(SUMMARY))
}

const NOW = new Date('2026-08-12T00:00:00.000Z')
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function persistedCitation() {
  return historicalCitationDocument({
    id: 'C1',
    status: 'available',
    articleId: new ObjectId('507f1f77bcf86cd799439204').toHexString(),
    sourceId: new ObjectId('507f1f77bcf86cd799439205').toHexString(),
    sourceName: 'Nguon editorial',
    titleOriginal: 'Bai viet',
    originalUrl: 'https://example.test/articles/one',
    publishedAt: NOW.toISOString(),
  })
}

function sessionDocument(citation) {
  const current = new Date(NOW)
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    title: null,
    scope: { topics: ['ai'] },
    messages: [
      { id: 'u1', role: 'user', text: 'Cau hoi?', createdAt: current },
      {
        id: 'a1',
        role: 'assistant',
        status: 'answered',
        paragraphs: [{ text: 'Ket luan co can cu.', citationIds: ['C1'] }],
        citations: [citation],
        refusalReason: null,
        createdAt: current,
      },
    ],
    messageCount: 2,
    expiresAt: new Date(current.getTime() + THIRTY_DAYS_MS),
    createdAt: current,
    updatedAt: current,
  }
}

try {
  const uriEnvName = process.env.MONGODB_URI_ENV
  if (!uriEnvName || !/^[A-Z][A-Z0-9_]{1,127}$/.test(uriEnvName)) throw new Error('MONGODB_URI_ENV is missing or invalid')
  const uri = process.env[uriEnvName]
  if (!uri) throw new Error('Referenced MongoDB URI is not configured')
  const prodDatabase = process.env.MONGODB_DATABASE
  if (!prodDatabase || /^(admin|config|local)$/i.test(prodDatabase)) throw new Error('MONGODB_DATABASE is missing or reserved')

  const runId = randomBytes(4).readUInt32BE(0).toString(36).padStart(7, '0').slice(-5)
  const testDatabase = `techpulse_step2_test_qa121_${runId}`
  if (testDatabase === prodDatabase) throw new Error('Test database collides with production database')
  SUMMARY.testDatabase = testDatabase
  SUMMARY.prodDatabase = prodDatabase

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 })
  try {
    await client.connect()
    const hello = await client.db('admin').command({ hello: 1 })
    SUMMARY.atlasVersion = hello.version ?? null

    const prod = client.db(prodDatabase)
    const listed = await prod.listCollections({ name: 'chatSessions' }, { nameOnly: false }).toArray()
    const installed = listed[0]?.options
    SUMMARY.prodHasChatSessions = listed.length > 0
    SUMMARY.prodValidationLevel = installed?.validationLevel ?? null
    SUMMARY.prodValidationAction = installed?.validationAction ?? null
    const codeValidator = CHAT_SESSION_COLLECTIONS.chatSessions.validator
    SUMMARY.prodValidatorMatchesCode = listed.length > 0
      && stableJson(installed?.validator) === stableJson(codeValidator)

    try {
      SUMMARY.prodNamedCitationCount = await prod.collection('chatSessions').countDocuments({
        messages: { $elemMatch: { status: 'answered', 'citations.sourceName': { $exists: true } } },
      })
    } catch {
      SUMMARY.prodNamedCitationCount = 'unavailable'
    }

    const scratchValidator = installed?.validator ?? codeValidator
    const scratch = client.db(testDatabase)
    const collectionName = 'chatSessions_repro'
    await scratch.createCollection(collectionName, {
      validator: scratchValidator,
      validationLevel: 'strict',
      validationAction: 'error',
    })
    const collection = scratch.collection(collectionName)

    const plain = persistedCitation()
    delete plain.sourceName
    await collection.insertOne(sessionDocument(plain))
    SUMMARY.plainInsert = 'ok'

    try {
      await collection.insertOne(sessionDocument(persistedCitation()))
      SUMMARY.namedInsert = 'unexpectedly-ok'
    } catch (error) {
      SUMMARY.namedInsert = {
        code: error?.code ?? null,
        codeName: error?.codeName ?? null,
        message: redact(error?.message),
      }
    }
  } finally {
    const scratch = client.db(testDatabase)
    if (testDatabase.startsWith('techpulse_step2_test_qa121_') && testDatabase !== prodDatabase) {
      await scratch.dropDatabase().catch(() => {})
      SUMMARY.cleanup = 'dropped'
    }
    await client.close()
  }
  SUMMARY.ok = true
} catch (error) {
  SUMMARY.error = redact(error?.message ?? String(error))
  process.exitCode = 1
} finally {
  done()
}
