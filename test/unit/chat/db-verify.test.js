import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Step 10 chat database verification', () => {
  it('explains the exact answer-attempt identity lookup with its unique-index hint', () => {
    const source = fs.readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toContain("'answer_attempts_identity'")
    expect(source).toMatch(/userId:\s*new ObjectId\('000000000000000000000001'\)[\s\S]*sessionId:\s*new ObjectId\('000000000000000000000002'\)[\s\S]*expectedSessionVersion:\s*1[\s\S]*idempotencyKeyHash:\s*'a'\.repeat\(64\)[\s\S]*'answer_attempts_identity_unique'/)
  })
})
