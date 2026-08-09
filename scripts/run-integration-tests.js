import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/integration'], { stdio: 'inherit', env: process.env })
process.exitCode = result.status ?? 1
