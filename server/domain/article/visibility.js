import { evaluateContentPolicy } from '../policy/content-policy.js'

export function isSourceProductionEligible(source) {
  if (!source || source.operationalStatus !== 'active' || !['permitted', 'metadata-only'].includes(source.licenseStatus)) return false
  if (source.technicalCheck?.status !== 'passed') return false
  const gate = evaluateContentPolicy(source, 'metadata')
  return gate.allowed === true
}

export function currentSourceVisibilityMatch(path = 'source') {
  return {
    [`${path}.operationalStatus`]: 'active',
    [`${path}.licenseStatus`]: { $in: ['permitted', 'metadata-only'] },
    [`${path}.technicalCheck.status`]: 'passed',
  }
}

export function currentArticleVisibilityFilter({ sourcePath = 'source' } = {}) {
  return { status: 'published', ...currentSourceVisibilityMatch(sourcePath) }
}

function hasCitationEvidenceMetadata(article) {
  if (typeof article?.titleOriginal !== 'string' || !article.titleOriginal.trim() || article.publishedAt === undefined || article.publishedAt === null) return false
  try {
    const parsedUrl = new URL(article.originalUrl)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) return false
    const publishedAt = article.publishedAt instanceof Date ? article.publishedAt : new Date(article.publishedAt)
    return !Number.isNaN(publishedAt.getTime())
  } catch {
    return false
  }
}

export function canUseQnaEvidence(article, source) {
  const rights = article?.rightsSnapshot
  const currentPolicy = Boolean(rights && rights.sourcePolicyVersion === source?.policyVersion && rights.licenseStatus === source?.licenseStatus && rights.llmInputScope === source?.llmInputScope)
  const providerScope = source?.llmInputScope === 'metadata' || source?.llmInputScope === 'excerpt' || source?.llmInputScope === 'fulltext-temporary'
  return Boolean(article && article.status === 'published' && source && isSourceProductionEligible(source) && ['primary', 'editorial'].includes(source.authorityTier) && article.evidenceEligible === true && currentPolicy && providerScope && hasCitationEvidenceMetadata(article))
}

export function qnaEvidenceFilter({ sourcePath = 'source' } = {}) {
  return { ...currentArticleVisibilityFilter({ sourcePath }), authorityTier: { $in: ['primary', 'editorial'] }, evidenceEligible: true, [`${sourcePath}.authorityTier`]: { $in: ['primary', 'editorial'] } }
}
