import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('Step 10 chat database verification', () => {
  it('explains the exact answer-attempt identity lookup with its unique-index hint', () => {
    const source = fs.readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toContain("'answer_attempts_identity'")
    expect(source).toMatch(/userId:\s*new ObjectId\('000000000000000000000001'\)[\s\S]*sessionId:\s*new ObjectId\('000000000000000000000002'\)[\s\S]*expectedSessionVersion:\s*1[\s\S]*idempotencyKeyHash:\s*'a'\.repeat\(64\)[\s\S]*'answer_attempts_identity_unique'/)
  })

  it('requires the chat runtime and maintenance capability probe for --require-role', () => {
    const source = fs.readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toContain('probeChatSessionsRoleCapabilities')
    expect(source).toMatch(/chat-sessions runtime capability failed/)
    expect(source).toMatch(/answerAttemptsMaintenanceDelete/)
    expect(source).toMatch(/answerAttempts maintenance capability failed/)
    expect(source).not.toMatch(/target === 'chat-sessions'\)\s*\{\s*roleStatus = 'not-requested'/)
  })

  it('probes transaction-scoped chat writes and the bounded answer-attempt cleanup action', () => {
    const source = fs.readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toMatch(/startSession\(\)/)
    expect(source).toMatch(/startTransaction\(\)/)
    expect(source).toMatch(/collection\('chatSessions'\)[\s\S]*insertOne/)
    expect(source).toMatch(/collection\('chatSessions'\)[\s\S]*updateOne/)
    expect(source).toMatch(/collection\('answerAttempts'\)[\s\S]*insertOne/)
    expect(source).toMatch(/collection\('answerAttempts'\)[\s\S]*updateOne/)
    expect(source).toMatch(/collection\('answerAttempts'\)[\s\S]*deleteMany/)
    expect(source).toMatch(/abortTransaction\(\)/)
  })

  it('includes governance direct citation explain probes for article and source takedown cleanup', () => {
    const source = fs.readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(source).toContain("'governance_chat_citation_article'")
    expect(source).toContain("'governance_chat_citation_source'")
    expect(source).toMatch(/governance_chat_citation_article[\s\S]*messages\.citations\.articleId[\s\S]*chat_sessions_citation_article/)
    expect(source).toMatch(/governance_chat_citation_source[\s\S]*messages\.citations\.sourceId[\s\S]*chat_sessions_citation_source/)
    expect(source).toMatch(/takedown_cleanup_due[\s\S]*completion\.historicalChatCitationsRedacted[\s\S]*updatedAt:[\s\S]*takedown_cleanup_due/)
    expect(source).toMatch(/governance_source_article_hide[\s\S]*articles_status_source_time/)
    expect(source).toMatch(/governance.*chat citation.*explain|direct citation explain/i)
  })

  it('fails closed with a safe not-verified result when Mongo is unreachable', () => {
    const result = spawnSync(process.execPath, ['scripts/db-verify.js', 'chat-sessions', '--require-role'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        MONGODB_URI_ENV: 'STEP10_UNREACHABLE_URI',
        MONGODB_DATABASE: 'techpulse_step10_verify',
      },
    })
    expect(result.status).toBe(1)
    expect(result.stderr.trim()).toBe('Verification failed: connection_error')
    expect(result.stderr).not.toMatch(/mongodb(?:\+srv)?:\/\//i)
  })
})
