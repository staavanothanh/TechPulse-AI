import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { ObjectId } from 'mongodb'
import { createSourceAuditEvent } from '../server/audit/source-writer.js'
import { assertSourcesReady } from '../server/bootstrap/sources.js'
import { validateRuntimeConfiguration } from '../server/config/runtime.js'
import { createDraftSource } from '../server/domain/source/state-machine.js'
import { getMongoContext, closeMongoConnection } from '../server/repositories/mongo/connection.js'
import { MongoSourceRepository } from '../server/repositories/mongo/source-repository.js'
import { configureDns } from './configure-dns.js'

export const SOURCE_SEEDS = Object.freeze([
  Object.freeze({ name: 'The Verge Technology', sourceKey: 'rss:the-verge', publisherName: 'The Verge', domain: 'theverge.com', connectorType: 'rss', accessMethod: 'rss', authorityTier: 'editorial', connectorConfig: Object.freeze({ kind: 'rss', feedUrl: 'https://www.theverge.com/rss/index.xml', batchSize: 20 }) }),
  Object.freeze({ name: 'arXiv Computer Science AI', sourceKey: 'arxiv:cs-ai', publisherName: 'arXiv', domain: 'arxiv.org', connectorType: 'arxiv', accessMethod: 'api', authorityTier: 'primary', connectorConfig: Object.freeze({ kind: 'arxiv', arxivQuery: 'cat:cs.AI', batchSize: 25 }) }),
  Object.freeze({ name: 'Hacker News Top Stories', sourceKey: 'hn:topstories', publisherName: 'Hacker News', domain: 'news.ycombinator.com', connectorType: 'hacker-news', accessMethod: 'api', authorityTier: 'community-signal', connectorConfig: Object.freeze({ kind: 'hacker-news', hackerNewsStream: 'topstories', batchSize: 20 }) }),
])

function deterministicId(sourceKey) {
  return new ObjectId(createHash('sha256').update(`techpulse-source-seed\u0000${sourceKey}`).digest().subarray(0, 12)).toHexString()
}

export function buildSeedDrafts({ now = new Date() } = {}) {
  return SOURCE_SEEDS.map((definition) => createDraftSource(definition, { id: deterministicId(definition.sourceKey), now }))
}

export async function seedSources({ context, now = new Date() } = {}) {
  await assertSourcesReady(context)
  const repository = new MongoSourceRepository(context)
  const actor = { id: 'system:source-seed', role: 'system-worker' }
  const outcomes = []
  for (const source of buildSeedDrafts({ now })) {
    const audit = createSourceAuditEvent({ actor, action: 'source_created', targetId: source.id, changedFields: ['sourceKey', 'operationalStatus', 'policyVersion'], reasonCode: 'source_created', request: { serverRequestId: `seed:${source.sourceKey}` } })
    outcomes.push(await repository.seedDraft({ source, audit }))
  }
  return outcomes
}

async function main() {
  configureDns()
  try {
    const operatorUriEnv = process.env.MONGODB_OPERATOR_URI_ENV
    if (typeof operatorUriEnv !== 'string' || !/^[A-Z][A-Z0-9_]{2,127}$/.test(operatorUriEnv) || typeof process.env[operatorUriEnv] !== 'string' || process.env[operatorUriEnv].length === 0) throw new Error('operator credential is required')
    const runtime = validateRuntimeConfiguration({ ...process.env, MONGODB_URI_ENV: operatorUriEnv })
    const context = await getMongoContext(runtime, process.env)
    const outcomes = await seedSources({ context })
    console.log(JSON.stringify({ sources: outcomes.length, seeded: outcomes.filter(({ seeded }) => seeded).length, existing: outcomes.filter(({ existing }) => existing).length }))
  } catch {
    console.error('Source seed failed: runtime_or_database_error')
    process.exitCode = 1
  } finally { await closeMongoConnection() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
