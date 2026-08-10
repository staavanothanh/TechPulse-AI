const KEY_PARTS = Object.freeze({
  ingestion: Object.freeze(['ingestion', 'source']),
  indexing: Object.freeze(['indexing', 'article']),
  reconciliation: Object.freeze(['reconciliation', 'source']),
  'account-deletion': Object.freeze(['account-deletion', 'user']),
})

const OPAQUE_ID = /^[a-z0-9_-]{1,128}$/

export function deriveLeaseKey(resource, opaqueId) {
  const parts = KEY_PARTS[resource]
  if (!parts || typeof opaqueId !== 'string' || !OPAQUE_ID.test(opaqueId)) {
    throw new Error('Canonical lease resource and opaque id are required')
  }
  return `${parts[0]}:${parts[1]}:${opaqueId}`
}

export function assertCanonicalLeaseKey(key) {
  if (typeof key !== 'string') throw new Error('Canonical lease key is required')
  const matched = Object.entries(KEY_PARTS).find(([, parts]) => key.startsWith(`${parts[0]}:${parts[1]}:`))
  if (!matched) throw new Error('Canonical lease key is required')
  const prefix = `${matched[1][0]}:${matched[1][1]}:`
  if (deriveLeaseKey(matched[0], key.slice(prefix.length)) !== key) throw new Error('Canonical lease key is required')
  return key
}

export const LEASE_KEY_RESOURCES = Object.freeze(Object.keys(KEY_PARTS))
