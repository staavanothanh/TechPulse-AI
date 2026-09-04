import { ObjectId } from 'mongodb'
import { describe, expect, it } from 'vitest'
import { CHAT_SESSION_COLLECTIONS } from '../../../scripts/migrations/chat-sessions.js'
import { CHAT_SESSION_SOURCE_NAME_VALIDATOR } from '../../../scripts/migrations/chat-sessions-source-name-v1.js'
import { historicalCitationDocument } from '../../../server/repositories/mongo/chat-repository.js'

// Repro for prod 503: POST /api/v1/answers -> stage 'appendAnswer' ->
// MongoServerError code 121 (Document failed validation), mapped to 503 by
// mapQaInfrastructureError (server/application/qa/service.js).
// Hypothesis: historicalCitationDocument() persists `sourceName`, but the
// `available` branch of the chatSessions validator declares
// additionalProperties:false WITHOUT a `sourceName` property, so every
// answered write carrying a named source fails validation.

const NOW = new Date('2026-08-12T00:00:00.000Z')

function persistedCitation() {
  return historicalCitationDocument({
    id: 'C1',
    status: 'available',
    articleId: new ObjectId('507f1f77bcf86cd799439204').toHexString(),
    sourceId: new ObjectId('507f1f77bcf86cd799439205').toHexString(),
    sourceName: 'Nguon editorial',
    titleOriginal: 'Bai viet',
    originalUrl: 'https://example.test/articles/one',
    publishedAt: NOW.toISOString(),
  })
}

function availableCitationBranch(validator = CHAT_SESSION_SOURCE_NAME_VALIDATOR) {
  const schema = validator.$and[0].$jsonSchema
  const answered = schema.properties.messages.items.oneOf.find((branch) => branch.properties?.status?.enum?.includes('answered'))
  return answered.properties.citations.items.oneOf.find((branch) => branch.properties?.status?.enum?.includes('available'))
}

describe('QA 121 repro: named-source citation vs chatSessions validator', () => {
  it('reproduces that the base chatSessions validator omits sourceName', () => {
    const baseBranch = availableCitationBranch(CHAT_SESSION_COLLECTIONS.chatSessions.validator)
    expect(baseBranch.additionalProperties).toBe(false)
    expect(Object.keys(baseBranch.properties)).not.toContain('sourceName')
  })

  it('validator accepts the sourceName field the repository persists under successor validator', () => {
    const stored = persistedCitation()
    expect(stored.sourceName).toBe('Nguon editorial')

    const branch = availableCitationBranch(CHAT_SESSION_SOURCE_NAME_VALIDATOR)
    expect(branch.additionalProperties).toBe(false)
    expect(Object.keys(branch.properties)).toContain('sourceName')
    expect(branch.properties.sourceName).toEqual({
      bsonType: 'string',
      minLength: 1,
      maxLength: 120,
    })
    expect(branch.required).not.toContain('sourceName')
  })
})
