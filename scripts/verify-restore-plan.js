import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{2,127}$/
const RESTORE_DATABASE = /^techpulse_app_restore_[a-z0-9][a-z0-9_-]{2,95}$/
const FORBIDDEN_SECRET_FIELDS = new Set([
  'apikey',
  'accesstoken',
  'credential',
  'credentials',
  'credentialvalue',
  'hmackey',
  'keymaterial',
  'mongouri',
  'password',
  'privatekey',
  'secret',
  'token',
  'uri',
])
const URI_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i
const MONGO_URI = /^mongodb(?:\+srv)?:\/\//i
const BEARER_TOKEN = /^bearer\s+[a-z0-9._~+/=-]{20,}$/i
const API_TOKEN_PREFIX = /^(?:sk|pk|ghp|github_pat|xox[abprs])[-_][a-z0-9_-]{20,}$/i
const JWT = /^[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{20,}$/i

export const RESTORE_EXTERNAL_GATES = Object.freeze([
  'atlas_app_dump_created',
  'governance_sidecar_exported',
  'governance_sidecar_signature_verified',
  'isolated_restore_completed',
  'current_governance_chain_verified',
  'restored_sessions_and_ephemeral_state_cleared',
  'restored_governance_reconciled',
  'restored_pii_and_available_citations_zero_verified',
  'runtime_secrets_rotated_and_stale_credentials_revoked',
  'owner_serve_approval_recorded',
  'backup_destruction_recorded',
])

function validDate(value) {
  const date = new Date(value)
  return typeof value === 'string' && !Number.isNaN(date.getTime()) ? date : null
}

function nonEmpty(value, maximum = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum
}

function normalizedFieldName(value) {
  return String(value).replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function highEntropyOpaqueValue(value) {
  if (!/^[a-z0-9+/_=-]{32,512}$/i.test(value)) return false
  return /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value)
}

function secretLikeValue(value) {
  if (typeof value !== 'string') return false
  return MONGO_URI.test(value) || URI_WITH_USERINFO.test(value) || BEARER_TOKEN.test(value) || API_TOKEN_PREFIX.test(value) || JWT.test(value) || highEntropyOpaqueValue(value)
}

function findForbiddenContent(value, path = '', found = { fields: [], values: [] }) {
  if (!value || typeof value !== 'object') return found
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key
    if (FORBIDDEN_SECRET_FIELDS.has(normalizedFieldName(key))) found.fields.push(childPath)
    else if (secretLikeValue(child)) found.values.push(childPath)
    else findForbiddenContent(child, childPath, found)
  }
  return found
}

function validateArtifact(value, label, segment, backupId, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} inventory is required`)
    return
  }
  if (value.encrypted !== true) errors.push(`${label} must be encrypted`)
  if (value.storageClass !== 'private-external') errors.push(`${label} storage must be private and external to the repository`)
  if (value.storageRef !== `external-private:${backupId}/${segment}`) errors.push(`${label} storage reference must match the current backup inventory`)
  if (!SHA256.test(value.sha256 ?? '')) errors.push(`${label} SHA-256 inventory digest is invalid`)
}

export function validateRestorePlan(plan, { now = new Date() } = {}) {
  const errors = []
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    errors.push('restore plan must be an object')
  } else {
    const forbidden = findForbiddenContent(plan)
    for (const path of forbidden.fields) errors.push(`restore plan contains forbidden secret field: ${path}`)
    for (const path of forbidden.values) errors.push(`restore plan contains forbidden secret-like value: ${path}`)
    if (!SAFE_ID.test(plan.backupId ?? '')) errors.push('backupId is invalid')
    if (!nonEmpty(plan.owner, 128)) errors.push('backup owner is required')

    const createdAt = validDate(plan.createdAt)
    const destroyAt = validDate(plan.destroyAt)
    const observedAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : null
    if (!createdAt) errors.push('createdAt is invalid')
    if (!destroyAt) errors.push('destroyAt is invalid')
    if (!observedAt) errors.push('verification clock is invalid')
    if (createdAt && observedAt && createdAt.getTime() > observedAt.getTime()) errors.push('createdAt cannot be in the future')
    if (createdAt && destroyAt && (destroyAt.getTime() <= createdAt.getTime() || destroyAt.getTime() - createdAt.getTime() > MAX_RETENTION_MS)) errors.push('backup retention must be greater than zero and at most seven days')

    validateArtifact(plan.appDump, 'app dump', 'app', plan.backupId, errors)
    if (plan.appDump?.sourceDatabase !== 'techpulse_app') errors.push('app dump source database must be techpulse_app')
    if (plan.appDump?.readOnlyCredential !== true) errors.push('app dump must use a read-only credential')

    validateArtifact(plan.governanceSidecar, 'governance sidecar', 'governance', plan.backupId, errors)
    if (plan.governanceSidecar?.sourceDatabase !== 'techpulse_governance') errors.push('governance sidecar source database must be techpulse_governance')
    if (plan.governanceSidecar?.readOnly !== true) errors.push('governance sidecar export must be read-only')
    if (plan.governanceSidecar?.signingAlgorithm !== 'HMAC-SHA-256') errors.push('governance sidecar signing algorithm is invalid')
    if (!SAFE_ID.test(plan.governanceSidecar?.signingKeyId ?? '')) errors.push('governance sidecar signing key ID is invalid')
    if (!SAFE_ID.test(plan.governanceSidecar?.checkpointId ?? '')) errors.push('governance sidecar checkpoint ID is invalid')

    const restore = plan.restore
    if (!restore || typeof restore !== 'object' || Array.isArray(restore)) errors.push('restore target is required')
    else {
      if (!RESTORE_DATABASE.test(restore.targetDatabase ?? '')) errors.push('restore target must be an isolated techpulse_app_restore_* database')
      if (restore.isolated !== true) errors.push('restore target must be isolated')
      if (restore.serving !== false) errors.push('restore target must be non-serving during rehearsal')
      if (restore.overwriteGovernance !== false) errors.push('restore must not overwrite techpulse_governance')
    }
  }

  return Object.freeze({
    planValid: errors.length === 0,
    restoreRehearsalVerified: false,
    serveGate: 'closed',
    errors: Object.freeze(errors),
    pendingExternalGates: RESTORE_EXTERNAL_GATES,
  })
}

async function main() {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-restore-plan.js <restore-plan.json>')
  const plan = JSON.parse(await readFile(process.argv[2], 'utf8'))
  const result = validateRestorePlan(plan)
  console.log(JSON.stringify(result))
  if (!result.planValid) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Restore plan preflight failed: invalid_local_plan')
    process.exitCode = 1
  })
}
