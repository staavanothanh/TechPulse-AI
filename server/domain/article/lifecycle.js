import { ArticleError } from './errors.js'
import { evaluateMediaPolicy } from '../policy/media-policy.js'
import { isSourceProductionEligible } from './visibility.js'

const SAFE_REASON = /^[a-z0-9_:-]{1,128}$/

export function hideArticle(article, reason = 'article_hidden') {
  if (!article || !SAFE_REASON.test(reason)) throw new ArticleError('article_invalid_transition', 'Article hide reason is invalid', { status: 422 })
  if (article.status === 'removed') throw new ArticleError('article_invalid_transition', 'Removed article cannot be hidden', { status: 409 })
  return Object.freeze({ ...article, status: 'hidden', hiddenReason: reason, leadMediaStatus: article.leadMedia ? 'hidden' : 'none', updatedAt: new Date() })
}

export function restoreArticle(article, { source, now = new Date() } = {}) {
  if (!article || article.status === 'removed') throw new ArticleError('article_invalid_transition', 'Removed article cannot be restored', { status: 409 })
  const eligible = isSourceProductionEligible(source)
  const mediaAllowed = eligible && article.leadMedia && article.leadMedia.sourcePolicyVersion === source.policyVersion && evaluateMediaPolicy(source, article.leadMedia).allowed
  return Object.freeze({ ...article, status: eligible ? 'published' : 'review-needed', leadMediaStatus: article.leadMedia ? (mediaAllowed ? 'available' : 'hidden') : 'none', hiddenReason: undefined, updatedAt: now })
}

export function removeArticle(article, { now = new Date() } = {}) {
  if (!article) throw new ArticleError('article_invalid_transition', 'Article is required', { status: 422 })
  const safeArticle = { ...article }
  for (const field of ['raw', 'rawHtml', 'html', 'body', 'fullText', 'content', 'translatedFullText', 'mediaBinary', 'binary', 'imageBinary', 'videoBinary', 'audioBinary', 'base64', 'gridFsId', 'providerPayload']) delete safeArticle[field]
  return Object.freeze({ ...safeArticle, status: 'removed', leadMedia: null, leadMediaStatus: 'none', summaryVi: null, summaryBasis: null, summaryModel: null, summaryInputHash: null, summarySourcePolicyVersion: null, summaryGeneratedAt: null, summaryError: null, summaryStatus: 'removed', embedding: null, embeddingModel: null, embeddingDimensions: null, embeddingInputHash: null, embeddingVersion: null, embeddingSourcePolicyVersion: null, embeddedAt: null, embeddingError: null, embeddingStatus: 'removed', removedAt: now, updatedAt: now })
}
