import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const runner = 'scripts/run-local-e2e.js'
const baseEnvironment = {
  ...process.env,
  E2E_ENABLED: 'true',
  E2E_USER_EMAIL: 'user-e2e@example.test',
  E2E_USER_PASSWORD: 'user-password-not-a-secret',
  E2E_ADMIN_EMAIL: 'admin-e2e@example.test',
  E2E_ADMIN_PASSWORD: 'admin-password-not-a-secret',
  E2E_DEMO_SOURCE_ID: '111111111111111111111111',
  E2E_DEMO_ARTICLE_ID: '222222222222222222222222',
  E2E_SEARCH_QUERY: 'AI',
  E2E_GOVERNANCE_MUTATIONS: 'false',
}

function run(overrides = {}) {
  const result = spawnSync(process.execPath, [runner], {
    cwd: process.cwd(),
    env: { ...baseEnvironment, ...overrides },
    encoding: 'utf8',
    windowsHide: true,
  })
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` }
}

describe('local E2E runner safety gate', () => {
  it('requires deterministic demo IDs and a non-empty search query', () => {
    const missingIds = run({ E2E_DEMO_SOURCE_ID: '' })
    expect(missingIds.status).toBe(2)
    expect(missingIds.output).toMatch(/E2E_DEMO_SOURCE_ID/)

    const invalidArticle = run({ E2E_DEMO_ARTICLE_ID: 'not-an-object-id' })
    expect(invalidArticle.status).toBe(2)
    expect(invalidArticle.output).toMatch(/E2E_DEMO_ARTICLE_ID/)

    const emptyQuery = run({ E2E_SEARCH_QUERY: '  ' })
    expect(emptyQuery.status).toBe(2)
    expect(emptyQuery.output).toMatch(/E2E_SEARCH_QUERY/)
  })

  it('refuses an unsafe deletion account and mismatched confirmation', () => {
    const duplicate = run({
      E2E_GOVERNANCE_MUTATIONS: 'true',
      E2E_DELETION_EMAIL: 'user-e2e@example.test',
      E2E_DELETION_PASSWORD: 'disposable-password',
      E2E_DELETION_CONFIRM_EMAIL: 'user-e2e@example.test',
      E2E_TAKEDOWN_ARTICLE_ID: '222222222222222222222222',
    })
    expect(duplicate.status).toBe(2)
    expect(duplicate.output).toMatch(/distinct from E2E_USER_EMAIL/)

    const mismatch = run({
      E2E_GOVERNANCE_MUTATIONS: 'true',
      E2E_DELETION_EMAIL: 'deletion-e2e@example.test',
      E2E_DELETION_PASSWORD: 'disposable-password',
      E2E_DELETION_CONFIRM_EMAIL: 'different-e2e@example.test',
      E2E_TAKEDOWN_ARTICLE_ID: '222222222222222222222222',
    })
    expect(mismatch.status).toBe(2)
    expect(mismatch.output).toMatch(/must exactly match/)

    const nonDeterministicTakedown = run({
      E2E_GOVERNANCE_MUTATIONS: 'true',
      E2E_DELETION_EMAIL: 'deletion-e2e@example.test',
      E2E_DELETION_PASSWORD: 'disposable-password',
      E2E_DELETION_CONFIRM_EMAIL: 'deletion-e2e@example.test',
      E2E_TAKEDOWN_ARTICLE_ID: '333333333333333333333333',
    })
    expect(nonDeterministicTakedown.status).toBe(2)
    expect(nonDeterministicTakedown.output).toMatch(/must equal E2E_DEMO_ARTICLE_ID/)
  })
})
