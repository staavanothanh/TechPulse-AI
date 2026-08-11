import { spawnSync } from 'node:child_process'

const filters = process.argv.slice(2)
const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...(filters.length > 0 ? filters : ['test/integration'])], { stdio: 'inherit', env: process.env })
process.exitCode = result.status ?? 1
