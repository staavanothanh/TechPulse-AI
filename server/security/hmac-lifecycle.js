import { createHash } from 'node:crypto'
import { ObjectId } from 'mongodb'
import { HMAC_RETIREMENT_MIN_MS, validateRetiringKey } from './hmac-keyring.js'

const INVENTORY_ID = 'quota-hmac'
const GENESIS_HASH = '0'.repeat(64)
const MAX_SNAPSHOTS = 128

function canonicalJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function validDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime())
}

function snapshotPayload(snapshot) {
  return {
    inventoryId: snapshot.inventoryId,
    revision: snapshot.revision,
    previousRevision: snapshot.previousRevision,
    previousSnapshotHash: snapshot.previousSnapshotHash,
    currentVersion: snapshot.currentVersion,
    versions: snapshot.versions,
    recordedAt: snapshot.recordedAt,
  }
}

export function hashHmacLifecycleSnapshot(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshotPayload(snapshot)), 'utf8').digest('hex')
}

function versionFieldsEqual(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function validateVersionEntry(entry) {
  if (!entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.version) || entry.version < 1 || !['current', 'retiring', 'retired'].includes(entry.state)) {
    throw new Error('quota HMAC lifecycle version is invalid')
  }
  if (typeof entry.keyFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(entry.keyFingerprint) || !validDate(entry.firstObservedAt)) {
    throw new Error('quota HMAC lifecycle fingerprint or observation time is invalid')
  }
  if (entry.state === 'current') {
    if (entry.successorVersion !== undefined || entry.successorActivatedAt !== undefined || entry.retiredAt !== undefined || entry.dependentEvidence !== undefined) {
      throw new Error('quota HMAC current lifecycle entry is contradictory')
    }
    return
  }
  if (!Number.isSafeInteger(entry.successorVersion) || entry.successorVersion <= entry.version || !validDate(entry.successorActivatedAt)) {
    throw new Error('quota HMAC lifecycle successor is invalid')
  }
  if (entry.state === 'retiring') {
    if (entry.retiredAt !== undefined || entry.dependentEvidence !== undefined) throw new Error('quota HMAC retiring lifecycle entry is contradictory')
    return
  }
  const evidence = entry.dependentEvidence
  if (!validDate(entry.retiredAt) || !evidence || evidence.rateLimitBuckets !== 0 || evidence.sessions !== 0 || evidence.adminAuditLogs !== 0 || Object.keys(evidence).length !== 3) {
    throw new Error('quota HMAC retired lifecycle entry lacks zero-dependent evidence')
  }
}

function validateSnapshot(snapshot, expectedRevision, previous) {
  if (!snapshot || snapshot.inventoryId !== INVENTORY_ID || snapshot.revision !== expectedRevision || snapshot.previousRevision !== expectedRevision - 1 || !validDate(snapshot.recordedAt)) {
    throw new Error('quota HMAC lifecycle revision history is missing or rolled back')
  }
  const expectedPreviousHash = previous?.snapshotHash ?? GENESIS_HASH
  if (snapshot.previousSnapshotHash !== expectedPreviousHash || snapshot.snapshotHash !== hashHmacLifecycleSnapshot(snapshot)) {
    throw new Error('quota HMAC lifecycle snapshot hash chain is invalid')
  }
  if (!Array.isArray(snapshot.versions) || snapshot.versions.length === 0 || snapshot.versions.length > 64) throw new Error('quota HMAC lifecycle inventory is invalid')
  const seen = new Set()
  let priorVersion = 0
  let currentCount = 0
  for (const entry of snapshot.versions) {
    validateVersionEntry(entry)
    if (seen.has(entry.version) || entry.version <= priorVersion) throw new Error('quota HMAC lifecycle versions must be unique and monotonic')
    seen.add(entry.version)
    priorVersion = entry.version
    if (entry.state === 'current') {
      currentCount += 1
      if (entry.version !== snapshot.currentVersion) throw new Error('quota HMAC lifecycle current version is contradictory')
    }
  }
  if (currentCount !== 1) throw new Error('quota HMAC lifecycle must have exactly one current version')
}

function validateTransition(previous, next) {
  const nextByVersion = new Map(next.versions.map((entry) => [entry.version, entry]))
  const previousByVersion = new Map(previous.versions.map((entry) => [entry.version, entry]))
  for (const previousEntry of previous.versions) {
    const nextEntry = nextByVersion.get(previousEntry.version)
    if (!nextEntry) throw new Error('quota HMAC lifecycle history removed a recorded version')
    if (previousEntry.keyFingerprint !== nextEntry.keyFingerprint || previousEntry.firstObservedAt.getTime() !== nextEntry.firstObservedAt.getTime()) {
      throw new Error('quota HMAC lifecycle immutable version identity changed')
    }
    if (previousEntry.state === nextEntry.state) {
      if (!versionFieldsEqual(previousEntry, nextEntry)) throw new Error('quota HMAC lifecycle state was rewritten')
      continue
    }
    if (previousEntry.state === 'current' && nextEntry.state === 'retiring') {
      if (nextEntry.successorVersion !== next.currentVersion || nextEntry.successorActivatedAt.getTime() !== next.recordedAt.getTime()) {
        throw new Error('quota HMAC lifecycle current-to-retiring transition is contradictory')
      }
      continue
    }
    if (previousEntry.state === 'retiring' && nextEntry.state === 'retired') {
      if (nextEntry.successorVersion !== previousEntry.successorVersion || nextEntry.successorActivatedAt.getTime() !== previousEntry.successorActivatedAt.getTime()) {
        throw new Error('quota HMAC lifecycle retiring-to-retired transition rewrote successor history')
      }
      continue
    }
    throw new Error('quota HMAC lifecycle state rollback is forbidden')
  }
  const added = next.versions.filter((entry) => !previousByVersion.has(entry.version))
  if (next.currentVersion === previous.currentVersion) {
    if (added.length !== 0) throw new Error('quota HMAC lifecycle added a version without current rotation')
    return
  }
  const previousMaximum = previous.versions.at(-1).version
  if (added.length !== 1 || added[0].version !== next.currentVersion || added[0].state !== 'current' || next.currentVersion <= previousMaximum) {
    throw new Error('quota HMAC lifecycle current version rollback or gap is forbidden')
  }
}

export function validateHmacLifecycleHistory(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length > MAX_SNAPSHOTS) throw new Error('quota HMAC lifecycle history is unbounded')
  let previous = null
  snapshots.forEach((snapshot, index) => {
    validateSnapshot(snapshot, index + 1, previous)
    if (previous) validateTransition(previous, snapshot)
    previous = snapshot
  })
  return previous
}

function createSnapshot({ previous, currentVersion, versions, now }) {
  const snapshot = {
    _id: new ObjectId(),
    inventoryId: INVENTORY_ID,
    revision: (previous?.revision ?? 0) + 1,
    previousRevision: previous?.revision ?? 0,
    previousSnapshotHash: previous?.snapshotHash ?? GENESIS_HASH,
    currentVersion,
    versions: versions.sort((left, right) => left.version - right.version),
    recordedAt: new Date(now),
  }
  snapshot.snapshotHash = hashHmacLifecycleSnapshot(snapshot)
  return snapshot
}

function initialSnapshot(keyring, now) {
  const retiringVersions = keyring.versions.filter((version) => version !== keyring.currentVersion)
  if (retiringVersions.some((version) => version >= keyring.currentVersion)) throw new Error('quota HMAC predecessor versions must be lower than current version')
  const versions = retiringVersions.map((version) => ({
    version,
    state: 'retiring',
    keyFingerprint: keyring.fingerprint(version),
    firstObservedAt: new Date(now),
    successorVersion: keyring.currentVersion,
    successorActivatedAt: new Date(now),
  }))
  versions.push({
    version: keyring.currentVersion,
    state: 'current',
    keyFingerprint: keyring.fingerprint(keyring.currentVersion),
    firstObservedAt: new Date(now),
  })
  return createSnapshot({ previous: null, currentVersion: keyring.currentVersion, versions, now })
}

function totalDependents(counts) {
  const fields = ['rateLimitBuckets', 'sessions', 'adminAuditLogs']
  if (!counts || fields.some((field) => !Number.isSafeInteger(counts[field]) || counts[field] < 0)) throw new Error('quota HMAC dependent evidence is invalid')
  return fields.reduce((total, field) => total + counts[field], 0)
}

async function planNextSnapshot({ repository, keyring, latest, now, session }) {
  const configuredRetiring = keyring.versions.filter((version) => version !== keyring.currentVersion)
  const versions = latest.versions.map((entry) => structuredClone(entry))
  let changed = false
  let current = versions.find((entry) => entry.state === 'current')

  if (keyring.currentVersion !== current.version) {
    const maximum = versions.at(-1).version
    if (keyring.currentVersion <= maximum || !configuredRetiring.includes(current.version)) throw new Error('quota HMAC current version rollback or missing predecessor is forbidden')
    current.state = 'retiring'
    current.successorVersion = keyring.currentVersion
    current.successorActivatedAt = new Date(now)
    versions.push({
      version: keyring.currentVersion,
      state: 'current',
      keyFingerprint: keyring.fingerprint(keyring.currentVersion),
      firstObservedAt: new Date(now),
    })
    changed = true
  }

  const byVersion = new Map(versions.map((entry) => [entry.version, entry]))
  for (const version of keyring.versions) {
    const entry = byVersion.get(version)
    if (!entry || entry.state === 'retired' || entry.keyFingerprint !== keyring.fingerprint(version)) {
      throw new Error('quota HMAC runtime config contradicts durable lifecycle history')
    }
    const expectedState = version === keyring.currentVersion ? 'current' : 'retiring'
    if (entry.state !== expectedState) throw new Error('quota HMAC runtime config rolled back lifecycle state')
  }

  for (const entry of versions) {
    if (entry.state !== 'retiring' || configuredRetiring.includes(entry.version)) continue
    const counts = await repository.countHmacDependentsByKeyVersion(entry.version, { session })
    const dependentCount = totalDependents(counts)
    const gate = validateRetiringKey({ retiringSince: entry.successorActivatedAt, dependentCount, now })
    if (gate.ageMs < HMAC_RETIREMENT_MIN_MS) throw new Error(`quota HMAC predecessor version ${entry.version} successor must be active for 30 days`)
    if (!gate.eligible) throw new Error(`quota HMAC predecessor version ${entry.version} still has dependent records`)
    entry.state = 'retired'
    entry.retiredAt = new Date(now)
    entry.dependentEvidence = { rateLimitBuckets: counts.rateLimitBuckets, sessions: counts.sessions, adminAuditLogs: counts.adminAuditLogs }
    changed = true
  }

  const finalCurrent = versions.filter((entry) => entry.state === 'current')
  const finalRetiring = versions.filter((entry) => entry.state === 'retiring').map((entry) => entry.version).sort((a, b) => a - b)
  const expectedRetiring = [...configuredRetiring].sort((a, b) => a - b)
  if (finalCurrent.length !== 1 || finalCurrent[0].version !== keyring.currentVersion || canonicalJson(finalRetiring) !== canonicalJson(expectedRetiring)) {
    throw new Error('quota HMAC runtime config does not match durable lifecycle inventory')
  }
  if (!changed) return latest
  return createSnapshot({ previous: latest, currentVersion: keyring.currentVersion, versions, now })
}

export async function reconcileQuotaHmacLifecycle({ repository, keyring, now = new Date() } = {}) {
  if (!repository?.withTransaction || !repository?.listHmacLifecycleSnapshots || !repository?.appendHmacLifecycleSnapshot || !repository?.countHmacDependentsByKeyVersion) {
    throw new Error('quota HMAC lifecycle repository is required')
  }
  if (!keyring?.versions || !keyring?.fingerprint || !Number.isSafeInteger(keyring.currentVersion) || !validDate(now)) throw new Error('quota HMAC lifecycle keyring and clock are required')

  let lastDuplicate
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await repository.withTransaction(async (session) => {
        const snapshots = await repository.listHmacLifecycleSnapshots({ session })
        const latest = validateHmacLifecycleHistory(snapshots)
        const snapshot = latest
          ? await planNextSnapshot({ repository, keyring, latest, now, session })
          : initialSnapshot(keyring, now)
        if (snapshot !== latest) {
          await repository.appendHmacLifecycleSnapshot(snapshot, { session })
          validateHmacLifecycleHistory([...snapshots, snapshot])
        }
        return { snapshot, changed: snapshot !== latest }
      })
    } catch (error) {
      if (error?.code !== 11000 || attempt === 2) throw error
      lastDuplicate = error
    }
  }
  throw lastDuplicate
}

export const HMAC_LIFECYCLE_INVENTORY_ID = INVENTORY_ID
