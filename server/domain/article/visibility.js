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

export function canUseQnaEvidence(article, source) {
  return Boolean(article && article.status === 'published' && source && isSourceProductionEligible(source) && ['primary', 'editorial'].includes(source.authorityTier) && article.evidenceEligible === true)
}

export function qnaEvidenceFilter({ sourcePath = 'source' } = {}) {
  return { ...currentArticleVisibilityFilter({ sourcePath }), authorityTier: { $in: ['primary', 'editorial'] }, evidenceEligible: true, [`${sourcePath}.authorityTier`]: { $in: ['primary', 'editorial'] } }
}
