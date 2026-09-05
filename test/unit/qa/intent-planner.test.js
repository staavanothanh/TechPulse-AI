import { describe, expect, it } from 'vitest'
import { assertQaIntentProposal, planQaIntent } from '../../../server/application/qa/intent-planner.js'
import { compileQaExecutionPlan } from '../../../server/application/qa/intent-compiler.js'

const SOURCE_SCOPE = { topics: ['ai'] }
const REFERENCE_INSTANT = '2026-09-04T15:30:00.000Z'
const SERVER_TIMEZONE = 'Asia/Ho_Chi_Minh'

const plannerInput = ({ question, explicitScope = SOURCE_SCOPE, referenceInstant = REFERENCE_INSTANT, timeZone = SERVER_TIMEZONE }) => ({
  question,
  explicitScope,
  referenceInstant,
  timeZone,
})

const planQuestion = (options) => {
  const input = plannerInput(options)
  const proposal = planQaIntent(input)
  const plan = compileQaExecutionPlan({
    proposal,
    explicitScope: input.explicitScope,
    referenceInstant: input.referenceInstant,
    timeZone: input.timeZone,
  })
  return { proposal, plan }
}

const iso = (value) => value instanceof Date ? value.toISOString() : value
const clarificationCode = (value) => value?.reasonCode ?? value?.code

const validProposal = (overrides = {}) => ({
  proposalVersion: 'qa-intent-proposal-v1',
  language: 'vi',
  normalizedQuery: 'tin hôm nay',
  intent: 'recent-news',
  entities: [],
  temporal: { kind: 'relative', preset: 'today' },
  scopeHints: {},
  queryVariants: ['tin hôm nay'],
  clarification: null,
  confidence: 0.8,
  provenance: { plannerVersion: 'qa-planner-v1' },
  ...overrides,
})

describe('QA intent planner — deterministic temporal authority', () => {
  it('extracts Vietnamese and English day, week, and month phrases against one frozen server clock', () => {
    const cases = [
      ['Tin hôm nay có gì mới?', '2026-09-03T17:00:00.000Z', '2026-09-04T16:59:59.999Z'],
      ['Any news today?', '2026-09-03T17:00:00.000Z', '2026-09-04T16:59:59.999Z'],
      ['Tin tuần này có gì mới?', '2026-08-30T17:00:00.000Z', '2026-09-06T16:59:59.999Z'],
      ['What happened this week?', '2026-08-30T17:00:00.000Z', '2026-09-06T16:59:59.999Z'],
      ['Tin tháng này có gì mới?', '2026-08-31T17:00:00.000Z', '2026-09-30T16:59:59.999Z'],
      ['What happened this month?', '2026-08-31T17:00:00.000Z', '2026-09-30T16:59:59.999Z'],
    ]

    for (const [question, publishedAfter, publishedBefore] of cases) {
      const first = planQuestion({ question })
      const second = planQuestion({ question })

      expect({
        publishedAfter: iso(first.plan.effectiveScope.publishedAfter),
        publishedBefore: iso(first.plan.effectiveScope.publishedBefore),
      }).toEqual({ publishedAfter, publishedBefore })
      expect(first.plan).toEqual(second.plan)
    }
  })

  it('maps gần đây and recently to a rolling 30-day range and discloses the window', () => {
    const vietnamese = planQuestion({ question: 'Tin AI gần đây có gì mới?' })
    const english = planQuestion({ question: 'Any recently published AI news?' })

    expect(vietnamese.proposal.temporal).toMatchObject({ kind: 'relative', preset: 'recent-30d' })
    expect(english.proposal.temporal).toMatchObject({ kind: 'relative', preset: 'recent-30d' })
    expect(iso(vietnamese.plan.effectiveScope.publishedAfter)).toBe('2026-08-05T15:30:00.000Z')
    expect(iso(vietnamese.plan.effectiveScope.publishedBefore)).toBe(REFERENCE_INSTANT)
    expect(iso(english.plan.effectiveScope.publishedAfter)).toBe('2026-08-05T15:30:00.000Z')
    expect(String(vietnamese.plan.disclosure)).toMatch(/30|ba mươi/i)
    expect(String(english.plan.disclosure)).toMatch(/30|thirty/i)
  })

  it('uses relevance plus freshness ordering for latest, or returns an explicit safe clarification', () => {
    const { proposal, plan } = planQuestion({ question: 'Cho tôi tin mới nhất về AI.' })

    expect(['execute', 'clarify']).toContain(plan.decision)
    if (plan.decision === 'execute') {
      expect(plan.ordering).toEqual(['relevance', 'freshness'])
      expect(plan.effectiveScope.publishedAfter).toBeUndefined()
      expect(plan.effectiveScope.publishedBefore).toBeUndefined()
    } else {
      expect(clarificationCode(proposal.clarification ?? plan.clarification)).toMatch(/^qa_clarify_/)
    }
  })

  it('preserves explicit date, article, and topic scope over inferred temporal hints', () => {
    const explicitScope = {
      articleId: 'article-1',
      topics: ['ai'],
      publishedAfter: '2026-08-01T00:00:00.000Z',
      publishedBefore: '2026-08-02T00:00:00.000Z',
    }
    const { plan } = planQuestion({
      question: 'Tin hôm nay về bài này có gì mới?',
      explicitScope,
    })

    expect(plan.effectiveScope).toMatchObject(explicitScope)
    expect(iso(plan.effectiveScope.publishedAfter)).toBe(explicitScope.publishedAfter)
    expect(iso(plan.effectiveScope.publishedBefore)).toBe(explicitScope.publishedBefore)
  })

  it('clarifies a bare month without a year instead of guessing the year', () => {
    const proposal = planQaIntent(plannerInput({ question: 'Tin tháng 9 có gì mới?' }))

    expect(proposal.temporal).toMatchObject({ kind: 'ambiguous' })
    expect(clarificationCode(proposal.clarification)).toMatch(/^qa_clarify_/)
    expect(proposal.clarification).toMatchObject({ field: '/question' })
  })

  it('clarifies conflicting or multiple temporal phrases', () => {
    const proposal = planQaIntent(plannerInput({ question: 'Hôm nay và hôm qua có gì mới?' }))

    expect(clarificationCode(proposal.clarification)).toMatch(/^qa_clarify_/)
  })

  it('uses the server IANA timezone for local day boundaries', () => {
    const { plan } = planQuestion({
      question: 'Tin hôm nay có gì mới?',
      referenceInstant: '2026-09-04T17:00:00.000Z',
      timeZone: 'Asia/Ho_Chi_Minh',
    })

    expect(iso(plan.effectiveScope.publishedAfter)).toBe('2026-09-04T17:00:00.000Z')
    expect(iso(plan.effectiveScope.publishedBefore)).toBe('2026-09-05T16:59:59.999Z')
  })

  it('honors a DST transition when resolving a local day', () => {
    const { plan } = planQuestion({
      question: 'What happened today?',
      referenceInstant: '2026-03-08T12:00:00.000Z',
      timeZone: 'America/New_York',
    })

    expect(iso(plan.effectiveScope.publishedAfter)).toBe('2026-03-08T05:00:00.000Z')
    expect(iso(plan.effectiveScope.publishedBefore)).toBe('2026-03-09T03:59:59.999Z')
  })

  it('returns a frozen closed plan with publication field and inclusive compatibility bounds', () => {
    const from = '2026-09-01T00:00:00.000Z'
    const to = '2026-09-30T23:59:59.999Z'
    const plan = compileQaExecutionPlan({
      proposal: validProposal({
        temporal: { kind: 'absolute', field: 'publishedAt', from, to, fromInclusive: true, toInclusive: true },
      }),
      explicitScope: SOURCE_SCOPE,
      referenceInstant: REFERENCE_INSTANT,
      timeZone: SERVER_TIMEZONE,
    })

    expect(plan).toMatchObject({
      planVersion: 'qa-execution-plan-v1',
      decision: 'execute',
      retrievalQuery: expect.anything(),
      temporal: expect.objectContaining({ field: 'publishedAt' }),
      ordering: expect.any(Array),
      budget: expect.any(Object),
      disclosure: expect.anything(),
    })
    expect(plan.plannerVersion).toBeDefined()
    expect(plan.normalizerVersion).toBeDefined()
    expect(plan.effectiveScope).toMatchObject({
      topics: ['ai'],
      publishedAfter: from,
      publishedBefore: to,
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.effectiveScope)).toBe(true)
    expect(plan.proposal).toBeUndefined()
    expect(plan.repositoryFilter).toBeUndefined()
    expect(JSON.stringify(plan)).not.toMatch(/\$gte|\$lte|\$gt|\$lt/)
  })
})

describe('QA intent proposal — closed untrusted boundary', () => {
  it('rejects malformed proposals and unknown top-level fields', () => {
    expect(() => assertQaIntentProposal({ ...validProposal(), temporal: { kind: 'not-supported' } })).toThrow()
    expect(() => assertQaIntentProposal({ ...validProposal(), unexpected: 'smuggled' })).toThrow()
  })

  it('never expands explicit scope from untrusted scope hints', () => {
    try {
      const plan = compileQaExecutionPlan({
        proposal: validProposal({ scopeHints: { articleId: 'article-evil', topics: ['all'], filter: { author: 'mallory' } } }),
        explicitScope: SOURCE_SCOPE,
        referenceInstant: REFERENCE_INSTANT,
        timeZone: SERVER_TIMEZONE,
      })

      expect(plan.effectiveScope).toMatchObject(SOURCE_SCOPE)
      expect(plan.effectiveScope.articleId).toBeUndefined()
      expect(JSON.stringify(plan)).not.toContain('mallory')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })

  it('ignores caller policy and clock values in favor of server authority', () => {
    try {
      const plan = compileQaExecutionPlan({
        proposal: validProposal({
          temporal: { kind: 'relative', preset: 'today' },
          policyVersion: 999,
          referenceInstant: '1999-01-01T00:00:00.000Z',
        }),
        explicitScope: SOURCE_SCOPE,
        referenceInstant: REFERENCE_INSTANT,
        timeZone: SERVER_TIMEZONE,
      })

      expect(JSON.stringify(plan)).not.toContain('1999-01-01')
      expect(JSON.stringify(plan)).not.toContain('"policyVersion":999')
      expect(iso(plan.effectiveScope.publishedAfter)).toBe('2026-09-03T17:00:00.000Z')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
  })

  it('rejects secrets and chain-of-thought rather than forwarding them', () => {
    expect(() => assertQaIntentProposal({
      ...validProposal(),
      chainOfThought: 'private reasoning',
      apiKey: 'sk-live-secret',
    })).toThrow()
  })

  it('rejects unsafe entity model-version rewrites', () => {
    expect(() => assertQaIntentProposal({
      ...validProposal({ normalizedQuery: 'tin GPT-4' }),
      entities: [{ kind: 'model', mention: 'GPT-4', modelVersion: 'v9-evil' }],
    })).toThrow()
  })

  it('rejects more than three bounded query variants', () => {
    expect(() => assertQaIntentProposal({
      ...validProposal({ queryVariants: ['a', 'b', 'c', 'd'] }),
    })).toThrow()
  })

  it('rejects an empty scope object at the planner boundary', () => {
    expect(() => planQaIntent(plannerInput({ question: 'Tin AI hôm nay?', explicitScope: {} }))).toThrow()
  })
})
