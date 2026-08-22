import { execFileSync } from 'node:child_process'
import { chmodSync } from 'node:fs'

chmodSync(new URL('../.githooks/pre-push', import.meta.url), 0o755)

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' })
console.log('Git hooks path configured: .githooks')
