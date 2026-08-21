import { spawnSync } from 'node:child_process'
import { configureDns } from './configure-dns.js'

const filters = process.argv.slice(2)
const dnsPreload = new URL('./configure-dns.js', import.meta.url).href
configureDns()
const result = spawnSync(process.execPath, ['--import', dnsPreload, 'node_modules/vitest/vitest.mjs', 'run', ...(filters.length > 0 ? filters : ['test/integration'])], { stdio: 'inherit', env: process.env })
process.exitCode = result.status ?? 1
