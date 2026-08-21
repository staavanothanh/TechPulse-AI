import { pathToFileURL } from 'node:url'
import { configureDns } from '../scripts/configure-dns.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'

async function main() {
  configureDns()
  const operatorEnv = process.env.MONGODB_OPERATOR_URI_ENV
  const environment = { ...process.env, MONGODB_URI_ENV: operatorEnv }
  let context
  try {
    const runtime = validateRuntimeConfiguration(environment)
    context = await getMongoContext(runtime, environment)
    const db = context.db
    const sources = await db.collection('sources').find({}, {
      projection: { _id: 1, sourceKey: 1, connectorType: 1, operationalStatus: 1, licenseStatus: 1, llmInputScope: 1, storageScope: 1 },
    }).sort({ sourceKey: 1 }).toArray()
    const articleStatuses = await db.collection('articles').aggregate([
      { $group: { _id: { connector: '$connectorType', summary: '$summaryStatus', embedding: '$embeddingStatus' }, count: { $sum: 1 } } },
    ]).toArray()
    const topicMedia = await db.collection('articles').aggregate([
      { $project: { topicCount: { $size: { $ifNull: ['$topics', []] } }, media: '$leadMediaStatus' } },
      { $group: { _id: null, articles: { $sum: 1 }, withTopics: { $sum: { $cond: [{ $gt: ['$topicCount', 0] }, 1, 0] } }, mediaAvailable: { $sum: { $cond: [{ $eq: ['$media', 'available'] }, 1, 0] } } } },
    ]).toArray()
    const jobs = await db.collection('indexingJobs').aggregate([
      { $group: { _id: { task: '$task', status: '$status' }, count: { $sum: 1 } } },
    ]).toArray()
    const preserved = {
      users: await db.collection('users').countDocuments(),
      sessions: await db.collection('sessions').countDocuments(),
      accountDeletionRequests: await db.collection('accountDeletionRequests').countDocuments(),
      adminAuditLogs: await db.collection('adminAuditLogs').countDocuments(),
      hmacKeyLifecycleSnapshots: await db.collection('hmacKeyLifecycleSnapshots').countDocuments(),
    }
    console.log(JSON.stringify({
      sources: sources.map(({ _id, storageScope, ...source }) => ({ ...source, summaryStorage: storageScope?.summary, embeddingStorage: storageScope?.embedding })),
      articleStatuses,
      topicMedia: topicMedia[0] ?? {},
      jobs,
      preserved,
    }))
  } catch {
    console.error(JSON.stringify({ verified: false, reason: 'operator_or_database_error' }))
    process.exitCode = 1
  } finally {
    await closeMongoConnection()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
