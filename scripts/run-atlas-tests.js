import { spawnSync } from 'node:child_process'
import { atlasTestArguments, createAtlasTestEnvironment, redactAtlasOutput } from './atlas-test-safety.js'
import { configureDns } from './configure-dns.js'

const mode = process.argv[2] ?? 'integration'
const dnsPreload = new URL('./configure-dns.js', import.meta.url).href

try {
  configureDns()
  if (process.argv.length > 3) throw new Error('Atlas test command accepts one mode only')
  const { childEnvironment, testDatabaseBase } = createAtlasTestEnvironment()
  const uri = childEnvironment.MONGODB_TEST_URI
  console.log(JSON.stringify({ atlasTestMode: mode, testDatabaseBase }))
  const result = spawnSync(process.execPath, ['--import', dnsPreload, ...atlasTestArguments(mode)], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: childEnvironment,
    maxBuffer: 20 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.stdout) process.stdout.write(redactAtlasOutput(result.stdout, uri))
  if (result.stderr) process.stderr.write(redactAtlasOutput(result.stderr, uri))
  if (result.error) throw new Error('Atlas test child process could not start')
  process.exitCode = result.status ?? 1
} catch {
  console.error('Atlas test preflight failed')
  process.exitCode = 1
}
