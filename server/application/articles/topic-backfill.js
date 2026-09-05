function boundedLimit(value) {
  const limit = value === undefined ? 100 : Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Topic backfill limit is invalid')
  return limit
}

function safeFailureReason(error) {
  return typeof error?.code === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(error.code)
    ? error.code.toLowerCase()
    : 'topic_backfill_failed'
}

function skippedReport(reason, { scanned = 0 } = {}) {
  return Object.freeze({
    outcome: 'skipped',
    scanned,
    migrated: 0,
    wouldUpdate: 0,
    skipped: 0,
    conflict: 0,
    unclassified: 0,
    embeddingInvalidated: 0,
    nextCursor: null,
    skippedReasons: { [reason]: 1 },
    failedReasons: {},
  })
}

export function createArticleTopicBackfillWorker({ articleRepository, now = () => new Date() } = {}) {
  if (!articleRepository || typeof articleRepository.findArticleTopicCandidates !== 'function') throw new Error('Article repository is required')
  if (typeof articleRepository.backfillArticleTopicCandidates !== 'function') throw new Error('Article repository backfill method is required')

  return Object.freeze({
    async run({ cursor = null, dryRun = true, limit } = {}) {
      if (typeof dryRun !== 'boolean') throw new Error('Topic backfill dry-run flag is invalid')
      const bounded = boundedLimit(limit)
      if (cursor !== null && cursor !== undefined && typeof cursor !== 'string' && !(cursor && typeof cursor === 'object' && '_id' in cursor)) throw new Error('Topic backfill cursor is invalid')
      const started = now()
      if (!(started instanceof Date) || Number.isNaN(started.getTime())) throw new Error('Topic backfill clock is invalid')

      const page = await articleRepository.findArticleTopicCandidates({ cursor, limit: bounded })
      const articles = Array.isArray(page?.articles) ? page.articles : []
      if (articles.length === 0) {
        return Object.freeze({
          outcome: 'completed',
          scanned: 0,
          migrated: 0,
          wouldUpdate: 0,
          skipped: 0,
          conflict: 0,
          unclassified: 0,
          embeddingInvalidated: 0,
          nextCursor: null,
          hasMore: false,
          skippedReasons: {},
          failedReasons: {},
        })
      }
      let report
      try {
        report = await articleRepository.backfillArticleTopicCandidates({ articles, dryRun, limit: bounded })
      } catch (error) {
        return skippedReport(safeFailureReason(error), { scanned: articles.length })
      }
      return Object.freeze({
        outcome: 'completed',
        ...report,
        hasMore: Boolean(page?.nextCursor),
        completedAt: now(),
      })
    },
  })
}