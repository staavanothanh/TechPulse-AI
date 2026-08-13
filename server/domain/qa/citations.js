function idValue(value) {
  return value?.toHexString?.() ?? String(value ?? '')
}

function dateValue(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Citation date is invalid')
  return date.toISOString()
}

function citationRecord(evidence, index) {
  const article = evidence?.article
  const source = evidence?.source
  const articleId = idValue(article?.id ?? article?._id)
  const sourceId = idValue(source?.id ?? source?._id ?? source?.sourceId)
  let originalUrl
  try {
    const parsed = new URL(article?.originalUrl)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid')
    originalUrl = parsed.toString()
  } catch { throw new Error('Citation evidence is unavailable') }
  if (!articleId || !sourceId || typeof article?.titleOriginal !== 'string' || !article.titleOriginal || article.publishedAt === undefined) throw new Error('Citation evidence is unavailable')
  return {
    id: `C${index + 1}`,
    articleId,
    sourceId,
    sourceName: typeof source?.name === 'string' ? source.name : '',
    titleOriginal: article.titleOriginal,
    originalUrl,
    author: typeof article.author === 'string' ? article.author : null,
    publishedAt: dateValue(article.publishedAt),
    sourceLanguage: typeof article.sourceLanguage === 'string' ? article.sourceLanguage : 'unknown',
  }
}

export function validateParagraphCitations({ paragraphs, citationIds, evidenceBlocks } = {}) {
  if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > 12 || !Array.isArray(citationIds) || !Array.isArray(evidenceBlocks)) throw new Error('Answer paragraph citation coverage is invalid')
  const known = new Set(citationIds)
  const blockCitationIds = new Map(evidenceBlocks.map(({ id, citationId }) => [id, citationId]))
  return paragraphs.map((paragraph) => {
    const valid = paragraph && typeof paragraph.text === 'string' && paragraph.text.trim().length > 0 && paragraph.text.length <= 2000 && Array.isArray(paragraph.citationIds) && paragraph.citationIds.length >= 1 && paragraph.citationIds.length <= 10 && new Set(paragraph.citationIds).size === paragraph.citationIds.length && paragraph.citationIds.every((id) => typeof id === 'string' && known.has(id)) && Array.isArray(paragraph.evidenceBlockIds) && paragraph.evidenceBlockIds.length >= 1 && paragraph.evidenceBlockIds.length <= 10 && new Set(paragraph.evidenceBlockIds).size === paragraph.evidenceBlockIds.length && paragraph.evidenceBlockIds.every((id) => typeof id === 'string' && blockCitationIds.has(id) && paragraph.citationIds.includes(blockCitationIds.get(id)))
    if (!valid) throw new Error('Answer paragraph citation coverage is invalid')
    return { text: paragraph.text, citationIds: [...paragraph.citationIds], evidenceBlockIds: [...paragraph.evidenceBlockIds] }
  })
}

export function hydrateAnswerCitations({ citationIds, evidence = [] } = {}) {
  if (!Array.isArray(citationIds) || citationIds.length < 1 || citationIds.length > 50) throw new Error('Answer citations are invalid')
  const map = new Map(evidence.map((item, index) => [`C${index + 1}`, item]))
  return citationIds.map((id) => {
    const record = map.get(id)
    if (!record) throw new Error('Answer citation does not resolve')
    return citationRecord(record, Number(String(id).slice(1)) - 1)
  })
}

export function serializeHistoricalCitation(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string') throw new Error('Historical citation is invalid')
  if (value.status === 'available') {
    const parsedUrl = new URL(value.originalUrl)
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) throw new Error('Historical citation URL is invalid')
    return {
      id: value.id,
      status: 'available',
      articleId: idValue(value.articleId),
      sourceId: idValue(value.sourceId),
      originalUrl: parsedUrl.toString(),
      titleOriginal: value.titleOriginal,
      publishedAt: dateValue(value.publishedAt),
    }
  }
  const reason = value.unavailableReason ?? value.status
  if (!['takedown', 'source-policy', 'article-removed'].includes(reason)) throw new Error('Historical citation reason is invalid')
  const result = { id: value.id, status: 'unavailable', unavailableReason: reason }
  if (value.articleId !== undefined) result.articleId = idValue(value.articleId)
  if (value.sourceId !== undefined) result.sourceId = idValue(value.sourceId)
  return result
}
