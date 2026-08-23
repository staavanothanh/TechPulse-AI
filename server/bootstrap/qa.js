import { createQaService } from '../application/qa/service.js'
import { MongoArticleRepository } from '../repositories/mongo/article-repository.js'
import { MongoChatRepository } from '../repositories/mongo/chat-repository.js'
import { createProviderAdmission } from '../ai/provider-admission.js'
import { createProviderRouter } from '../ai/provider-router.js'
import { MongoProviderAdmissionRepository } from '../repositories/mongo/provider-admission-repository.js'
import { MongoProviderFailureDomainRepository } from '../repositories/mongo/provider-failure-domain-repository.js'
import { CHAT_SESSION_COLLECTIONS, CHAT_SESSION_INDEXES } from '../../scripts/migrations/chat-sessions.js'
import { PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR } from '../../scripts/migrations/provider-routing-v2.js'
import { exactMongoIndex } from '../repositories/mongo/index-contract.js'
import { assertProviderRoutingReady } from './provider-routing.js'

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

const QA_CAPABILITIES = new Set(['zdr-verified', 'nonconfidential'])

function requireQaWorkloadPolicies(providerRegistry) {
  const policies = providerRegistry?.workloadPolicies
  if (!Array.isArray(policies)) throw new Error('Q&A workload policies are not ready')
  if (new Set(policies.map((policy) => policy?.workloadId)).size !== policies.length) throw new Error('Q&A workload policies are not ready')
  const byId = new Map(policies.map((policy) => [policy?.workloadId, policy]))
  const generation = byId.get('qa-generation')
  const support = byId.get('qa-support')
  if (!generation || generation.operation !== 'answer' || !QA_CAPABILITIES.has(generation.requiredCapability) || generation.maxExternalAttempts !== 2
    || !support || support.operation !== 'support' || support.requiredCapability !== generation.requiredCapability || support.maxExternalAttempts !== 1) throw new Error('Q&A workload policies are not ready: qa-generation and qa-support are required')
  return Object.freeze({ policies, generation, support })
}

export async function assertChatSessionsReady(context) {
  if (!context?.db) throw new Error('Mongo context is required')
  const collections = await context.db.listCollections({}, { nameOnly: false }).toArray()
  const collectionMap = new Map(collections.map((item) => [item.name, item]))
  for (const [name, definition] of Object.entries(CHAT_SESSION_COLLECTIONS)) {
    const actual = collectionMap.get(name)
    const acceptedValidators = name === 'answerAttempts' ? [definition.validator, PROVIDER_ROUTING_ANSWER_ATTEMPT_VALIDATOR] : [definition.validator]
    if (!actual || actual.options?.validationLevel !== 'strict' || actual.options?.validationAction !== 'error' || !acceptedValidators.some((validator) => stableJson(actual.options?.validator) === stableJson(validator))) throw new Error('chat-sessions migration is not ready')
    const actualByName = new Map((await context.db.collection(name).indexes()).map((index) => [index.name, index]))
    if (CHAT_SESSION_INDEXES[name].some((expected) => !exactMongoIndex(actualByName.get(expected.name), expected))) throw new Error('chat-sessions indexes are not ready')
  }
}

export async function createConfiguredQaService({ context, providerRegistry = { domains: [], routes: [] }, providerAdapters, providerAdmission, providerRouter, queryEmbedding, rateLimitAdmission, maintenanceRegistry, now = () => new Date(), verifySchema = assertChatSessionsReady, verifyProviderSchema = assertProviderRoutingReady } = {}) {
  await verifySchema(context)
  await verifyProviderSchema(context)
  if (typeof maintenanceRegistry?.register !== 'function') throw new Error('Q&A maintenance registry is not ready')
  if (!providerAdapters?.llmProvider?.answer || !providerAdapters?.llmProvider?.verifySupport) throw new Error('Q&A provider adapters are not ready')
  const articleRepository = new MongoArticleRepository(context)
  const chatRepository = new MongoChatRepository({ ...context, now })
  const admission = providerAdmission ?? (providerRegistry.domains?.length > 0 ? createProviderAdmission({ repository: new MongoProviderAdmissionRepository(context), failureDomainRepository: new MongoProviderFailureDomainRepository(context), registry: providerRegistry, now }) : null)
  if (typeof admission?.run !== 'function') throw new Error('Q&A provider admission is not ready')
  const { policies: workloadPolicies, generation: generationPolicy } = requireQaWorkloadPolicies(providerRegistry)
  const configuredRouter = providerRouter ?? createProviderRouter({ workloadPolicies, admission, now })
  const safeQueryEmbedding = queryEmbedding?.capability === 'zdr-verified' ? queryEmbedding : undefined
  const supportVerifier = providerAdapters.llmProvider.verifySupport
    ? ({ route, question, addressesQuestion, paragraphs, evidenceBlocks, evidenceMap }) => providerAdapters.llmProvider.verifySupport({ route, input: JSON.stringify({ question, addressesQuestion, paragraphs, evidenceBlocks, evidenceMap }), locale: 'vi', tools: [] })
    : undefined
  maintenanceRegistry.register('purge-answer-attempts', ({ cutoff, limit }) => chatRepository.purgeDueAnswerAttempts({ cutoff, limit }))
  return createQaService({ articleRepository, chatRepository, providerRouter: configuredRouter, providerAdapters, queryEmbedding: safeQueryEmbedding, privacyCapability: generationPolicy.requiredCapability, rateLimitAdmission, supportVerifier, now })
}
