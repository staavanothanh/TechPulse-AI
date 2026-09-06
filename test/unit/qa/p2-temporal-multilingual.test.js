import { describe, expect, it } from 'vitest'
import { planQaIntent } from '../../../server/application/qa/intent-planner.js'
import { compileQaExecutionPlan } from '../../../server/application/qa/intent-compiler.js'

const SOURCE_SCOPE = Object.freeze({ topics: ['ai'] })
const SERVER_CLOCK = Object.freeze({
  referenceInstant: '2026-09-04T15:30:00.000Z',
  timeZone: 'Asia/Ho_Chi_Minh',
})
const RECENT_AFTER = '2026-08-05T15:30:00.000Z'

function compileQuestion(question) {
  const input = { question, explicitScope: SOURCE_SCOPE, ...SERVER_CLOCK }
  const proposal = planQaIntent(input)
  const plan = compileQaExecutionPlan({
    proposal,
    explicitScope: input.explicitScope,
    question: input.question,
    referenceInstant: input.referenceInstant,
    timeZone: input.timeZone,
  })
  return { proposal, plan }
}

function effectiveBounds(plan) {
  return {
    publishedAfter: plan.effectiveScope.publishedAfter,
    publishedBefore: plan.effectiveScope.publishedBefore,
  }
}

function expectTemporalContract(plan) {
  expect(plan.temporal).toMatchObject({
    state: 'range',
    field: 'publishedAt',
    publishedAfter: RECENT_AFTER,
    publishedBefore: SERVER_CLOCK.referenceInstant,
    referenceInstant: SERVER_CLOCK.referenceInstant,
    timeZone: SERVER_CLOCK.timeZone,
    provenance: {
      source: 'deterministic',
      plannerVersion: 'qa-planner-v1',
      normalizerVersion: 'qa-normalizer-v1',
    },
  })
}

describe('P2 QA temporal multilingual contract', () => {
  it('keeps Vietnamese accentless and English recent news on one explicit 30-day temporal contract', () => {
    const vietnamese = compileQuestion('Tin AI gan day co gi moi?')
    const english = compileQuestion('Any recently published AI news?')

    expect(vietnamese.proposal.language).toBe('vi')
    expect(english.proposal.language).toBe('en')
    expect(vietnamese.proposal.temporal).toMatchObject({ kind: 'relative', preset: 'recent-30d' })
    expect(english.proposal.temporal).toMatchObject({ kind: 'relative', preset: 'recent-30d' })

    expect(effectiveBounds(vietnamese.plan)).toEqual(effectiveBounds(english.plan))
    expect(effectiveBounds(vietnamese.plan)).toEqual({
      publishedAfter: RECENT_AFTER,
      publishedBefore: SERVER_CLOCK.referenceInstant,
    })
    expect(vietnamese.plan.disclosure).toBe(english.plan.disclosure)
    expect(vietnamese.plan.disclosure).toMatch(/30/u)

    expectTemporalContract(vietnamese.plan)
    expectTemporalContract(english.plan)
  })

  it('clarifies an unsupported temporal phrase instead of broadening the temporal fallback', () => {
    const { proposal, plan } = compileQuestion('Tin AI ngay mai co gi moi?')

    expect(proposal.language).toBe('vi')
    expect(proposal.temporal).toEqual({ kind: 'ambiguous' })
    expect(proposal.clarification).toMatchObject({
      code: 'qa_clarify_unsupported_time',
      field: '/question',
    })
    expect(plan.decision).toBe('clarify')
    expect(plan.effectiveScope).toEqual({})
    expect(plan.effectiveScope.publishedAfter).toBeUndefined()
    expect(plan.effectiveScope.publishedBefore).toBeUndefined()
    expect(plan.temporal).toMatchObject({
      state: 'ambiguous',
      field: 'publishedAt',
      referenceInstant: SERVER_CLOCK.referenceInstant,
      timeZone: SERVER_CLOCK.timeZone,
    })
    expect(plan.provenance.clarification).toMatchObject({
      code: 'qa_clarify_unsupported_time',
      field: '/question',
    })
  })
})
