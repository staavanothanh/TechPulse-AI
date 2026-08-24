import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { generateAttestationRegistry } from './pre-push-attestation.js'

const execFileAsync = promisify(execFile)
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i

export const COMMIT_ENV_KEY = 'SCHEMA_ATTESTATION_COMMIT'
export const ATTESTATION_ENV_KEY = 'RUNTIME_SCHEMA_ATTESTATIONS_JSON'

function assertCommit(commit) {
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit.trim())) {
    throw new Error('Local attestation commit must be a full 40-character SHA')
  }
  return commit.trim().toLowerCase()
}

function assignmentKey(line) {
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)
  return match?.[1]
}

export function formatLocalAttestationValue(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Local attestation JSON is required')
  }
  if (/\r|\n/.test(value)) {
    throw new Error('Local attestation JSON must be a single line')
  }
  if (value.includes("'")) {
    throw new Error('Local attestation JSON cannot contain a single quote')
  }
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
  } catch {
    throw new Error('Local attestation JSON is invalid')
  }
  return `${ATTESTATION_ENV_KEY}='${value}'`
}

function formatCommitValue(commit) {
  return `${COMMIT_ENV_KEY}=${assertCommit(commit)}`
}

export function updateDotEnvText(source, { commit, value } = {}) {
  if (typeof source !== 'string') throw new Error('.env content is required')
  const normalizedCommit = assertCommit(commit)
  const attestationLine = formatLocalAttestationValue(value)
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const hasTrailingNewline = /\r?\n$/.test(source)
  const lines = source.length === 0 ? [] : source.split(/\r?\n/)
  if (hasTrailingNewline) lines.pop()

  const replacements = new Map([
    [COMMIT_ENV_KEY, formatCommitValue(normalizedCommit)],
    [ATTESTATION_ENV_KEY, attestationLine],
  ])
  const seen = new Set()
  const updated = []
  for (const line of lines) {
    const key = assignmentKey(line)
    if (!replacements.has(key)) {
      updated.push(line)
      continue
    }
    if (!seen.has(key)) {
      updated.push(replacements.get(key))
      seen.add(key)
    }
  }
  for (const key of [COMMIT_ENV_KEY, ATTESTATION_ENV_KEY]) {
    if (!seen.has(key)) updated.push(replacements.get(key))
  }
  return `${updated.join(newline)}${newline}`
}

export async function readCurrentCommit({ cwd = process.cwd(), execImpl = execFileAsync } = {}) {
  const { stdout } = await execImpl('git', ['rev-parse', 'HEAD'], { cwd })
  return assertCommit(stdout)
}

export async function runLocalAttestation({
  commit,
  environment = process.env,
  cwd = process.cwd(),
  envPath = join(cwd, '.env'),
  generateRegistry = generateAttestationRegistry,
  generatedRegistry,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
} = {}) {
  const normalizedCommit = assertCommit(commit)
  const generated = generatedRegistry ?? (await generateRegistry({ commit: normalizedCommit, environment }))
  const value = generated?.value
  const source = await readFileImpl(envPath, 'utf8')
  const next = updateDotEnvText(source, { commit: normalizedCommit, value })
  await writeFileImpl(envPath, next, 'utf8')
  return Object.freeze({ commit: normalizedCommit, updated: true })
}

async function main() {
  const commit = await readCurrentCommit()
  const result = await runLocalAttestation({ commit, environment: process.env })
  console.log(`[local-attestation] updated .env for ${result.commit}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[local-attestation] failed: ${error?.message || 'attestation update failed'}`)
    process.exitCode = 1
  })
}
