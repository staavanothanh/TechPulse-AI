import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Step 2 documentation and shell copy', () => {
  it('does not present the auth-enabled shell as the Step 1-only placeholder or document unavailable orchestration commands', () => {
    const app = fs.readFileSync('client/App.jsx', 'utf8')
    const guide = fs.readFileSync('docs/ORCHESTRATION-GUIDE.md', 'utf8')
    const plan = fs.readFileSync('docs/plans/techpulse-ai-mvp.md', 'utf8')

    expect(app).not.toContain('STEP 01 · CONTRACT-FIRST FOUNDATION')
    expect(app).not.toContain('Chưa có business UI hoặc dữ liệu nguồn ở Step 1.')
    expect(guide).not.toContain('/ecc:orchestrate custom')
    expect(plan).not.toContain('/ecc:orchestrate')
    expect(guide).not.toContain('`\text')
    expect(guide).toContain('```text')
  })
})
