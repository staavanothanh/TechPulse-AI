import { describe, expect, it } from 'vitest'
import { deriveLeaseKey } from '../../../server/domain/jobs/lease-keys.js'

describe('canonical job lease keys', () => {
  it.each([
    ['ingestion', 'source_123', 'ingestion:source:source_123'],
    ['indexing', 'article-123', 'indexing:article:article-123'],
    ['reconciliation', 'source_123', 'reconciliation:source:source_123'],
    ['account-deletion', 'user_123', 'account-deletion:user:user_123'],
  ])('derives %s keys from bounded opaque ids', (resource, id, expected) => {
    expect(deriveLeaseKey(resource, id)).toBe(expected)
  })

  it.each([
    ['unknown', 'source_123'],
    ['ingestion', 'UPPERCASE'],
    ['ingestion', 'user@example.com'],
    ['ingestion', 'job:random'],
    ['ingestion', ''],
    ['ingestion', 'a'.repeat(129)],
  ])('rejects non-canonical resource/id before persistence', (resource, id) => {
    expect(() => deriveLeaseKey(resource, id)).toThrow(/canonical lease/i)
  })
})
