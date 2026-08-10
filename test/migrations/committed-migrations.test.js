import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DEPLOYED_MIGRATIONS = Object.freeze({
  'scripts/migrations/auth-core.js': '6556ff34cdd954bea9831ba60ae40c81af8da67b',
  'scripts/migrations/sources.js': '9df57e9bdaa36048e5beb17d2806dc4773159967',
  'scripts/migrations/step3-compatibility.js': '91026ac2b5d049abba71b4bcb89193b57bcf9900',
})

function gitBlobHash(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

describe('committed migration immutability', () => {
  for (const [path, expectedHash] of Object.entries(DEPLOYED_MIGRATIONS)) {
    it(`keeps ${path} byte-identical`, () => {
      expect(gitBlobHash(readFileSync(path))).toBe(expectedHash)
    })
  }
})
