import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('provider-routing-v2 database role readiness', () => {
  it('requires provider state and article/answer runtime privileges under --require-role', () => {
    const source = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    for (const collection of ['providerAdmissionStates', 'providerFailureDomainStates', 'articles', 'answerAttempts']) {
      expect(source).toContain(`collection: '${collection}'`)
    }
    expect(source).toMatch(/provider admission state.*required: \['find', 'insert', 'update', 'listIndexes', 'listCollections'\]/)
    expect(source).toMatch(/provider failure-domain state.*required: \['find', 'insert', 'update', 'listIndexes', 'listCollections'\]/)
    expect(source).toMatch(/provider admission state.*forbidden: \['remove', 'delete'\]/)
    expect(source).toMatch(/provider failure-domain state.*forbidden: \['remove', 'delete'\]/)
    expect(source).toMatch(/provider article path.*required: \['find', 'update', 'listIndexes', 'listCollections'\]/)
    expect(source).toMatch(/provider answer path.*required: \['find', 'insert', 'update', 'listIndexes', 'listCollections'\]/)
    expect(source).not.toMatch(/target === 'provider-routing-v2'\)\)\s*\{\s*roleStatus = 'not-requested'/)
    expect(source).toContain('provider-routing role privileges unavailable')
    expect(source).toContain('probeProviderRoutingRoleCapabilities')
    expect(source).toMatch(/collection\('providerAdmissionStates'\)[\s\S]*insertOne[\s\S]*findOne[\s\S]*updateOne/)
    expect(source).toMatch(/collection\('providerFailureDomainStates'\)[\s\S]*insertOne[\s\S]*findOne[\s\S]*updateOne/)
    expect(source).toMatch(/provider-routing runtime capability failed/)
  })

  it('probes the cooldown range in compound-index order without a blocking sort', () => {
    const source = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toMatch(
      /'provider_failure_domain_cooldown',[\s\S]*\{ state: 'open', cooldownUntil: \{ \$lte: new Date\(\) \} \},[\s\S]*\{ cooldownUntil: 1, _id: 1 \},[\s\S]*'provider_failure_domain_cooldown'/,
    )
  })

  it('probes topic taxonomy with the equality-leading compound index without sorting on multikey topicIds', () => {
    const source = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toMatch(
      /'articles_topic_ids_published_at',[\s\S]*\{ status: 'published', topicIds: 'ai-ml' \},[\s\S]*\{ publishedAt: -1, _id: -1 \},[\s\S]*'articles_status_topic_ids_published_at'/,
    )
  })

  it('accepts topic taxonomy as a successor validator for provider, evidence and governance scopes', () => {
    const source = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
    const providerBranchStart = source.indexOf("target === 'provider-routing-v2' && name === 'articles'")
    const providerBranchEnd = source.indexOf("target === 'sources' && name === 'sources'")
    const evidenceBranchStart = source.indexOf("target === 'qa-evidence-fence'\n                  ? name === 'articles'")
    const evidenceBranchEnd = source.indexOf("['indexing-jobs', 'indexing-drain-performance']")
    expect(providerBranchStart).toBeGreaterThanOrEqual(0)
    expect(evidenceBranchStart).toBeGreaterThanOrEqual(0)
    const providerBranch = source.slice(providerBranchStart, providerBranchEnd)
    expect(providerBranch).toMatch(/\? \[PROVIDER_ROUTING_V2_COLLECTIONS\.articles\.validator, QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR, SUMMARY_DETAIL_ARTICLE_VALIDATOR, TOPIC_TAXONOMY_ARTICLE_VALIDATOR\]/)
    expect(evidenceBranchEnd).toBeGreaterThan(evidenceBranchStart)
    const evidenceBranch = source.slice(evidenceBranchStart, evidenceBranchEnd)
    expect(evidenceBranch).toMatch(/name === 'articles' \? \[expectedCollections\[name\]\.validator, SUMMARY_DETAIL_ARTICLE_VALIDATOR, TOPIC_TAXONOMY_ARTICLE_VALIDATOR\]/)
    const governanceArticleCheck = source.split('\n').find((line) => line.includes('governance-tombstone') && line.includes('ARTICLE_GOVERNANCE_HARDENING_VALIDATOR'))
    expect(governanceArticleCheck).toContain('[ARTICLE_GOVERNANCE_HARDENING_VALIDATOR, PROVIDER_ROUTING_V2_COLLECTIONS.articles.validator, QA_EVIDENCE_FENCE_ARTICLE_VALIDATOR, SUMMARY_DETAIL_ARTICLE_VALIDATOR, TOPIC_TAXONOMY_ARTICLE_VALIDATOR]')
    expect(governanceArticleCheck).toContain("validationLevel !== 'strict'")
    expect(governanceArticleCheck).toContain("validationAction !== 'error'")
  })
})
