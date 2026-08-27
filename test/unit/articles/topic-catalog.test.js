import { describe, expect, it } from 'vitest'
import {
  TOPIC_TAXONOMY_VERSION,
  TOPIC_CATALOG,
  TOPIC_BY_ID,
  TOPIC_PARENT_DOMAINS,
  TopicTaxonomyError,
  normalizeTopicValue,
  resolveTopic,
  canonicalTopicIds,
  canonicalPreferenceIds,
  expandTopicSelection,
  topicLabel,
  topicOptions,
  classifyTopicIds,
  topicsMatch,
} from '../../../shared/topic-catalog.js'

describe('shared topic catalog and taxonomy resolver', () => {
  it('defines an immutable catalog with exactly eight active parent domains and unique ASCII IDs', () => {
    expect(TOPIC_TAXONOMY_VERSION).toBeGreaterThanOrEqual(1)
    expect(Object.isFrozen(TOPIC_CATALOG)).toBe(true)
    expect(Object.isFrozen(TOPIC_BY_ID)).toBe(true)
    expect(Object.isFrozen(TOPIC_PARENT_DOMAINS)).toBe(true)

    expect(TOPIC_PARENT_DOMAINS).toHaveLength(8)
    for (const parent of TOPIC_PARENT_DOMAINS) {
      expect(parent.kind).toBe('parent')
      expect(parent.parentId).toBeNull()
      expect(parent.status).toBe('active')
      expect(parent.id).toMatch(/^[a-z0-9-]+$/)
      expect(parent.labels.vi).toBeTruthy()
      expect(parent.labels.en).toBeTruthy()
      expect(Object.isFrozen(parent)).toBe(true)
      expect(Object.isFrozen(parent.labels)).toBe(true)
      expect(Object.isFrozen(parent.aliases)).toBe(true)
      expect(Object.isFrozen(parent.legacyValues)).toBe(true)
    }

    const expectedParentIds = [
      'ai-ml',
      'ai-agent',
      'robotics',
      'software-engineering',
      'devops-cloud',
      'security',
      'computer-science',
      'emerging-it',
    ]
    const actualParentIds = TOPIC_PARENT_DOMAINS.map((item) => item.id)
    expect(actualParentIds.sort()).toEqual(expectedParentIds.sort())

    // All IDs must be unique
    const allIds = TOPIC_CATALOG.map((item) => item.id)
    expect(new Set(allIds).size).toBe(allIds.length)

    // Leaves must link to valid parents
    for (const item of TOPIC_CATALOG) {
      if (item.kind === 'leaf') {
        expect(item.parentId).toBeTruthy()
        expect(TOPIC_BY_ID[item.parentId]).toBeTruthy()
        expect(TOPIC_BY_ID[item.parentId].kind).toBe('parent')
      }
    }
  })

  it('normalizes topic values safely without mutating or leaking sensitive payloads', () => {
    expect(normalizeTopicValue('  AI  ')).toBe('ai')
    expect(normalizeTopicValue('Trí\u00A0tuệ   nhân\ttạo')).toBe('trí tuệ nhân tạo')
    expect(normalizeTopicValue(null)).toBe('')
    expect(normalizeTopicValue(undefined)).toBe('')
    expect(normalizeTopicValue(123)).toBe('')
  })

  it('resolves IDs, aliases, legacy values, and preserves unknown strings as unmapped', () => {
    // Exact ID
    expect(resolveTopic('ai-ml')).toMatchObject({
      input: 'ai-ml',
      canonicalId: 'ai-ml',
      match: 'id',
    })

    // arXiv aliases
    expect(resolveTopic('cs.AI')).toMatchObject({
      canonicalId: 'ai-ml',
      match: 'alias',
    })
    expect(resolveTopic('cs.LG')).toMatchObject({
      canonicalId: 'ai-ml',
      match: 'alias',
    })

    // Legacy variations
    expect(resolveTopic('Dev Ops')).toMatchObject({
      canonicalId: 'devops-cloud',
      match: 'alias',
    })
    expect(resolveTopic('dev-ops')).toMatchObject({
      canonicalId: 'devops-cloud',
      match: 'alias',
    })
    expect(resolveTopic('security')).toMatchObject({
      canonicalId: 'security',
      match: 'id',
    })
    expect(resolveTopic('bảo mật')).toMatchObject({
      canonicalId: 'security',
      match: 'alias',
    })
    expect(resolveTopic('data')).toMatchObject({
      canonicalId: 'computer-science',
      match: 'alias',
    })
    expect(resolveTopic('database')).toMatchObject({
      canonicalId: 'computer-science',
      match: 'alias',
    })
    expect(resolveTopic('dữ liệu')).toMatchObject({
      canonicalId: 'computer-science',
      match: 'alias',
    })
    expect(resolveTopic('Robot')).toMatchObject({
      canonicalId: 'robotics',
      match: 'alias',
    })
    expect(resolveTopic('Blockchain')).toMatchObject({
      canonicalId: 'emerging-it',
      match: 'alias',
    })

    // Unknown legacy string -> does NOT throw, returns canonicalId: null
    expect(resolveTopic('Safety')).toMatchObject({
      input: 'Safety',
      normalized: 'safety',
      canonicalId: null,
      match: 'unknown',
    })
  })
  it('matches canonical IDs, aliases, and unknown values without conflating topics', () => {
    expect(topicsMatch('robot', 'Robotics')).toBe(true)
    expect(topicsMatch('security', 'Bảo mật')).toBe(true)
    expect(topicsMatch('custom', ' CUSTOM ')).toBe(true)
    expect(topicsMatch('robot', 'AI')).toBe(false)
    expect(topicsMatch('', 'AI')).toBe(false)
  })

  it('derives canonical topic IDs with ancestor closure in deterministic order', () => {
    const ids = canonicalTopicIds(['cs.AI', 'Dev Ops', 'Safety', 'databases'], { includeAncestors: true })
    expect(ids).toContain('ai-ml')
    expect(ids).toContain('devops-cloud')
    expect(ids).toContain('databases')
    expect(ids).toContain('computer-science') // ancestor of databases
    expect(ids).not.toContain('safety')
    expect(Object.isFrozen(ids)).toBe(true)

    // Exceeding max limit throws TopicTaxonomyError
    expect(() =>
      canonicalTopicIds(Array.from({ length: 51 }, (_, i) => `topic-${i}`), { max: 50 }),
    ).toThrow(TopicTaxonomyError)
  })

  it('resolves user preference IDs within bounded limits', () => {
    const prefs = canonicalPreferenceIds(['AI', 'Robot', 'Safety'])
    expect(prefs).toContain('ai-ml')
    expect(prefs).toContain('robotics')
    expect(prefs).not.toContain('safety')
    expect(Object.isFrozen(prefs)).toBe(true)

    expect(() =>
      canonicalPreferenceIds(Array.from({ length: 21 }, (_, i) => `topic-${i}`), { max: 20 }),
    ).toThrow(TopicTaxonomyError)
  })

  it('expands topic selections with parent self+descendants and leaf exact semantics', () => {
    // Parent expansion: includes self + child leaves + mapped legacy values
    const parentExpansion = expandTopicSelection(['ai-ml'])
    expect(parentExpansion.parents).toContain('ai-ml')
    expect(parentExpansion.canonicalIds).toContain('ai-ml')
    expect(parentExpansion.canonicalIds.length).toBeGreaterThan(1)
    expect(parentExpansion.legacyValues).toContain('ai')
    expect(parentExpansion.expansionCount).toBe(parentExpansion.canonicalIds.length)

    // Leaf expansion: exact (leaf only)
    const leafExpansion = expandTopicSelection(['databases'])
    expect(leafExpansion.leaves).toContain('databases')
    expect(leafExpansion.canonicalIds).toEqual(['databases'])
    expect(leafExpansion.expansionCount).toBe(1)

    // Unknown value: preserves legacy value, no canonical ID
    const unknownExpansion = expandTopicSelection(['Safety'])
    expect(unknownExpansion.canonicalIds).toEqual([])
    expect(unknownExpansion.legacyValues).toContain('safety')
    expect(unknownExpansion.expansionCount).toBe(0)

    // Multiple values: OR semantics
    const multiExpansion = expandTopicSelection(['robotics', 'Safety'])
    expect(multiExpansion.canonicalIds).toContain('robotics')
    expect(multiExpansion.legacyValues).toContain('safety')
    expect(multiExpansion.legacyValues).toContain('robot')

    // Bounded expansion fails closed if maxExpanded is exceeded
    expect(() => expandTopicSelection(['ai-ml', 'devops-cloud'], { maxExpanded: 2 })).toThrow(
      TopicTaxonomyError,
    )
  })

  it('formats topic labels with locale support and unknown string fallback', () => {
    expect(topicLabel('ai-ml')).toBe('AI')
    expect(topicLabel('ai-ml', 'en')).toBe('AI')
    expect(topicLabel('security')).toBe('Bảo mật')
    expect(topicLabel('security', 'en')).toBe('Security')
    expect(topicLabel('devops')).toBe('DevOps')
    expect(topicLabel('Safety')).toBe('Safety')
    expect(topicLabel('  custom unknown  ')).toBe('custom unknown')
    expect(topicLabel(null)).toBe('')
  })

  it('provides catalog-derived UI options for the 8 active parent domains', () => {
    const options = topicOptions()
    expect(options).toHaveLength(8)
    expect(Object.isFrozen(options)).toBe(true)
    expect(options).toContain('AI')
    expect(options).toContain('AI Agent')
    expect(options).toContain('Robotics')
    expect(options).toContain('Software Engineering')
    expect(options).toContain('DevOps')
    expect(options).toContain('Bảo mật')
    expect(options).toContain('Dữ liệu')
    expect(options).toContain('Blockchain')
  })

  it('classifies text into canonical topic IDs from title and excerpt keywords', () => {
    const ids = classifyTopicIds({
      titleOriginal: 'Cloud data infrastructure with Kubernetes',
      excerptOriginal: 'A database pipeline stores analytics for modern teams.',
    })
    expect(ids).toContain('devops-cloud')
    expect(ids).toContain('computer-science')
  })
})
