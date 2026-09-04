import { MongoClient, ObjectId } from 'mongodb'
import { randomBytes } from 'node:crypto'
import { configureDns } from './scripts/configure-dns.js'
import { historicalCitationDocument } from './server/repositories/mongo/chat-repository.js'

configureDns()

const SUMMARY = { ok: false }

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

function availableBranchHasSourceName(validator) {
  try {
    const schema = validator?.$and?.[0]?.$jsonSchema
    const answered = schema?.properties?.messages?.items?.oneOf?.find((branch) => branch?.properties?.status?.enum?.includes('answered'))
    const available = answered?.properties?.citations?.items?.oneOf?.find((branch) => branch?.properties?.status?.enum?.includes('available'))
    return {
      found: Boolean(available),
      additionalProperties: available?.additionalProperties ?? null,
      properties: available?.properties ? Object.keys(available.properties) : null,
    }
  } catch {
    return { found: false, additionalProperties: null, properties: null }
  }
}

try {
  const appUri = process.env[process.env.MONGODB_URI_ENV]
  const operatorUri = process.env[process.env.MONGODB_OPERATOR_URI_ENV]
  const prodDatabase = process.env.MONGODB_DATABASE
  if (!appUri) throw new Error('App MongoDB URI is not configured')
  if (!operatorUri) throw new Error('Operator MongoDB URI is not configured')
  if (!prodDatabase || /^(admin|config|local)$/i.test(prodDatabase)) throw new Error('MONGODB_DATABASE is missing or reserved')
  SUMMARY.prodDatabase = prodDatabase

  // Phase 1: read-only inspection of prod with the least-privileged app role.
  const app = new MongoClient(appUri, { serverSelectionTimeoutMS: 15000 })
  let prodValidator = null
  try {
    await app.connect()
    const prod = app.db(prodDatabase)
    const listed = await prod.listCollections({ name: 'chatSessions' }, { nameOnly: false }).toArray()
    SUMMARY.prodHasChatSessions = listed.length > 0
    prodValidator = listed[0]?.options?.validator ?? null
    SUMMARY.prodValidationLevel = listed[0]?.options?.validationLevel ?? null
    SUMMARY.prodValidationAction = listed[0]?.options?.validationAction ?? null
    SUMMARY.prodAvailableBranch = availableBranchHasSourceName(prodValidator)
    SUMMARY.prodChatSessionCount = await prod.collection('chatSessions').estimatedDocumentCount()
    SUMMARY.prodAnsweredDocCount = await prod.collection('chatSessions').countDocuments({ 'messages.status': 'answered' })
    SUMMARY.prodNamedCitationCount = await prod.collection('chatSessions').countDocuments({
      messages: { $elemMatch: { status: 'answered', 'citations.sourceName': { $exists: true } } },
    })
    const sample = await prod.collection('chatSessions').find(
      { 'messages.status': 'answered' },
      { projection: { 'messages.citations': 1, _id: 0 } },
    ).limit(1).toArray()
    const firstCitation = sample[0]?.messages?.flatMap((message) => message.citations ?? [])?.[0] ?? null
    SUMMARY.prodSampleCitationKeys = firstCitation ? Object.keys(firstCitation) : null
    SUMMARY.prodSampleCitationHasSourceName = Boolean(firstCitation && 'sourceName' in firstCitation)
  } finally {
    await app.close()
  }

  // Phase 2: Atlas-engine write proof on a scratch DB via the operator role.
  // Prod data is never written. Scratch DB is dropped afterwards.
  const runId = randomBytes(4).readUInt32BE(0).toString(36).padStart(7, '0').slice(-5)
  const testDatabase = `techpulse_step2_test_qa121_${runId}`
  SUMMARY.testDatabase = testDatabase
  const operator = new MongoClient(operatorUri, { serverSelectionTimeoutMS: 15000 })
  try {
    await operator.connect()
    const buildInfo = await operator.db('admin').command({ buildinfo: 1 }).catch(() => null)
    SUMMARY.atlasVersion = buildInfo?.version ?? null
    const scratch = operator.db(testDatabase)
    const collectionName = 'chatSessions_repro'
    await scratch.createCollection(collectionName, {
      validator: prodValidator,
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
    if (testDatabase.startsWith('techpulse_step2_test_qa121_') && testDatabase !== prodDatabase) {
      await operator.db(testDatabase).dropDatabase().catch(() => {})
      SUMMARY.cleanup = 'dropped'
    }
    await operator.close()
  }
  SUMMARY.ok = true
} catch (error) {
  SUMMARY.error = redact(error?.message ?? String(error))
  process.exitCode = 1
} finally {
  done()
}
