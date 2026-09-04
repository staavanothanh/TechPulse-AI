import { describe, expect, it } from 'vitest'
import {
  QA_TEMPORAL_RESOLVER_VERSION,
  resolveQaTemporalScope,
} from '../../../shared/qa-temporal.js'

const NOW = new Date('2026-09-04T15:30:00.000Z')
const SOURCE_SCOPE = { topics: ['ai'] }

const expected = (publishedAfter, publishedBefore) => ({
  topics: ['ai'],
  publishedAfter,
  publishedBefore,
})

describe('Q&A temporal resolver', () => {
  it('exports one versioned resolver contract and resolves the observed Vietnamese month phrase', () => {
    expect(QA_TEMPORAL_RESOLVER_VERSION).toBe('qa-temporal-v1')
    expect(resolveQaTemporalScope({
      question: 'tháng 9 này có tin tức gì về các model AI mới không',
      scope: SOURCE_SCOPE,
      now: NOW,
    })).toEqual(expected('2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'))
  })

  it.each([
    ['tháng này', '2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'],
    ['tháng trước', '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'],
    ['hôm nay', '2026-09-04T00:00:00.000Z', '2026-09-04T23:59:59.999Z'],
    ['hôm qua', '2026-09-03T00:00:00.000Z', '2026-09-03T23:59:59.999Z'],
    ['tuần này', '2026-08-31T00:00:00.000Z', '2026-09-06T23:59:59.999Z'],
    ['tuần qua', '2026-08-24T00:00:00.000Z', '2026-08-30T23:59:59.999Z'],
    ['this month', '2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'],
    ['last month', '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'],
    ['today', '2026-09-04T00:00:00.000Z', '2026-09-04T23:59:59.999Z'],
    ['yesterday', '2026-09-03T00:00:00.000Z', '2026-09-03T23:59:59.999Z'],
    ['this week', '2026-08-31T00:00:00.000Z', '2026-09-06T23:59:59.999Z'],
    ['last week', '2026-08-24T00:00:00.000Z', '2026-08-30T23:59:59.999Z'],
  ])('resolves the explicit %s calendar pattern in UTC', (phrase, publishedAfter, publishedBefore) => {
    expect(resolveQaTemporalScope({ question: `Tin ${phrase} có gì mới?`, scope: SOURCE_SCOPE, now: NOW })).toEqual(expected(publishedAfter, publishedBefore))
  })

  it('uses the UTC calendar date even when the injected clock has a local offset', () => {
    const offsetClock = new Date('2026-09-01T00:30:00+14:00')
    expect(resolveQaTemporalScope({ question: 'tháng này có gì mới?', scope: SOURCE_SCOPE, now: offsetClock })).toEqual(expected('2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z'))
  })

  it('preserves explicit caller bounds, including one-sided invalid input, without filling the other bound', () => {
    const scope = { topics: ['ai'], publishedAfter: 'not-a-date' }
    expect(resolveQaTemporalScope({ question: 'tháng 9 này có gì mới?', scope, now: NOW })).toEqual(scope)
    expect(resolveQaTemporalScope({ question: 'tháng 9 này có gì mới?', scope: { topics: ['ai'], publishedBefore: '2026-09-30T23:59:59.999Z' }, now: NOW })).toEqual({ topics: ['ai'], publishedBefore: '2026-09-30T23:59:59.999Z' })
  })

  it('leaves unsupported or ambiguous phrases and natural-language-only scopes unchanged', () => {
    expect(resolveQaTemporalScope({ question: 'tháng 13 này có gì mới?', scope: SOURCE_SCOPE, now: NOW })).toEqual(SOURCE_SCOPE)
    expect(resolveQaTemporalScope({ question: 'Tin tháng 9 đó có gì mới?', scope: SOURCE_SCOPE, now: NOW })).toEqual(SOURCE_SCOPE)
    expect(resolveQaTemporalScope({ question: 'hôm nay và hôm qua có gì mới?', scope: SOURCE_SCOPE, now: NOW })).toEqual(SOURCE_SCOPE)
    expect(resolveQaTemporalScope({ question: 'tháng 9 này có gì mới?', scope: {}, now: NOW })).toEqual({})
  })
})
