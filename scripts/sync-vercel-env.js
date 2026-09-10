/**
 * Vercel environment sync for the provider admission graph.
 *
 * Single-writer discipline (ADR-0013 runtime configuration):
 *   - This script is the EXCLUSIVE writer of `PROVIDER_ADMISSION_DOMAINS_JSON`
 *     in Vercel. It allowlists exactly that key and rejects every other key
 *     fail-closed.
 *   - `RUNTIME_SCHEMA_ATTESTATIONS_JSON` is the EXCLUSIVE writer of
 *     `scripts/pre-push-attestation.js`. Its value is freshly generated and
 *     commit-bound at push time, so copying a stale local value into Vercel
 *     would break the deploy binding and is actively harmful. This script
 *     therefore rejects `RUNTIME_SCHEMA_ATTESTATIONS_JSON` just like any other
 *     non-allowlisted key, ensuring both JSON variables have exactly one writer.
 *
 * Modes:
 *   - Hook mode (no `--target`): reads pre-push stdin, maps branch -> target
 *     (`main` -> `production`, otherwise `preview`). This is the only gated
 *     path: it requires `PREPUSH_ENV_SYNC=true` (default off) and skips silently
 *     otherwise.
 *   - Direct mode (`--target=production|preview`): an explicit, deliberate
 *     operator invocation; not gated by `PREPUSH_ENV_SYNC` because the operator
 *     is issuing the command directly.
 *
 * Value handling:
 *   - The value is read from `PROVIDER_ADMISSION_DOMAINS_JSON` in the process
 *     environment (invoke with `node --env-file-if-exists=.env`, mirroring the
 *     attestation hook).
 *   - It is parsed and compactly re-serialized for a clock-free SHA-256 identity
 *     (the raw-but-validated input is preserved verbatim; the provider-registry
 *     validator's normalized output is a runtime representation that does not
 *     round-trip through `exactObject` re-validation, so it is deliberately NOT
 *     persisted).
 *   - Schema validation runs only on the change path: `validateProviderConfiguration`
 *     is time-dependent (route `evidenceExpiresAt`), so an unchanged, already-synced
 *     graph must remain a clean no-op even after its evidence expires.
 *   - Sync happens only when the SHA-256 differs from a gitignored sidecar
 *     checksum (`.vercel-env-sync/<key>.<projectId>.<target>.json`), so no value
 *     is ever read back from Vercel or printed.
 *
 * Output is limited to `{ key, changed, lengthBefore, lengthAfter, target, dryRun, projectId }`.
 * This sidecar stores an unsalted SHA-256 + byte length of a NON-SECRET value;
 * do not reuse the pattern for secret values (use a keyed hash and omit length).
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePrePushInput, resolveVercelProject } from './pre-push-attestation.js'
import { validateProviderConfiguration } from '../server/ai/provider-registry.js'

const SYNC_ENV_KEY = 'PROVIDER_ADMISSION_DOMAINS_JSON'
const VERCEL_API_VERSION = 'v9'
const VERCEL_CREATE_API_VERSION = 'v10'
const SIDECAR_DIR = '.vercel-env-sync'
const VALID_TARGETS = new Set(['production', 'preview'])

export { SYNC_ENV_KEY }

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function withTeamId(url, teamId) {
  if (!teamId) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}teamId=${encodeURIComponent(teamId)}`
}

async function assertResponse(response, operation) {
  if (response?.ok) return
  const status = Number.isInteger(response?.status) ? ` (${response.status})` : ''
  throw new Error(`Vercel ${operation} failed${status}`)
}

function assertTarget(target) {
  if (!VALID_TARGETS.has(target)) throw new Error('Vercel environment target is invalid')
  return target
}

export function envSyncEnabled(environment = process.env) {
  return environment.PREPUSH_ENV_SYNC === 'true'
}

export function createEnvSyncPayload({ key, value, target } = {}) {
  if (key !== SYNC_ENV_KEY)
    throw new Error(`Only ${SYNC_ENV_KEY} can be synced by this hook`)
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Provider admission graph value is required')
  assertTarget(target)
  return Object.freeze({ key, value, type: 'encrypted', target: [target] })
}

export function parseProviderConfig(value) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Provider admission graph value is required')
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('Provider admission graph is not valid JSON')
  }
}

/** Clock-free compact re-serialization used for the identity hash. */
export function serializeProviderConfig(value) {
  return JSON.stringify(parseProviderConfig(value))
}

/** Time-dependent schema validation, run only on the change path. */
export function assertProviderConfigValid(value, { validate = validateProviderConfiguration } = {}) {
  validate(parseProviderConfig(value))
}

function sidecarPath({ cwd, projectId, target }) {
  return join(cwd, SIDECAR_DIR, `${SYNC_ENV_KEY}.${projectId}.${target}.json`)
}

async function readSyncedState({ cwd, projectId, target, readFileImpl = readFile } = {}) {
  try {
    const parsed = JSON.parse(await readFileImpl(sidecarPath({ cwd, projectId, target }), 'utf8'))
    if (typeof parsed?.hash === 'string' && Number.isFinite(parsed?.length)) return parsed
    return null
  } catch {
    // ENOENT (never synced) and a corrupted/unparseable sidecar both degrade to
    // "never synced" -> a harmless, idempotent re-write on the next change.
    return null
  }
}

async function writeSyncedState({
  cwd,
  projectId,
  target,
  hash,
  length,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
} = {}) {
  const path = sidecarPath({ cwd, projectId, target })
  await mkdirImpl(dirname(path), { recursive: true })
  await writeFileImpl(path, JSON.stringify({ hash, length }), 'utf8')
}

export async function syncVercelEnvironmentVariable({
  environment = process.env,
  target,
  value,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  readStateImpl = readSyncedState,
  writeStateImpl = writeSyncedState,
  writeFileImpl = writeFile,
  mkdirImpl = mkdir,
  validate = validateProviderConfiguration,
  cwd = process.cwd(),
  dryRun = false,
} = {}) {
  assertTarget(target)
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for Vercel sync')

  const normalized = serializeProviderConfig(value)
  const hash = sha256(normalized)
  const lengthAfter = Buffer.byteLength(normalized, 'utf8')
  const { projectId, teamId } = await resolveVercelProject({ environment, cwd, readFileImpl })
  const prev = await readStateImpl({ cwd, projectId, target, readFileImpl })
  const changed = prev?.hash !== hash
  const lengthBefore = prev?.length ?? 0

  if (!changed) {
    return Object.freeze({
      key: SYNC_ENV_KEY,
      changed: false,
      lengthBefore,
      lengthAfter,
      target,
      dryRun,
    })
  }

  // Validate only on the change path: the schema check is time-dependent, so an
  // unchanged value must not be re-blocked by clock advance.
  assertProviderConfigValid(value, { validate })

  const tokenEnv = environment.PREPUSH_VERCEL_API_TOKEN_ENV?.trim() || 'VERCEL_API_TOKEN'
  const token = environment[tokenEnv]
  if (typeof token !== 'string' || !token.trim())
    throw new Error(`Missing ${tokenEnv} for Vercel sync`)

  if (dryRun) {
    return Object.freeze({
      key: SYNC_ENV_KEY,
      changed,
      lengthBefore,
      lengthAfter,
      target,
      dryRun,
      projectId,
    })
  }

  const base = `https://api.vercel.com/${VERCEL_API_VERSION}/projects/${encodeURIComponent(projectId)}/env`
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` }
  const listUrl = withTeamId(`${base}?decrypt=false`, teamId)
  const listResponse = await fetchImpl(listUrl, { method: 'GET', headers })
  await assertResponse(listResponse, 'environment lookup')
  const listed = await listResponse.json()
  const existing = (Array.isArray(listed?.envs) ? listed.envs : []).find(
    (entry) => entry?.key === SYNC_ENV_KEY && !entry.gitBranch && entry.target?.includes(target),
  )
  const payload = createEnvSyncPayload({ key: SYNC_ENV_KEY, value: normalized, target })
  if (existing?.id) {
    const targets = [
      ...new Set([...(Array.isArray(existing.target) ? existing.target : []), target]),
    ]
    const updateUrl = withTeamId(`${base}/${encodeURIComponent(existing.id)}`, teamId)
    const updateResponse = await fetchImpl(updateUrl, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: normalized, target: targets }),
    })
    await assertResponse(updateResponse, 'environment update')
  } else {
    const createUrl = withTeamId(
      `https://api.vercel.com/${VERCEL_CREATE_API_VERSION}/projects/${encodeURIComponent(projectId)}/env?upsert=true`,
      teamId,
    )
    const createResponse = await fetchImpl(createUrl, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    await assertResponse(createResponse, 'environment creation')
  }
  await writeStateImpl({ cwd, projectId, target, hash, length: lengthAfter, writeFileImpl, mkdirImpl })

  return Object.freeze({
    key: SYNC_ENV_KEY,
    changed,
    lengthBefore,
    lengthAfter,
    target,
    dryRun,
    projectId,
  })
}

export async function runEnvSync({
  input,
  environment = process.env,
  target: explicitTarget,
  sync = syncVercelEnvironmentVariable,
  dryRun = false,
} = {}) {
  let target = explicitTarget
  if (!target) {
    // Hook mode is gated: the gate is checked before parsing pre-push input so
    // a disabled gate never performs input parsing work.
    if (!envSyncEnabled(environment)) return Object.freeze({ skipped: true })
    const push = parsePrePushInput(input)
    if (!push) return Object.freeze({ skipped: true })
    target = push.target
  }
  assertTarget(target)

  const value = environment[SYNC_ENV_KEY]
  if (typeof value !== 'string' || !value.trim())
    throw new Error(
      `${SYNC_ENV_KEY} is not set in the environment; run with --env-file-if-exists=.env`,
    )

  return sync({ environment, target, value, dryRun })
}

export function parseArgs(argv) {
  let target
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg.startsWith('--target=')) {
      const candidate = arg.slice('--target='.length)
      assertTarget(candidate)
      target = candidate
      continue
    }
    throw new Error(`Unknown env-sync argument: ${arg}`)
  }
  return { target, dryRun }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  const { target: explicitTarget, dryRun } = parseArgs(process.argv.slice(2))
  if (explicitTarget) {
    const result = await runEnvSync({ target: explicitTarget, environment: process.env, dryRun })
    console.log(JSON.stringify(result))
    return
  }
  const input = await readStdin()
  const result = await runEnvSync({ input, environment: process.env, dryRun })
  if (result.skipped) {
    console.warn('[pre-push] env sync disabled; set PREPUSH_ENV_SYNC=true to enforce it')
  } else {
    console.log(JSON.stringify(result))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[pre-push] env sync blocked: ${error?.message || 'env sync failed'}`)
    process.exitCode = 1
  })
}
