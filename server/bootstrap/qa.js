import { createQaService } from '../application/qa/service.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { MongoChatRepository } from '../repositories/mongo/chat-repository.js'
import { createProviderAdmission } from '../ai/provider-admission.js'
import { MongoProviderAdmissionRepository } from '../repositories/mongo/provider-admission-repository.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../scripts/migrations/chat-sessions.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

export async function assertChatSessionsReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((item) => [item.name, item]))
  for (const [name, definition] of Object.entries(CHAT_SESSION_COLLECTIONS)) {
    const actual = collectionMap.get(name)
    if (!actual || actual.options?.validationLevel !== 'strict' || actual.options?.validationAction !== 'error' || stableJson(actual.options?.validator) !== stableJson(definition.validator)) throw new Error('chat-sessions migration is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (CHAT_SESSION_INDEXES[name].some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('chat-sessions indexes are not ready')
  }
}

export async function createConfiguredQaService({ context, providerRegistry = { domains: [], routes: [] }, providerAdapters, providerAdmission, rateLimitAdmission, maintenanceRegistry, routes = {}, now = () => new Date() } = {}) {
  await assertChatSessionsReady(context)
  if (typeof maintenanceRegistry?.register !== 'function') throw new Error('Q&A maintenance registry is not ready')
  if (!providerAdapters?.llmProvider?.answer || !providerAdapters?.llmProvider?.verifySupport) throw new Error('Q&A provider adapters are not ready')
  const articleRepository = new MongoArticleRepository(context)
  const chatRepository = new MongoChatRepository({ ...context, now })
  const admission = providerAdmission ?? (providerRegistry.domains?.length > 0 ? createProviderAdmission({ repository: new MongoProviderAdmissionRepository(context), registry: providerRegistry, now }) : null)
  if (typeof admission?.run !== 'function') throw new Error('Q&A provider admission is not ready')
  const enabled = (providerRegistry.routes ?? []).filter((route) => route.enabled === true)
  const eligibleRouteIds = new Set(enabled.filter((route) => route.capability === 'zdr-verified').map(({ routeId }) => routeId))
  const primary = routes.primary ?? enabled.find((route) => route.capability === 'zdr-verified' && route.provider === 'opencode-zen')?.routeId
  const fallback = routes.fallback ?? enabled.find((route) => route.capability === 'zdr-verified' && route.routeId !== primary)?.routeId
  const support = routes.support ?? fallback ?? primary
  if (!primary || !eligibleRouteIds.has(primary)) throw new Error('Q&A ZDR provider route is not ready')
  const supportVerifier = providerAdapters.llmProvider.verifySupport
    ? ({ route, paragraphs, evidenceBlocks, evidenceMap }) => providerAdapters.llmProvider.verifySupport({ route, input: JSON.stringify({ paragraphs, evidenceBlocks, evidenceMap }), locale: 'vi', tools: [] })
    : undefined
  maintenanceRegistry.register('purge-answer-attempts', ({ cutoff, limit }) => chatRepository.purgeDueAnswerAttempts({ cutoff, limit }))
  return createQaService({ articleRepository, chatRepository, providerAdmission: admission, providerAdapters, rateLimitAdmission, supportVerifier, routes: { primary, fallback, support }, now })
}
