import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { RUNTIME_SCHEMA_GENERATIONS } from '../server/bootstrap/schema-readiness.js'

const execFileAsync = promisify(execFile)
const ZERO_SHA = '0'.repeat(40)
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i
const VERCEL_ENV_KEY = 'RUNTIME_SCHEMA_ATTESTATIONS_JSON'
const VERCEL_API_VERSION = 'v9'
const VERCEL_CREATE_API_VERSION = 'v10'

export const ATTESTATION_SCOPES = Object.freeze(Object.keys(RUNTIME_SCHEMA_GENERATIONS))
export const ROLE_PROBE_SCOPES = Object.freeze([
  'auth-core',
  'sources',
  'provider-routing-v2',
  'chat-sessions',
  'governance',
])

function assertCommit(commit) {
  if (typeof commit !== 'string' || !COMMIT_PATTERN.test(commit)) {
    throw new Error('Pre-push attestation commit must be a full 40-character SHA')
  }
  return commit.toLowerCase()
}

function parseHookLine(line) {
  const fields = line.trim().split(/\s+/)
  if (fields.length !== 4) throw new Error('Invalid Git pre-push input')
  const [localRef, localSha, remoteRef, remoteSha] = fields
  if (
    !localRef ||
    !remoteRef ||
    (!COMMIT_PATTERN.test(localSha) && localSha !== ZERO_SHA) ||
    (!COMMIT_PATTERN.test(remoteSha) && remoteSha !== ZERO_SHA)
  ) {
    throw new Error('Invalid Git pre-push ref update')
  }
  return Object.freeze({
    localRef,
    localSha: localSha.toLowerCase(),
    remoteRef,
    remoteSha: remoteSha.toLowerCase(),
  })
}

export function parsePrePushInput(input) {
  if (typeof input !== 'string') throw new Error('Git pre-push input is required')
  const updates = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseHookLine)
  const branchUpdates = updates.filter(
    ({ localRef, localSha }) => localRef.startsWith('refs/heads/') && localSha !== ZERO_SHA,
  )
  if (branchUpdates.length === 0) return null
  if (branchUpdates.length !== 1)
    throw new Error('Pre-push attestation requires exactly one branch update')
  const update = branchUpdates[0]
  const branch = update.remoteRef.startsWith('refs/heads/')
    ? update.remoteRef.slice('refs/heads/'.length)
    : update.localRef.slice('refs/heads/'.length)
  return Object.freeze({
    branch,
    commit: assertCommit(update.localSha),
    target: branch === 'main' ? 'production' : 'preview',
  })
}

export function buildVerifierEnvironment({ environment = process.env, commit } = {}) {
  const next = { ...environment, SCHEMA_ATTESTATION_COMMIT: assertCommit(commit) }
  delete next.VERCEL_GIT_COMMIT_SHA
  return next
}

export function parseVerifierOutput(stdout, scope) {
  const lines =
    typeof stdout === 'string'
      ? stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const result = JSON.parse(lines[index])
      if (
        result?.verified === true &&
        result.runtimeSchemaAttestation?.payload?.scope === scope &&
        typeof result.runtimeSchemaAttestation.signature === 'string'
      )
        return result
    } catch {
      // Ignore non-JSON diagnostics. The caller receives a safe failure below.
    }
  }
  throw new Error(`db:verify failed for ${scope}`)
}

export function buildAttestationRegistry(results, scopes = ATTESTATION_SCOPES) {
  const registry = {}
  for (const result of results ?? []) {
    const attestation = result?.runtimeSchemaAttestation
    const scope = attestation?.payload?.scope
    if (!scopes.includes(scope))
      throw new Error(`Unexpected attestation scope: ${scope ?? 'unknown'}`)
    if (registry[scope]) throw new Error(`Duplicate attestation scope: ${scope}`)
    registry[scope] = attestation
  }
  for (const scope of scopes)
    if (!registry[scope]) throw new Error(`Missing attestation scope: ${scope}`)
  return Object.fromEntries(scopes.map((scope) => [scope, registry[scope]]))
}

export async function runDbVerify({
  scope,
  commit,
  requireRole = false,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  if (!ATTESTATION_SCOPES.includes(scope))
    throw new Error(`Unsupported attestation scope: ${scope}`)
  const args = [
    '--env-file-if-exists=.env',
    'scripts/db-verify.js',
    scope,
    '--issue-runtime-attestation',
  ]
  if (requireRole) args.push('--require-role')
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      cwd,
      env: buildVerifierEnvironment({ environment, commit }),
      maxBuffer: 1024 * 1024,
    })
    return parseVerifierOutput(stdout, scope)
  } catch {
    throw new Error(`db:verify failed for ${scope}`)
  }
}

export async function generateAttestationRegistry({
  commit,
  environment = process.env,
  scopes = ATTESTATION_SCOPES,
  runVerifier = runDbVerify,
} = {}) {
  const normalizedCommit = assertCommit(commit)
  const uniqueScopes = [...new Set(scopes)]
  if (uniqueScopes.length !== scopes.length)
    throw new Error('Pre-push attestation scopes must be unique')
  if (uniqueScopes.some((scope) => !ATTESTATION_SCOPES.includes(scope)))
    throw new Error('Pre-push attestation scope is unsupported')
  const results = []
  for (const scope of uniqueScopes) {
    results.push(
      await runVerifier({
        scope,
        commit: normalizedCommit,
        environment,
        requireRole: ROLE_PROBE_SCOPES.includes(scope),
      }),
    )
  }
  const registry = buildAttestationRegistry(results, uniqueScopes)
  return Object.freeze({ registry, value: JSON.stringify(registry) })
}

export function createVercelEnvironmentPayload({ key, value, target } = {}) {
  if (key !== VERCEL_ENV_KEY) throw new Error(`Only ${VERCEL_ENV_KEY} can be updated by this hook`)
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Vercel attestation value is required')
  if (!['production', 'preview'].includes(target))
    throw new Error('Vercel environment target is invalid')
  return Object.freeze({ key, value, type: 'encrypted', target: [target] })
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

export async function resolveVercelProject({
  environment = process.env,
  cwd = process.cwd(),
  readFileImpl = readFile,
} = {}) {
  const explicitProjectId = environment.PREPUSH_VERCEL_PROJECT_ID?.trim()
  const explicitTeamId = environment.PREPUSH_VERCEL_TEAM_ID?.trim()
  if (explicitProjectId)
    return Object.freeze({ projectId: explicitProjectId, teamId: explicitTeamId || undefined })
  try {
    const project = JSON.parse(await readFileImpl(`${cwd}/.vercel/project.json`, 'utf8'))
    if (typeof project.projectId !== 'string' || !project.projectId.trim())
      throw new Error('Vercel project id is missing')
    return Object.freeze({
      projectId: project.projectId,
      teamId: explicitTeamId || project.orgId || undefined,
    })
  } catch {
    throw new Error('Vercel project is not linked; set PREPUSH_VERCEL_PROJECT_ID')
  }
}

export async function updateVercelEnvironmentVariable({
  environment = process.env,
  target,
  value,
  fetchImpl = globalThis.fetch,
  readFileImpl = readFile,
  cwd = process.cwd(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for Vercel update')
  const tokenEnv = environment.PREPUSH_VERCEL_API_TOKEN_ENV?.trim() || 'VERCEL_API_TOKEN'
  const token = environment[tokenEnv]
  if (typeof token !== 'string' || !token.trim())
    throw new Error(`Missing ${tokenEnv} for Vercel update`)
  const { projectId, teamId } = await resolveVercelProject({ environment, cwd, readFileImpl })
  const base = `https://api.vercel.com/${VERCEL_API_VERSION}/projects/${encodeURIComponent(projectId)}/env`
  const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` }
  const listUrl = withTeamId(`${base}?decrypt=false`, teamId)
  const listResponse = await fetchImpl(listUrl, { method: 'GET', headers })
  await assertResponse(listResponse, 'environment lookup')
  const listed = await listResponse.json()
  const existing = (Array.isArray(listed?.envs) ? listed.envs : []).find(
    (entry) => entry?.key === VERCEL_ENV_KEY && !entry.gitBranch && entry.target?.includes(target),
  )
  const payload = createVercelEnvironmentPayload({ key: VERCEL_ENV_KEY, value, target })
  if (existing?.id) {
    const targets = [
      ...new Set([...(Array.isArray(existing.target) ? existing.target : []), target]),
    ]
    const updateUrl = withTeamId(`${base}/${encodeURIComponent(existing.id)}`, teamId)
    const updateResponse = await fetchImpl(updateUrl, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, target: targets }),
    })
    await assertResponse(updateResponse, 'environment update')
    return Object.freeze({ updated: true, target, projectId })
  }
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
  return Object.freeze({ updated: false, target, projectId })
}

export async function runPrePushAttestation({
  input,
  environment = process.env,
  scopes = ATTESTATION_SCOPES,
  runVerifier = runDbVerify,
  updateVercel = updateVercelEnvironmentVariable,
} = {}) {
  const push = parsePrePushInput(input)
  if (!push) return Object.freeze({ skipped: true })
  if (environment.PREPUSH_VERCEL_UPDATE !== 'true') {
    throw new Error('PREPUSH_VERCEL_UPDATE=true is required when attestation gate is enabled')
  }
  const generated = await generateAttestationRegistry({
    commit: push.commit,
    environment,
    scopes,
    runVerifier,
  })
  await updateVercel({
    environment,
    target: push.target,
    value: generated.value,
    commit: push.commit,
    branch: push.branch,
  })
  return Object.freeze({
    branch: push.branch,
    commit: push.commit,
    target: push.target,
    scopeCount: Object.keys(generated.registry).length,
  })
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  if (process.env.PREPUSH_ATTESTATION_ENABLED !== 'true') {
    console.warn(
      '[pre-push] attestation gate disabled; set PREPUSH_ATTESTATION_ENABLED=true to enforce it',
    )
    return
  }
  const input = await readStdin()
  const result = await runPrePushAttestation({ input, environment: process.env })
  if (!result.skipped)
    console.log(
      `[pre-push] verified ${result.scopeCount} schema scopes for ${result.commit} and updated Vercel ${result.target}`,
    )
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[pre-push] blocked: ${error?.message || 'attestation failed'}`)
    process.exitCode = 1
  })
}
