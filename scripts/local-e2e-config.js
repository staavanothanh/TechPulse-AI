export function validateLocalE2eEndpoints({ baseUrl = 'http://localhost:3000', origin = baseUrl } = {}) {
  let base
  let requestOrigin
  try {
    base = new URL(baseUrl)
    requestOrigin = new URL(origin)
  } catch {
    throw new Error('Local E2E requires valid localhost URL and Origin')
  }
  if (base.protocol !== 'http:' || base.hostname !== 'localhost') throw new Error('Local E2E requires E2E_BASE_URL to use http://localhost')
  if (requestOrigin.origin !== base.origin) throw new Error('Local E2E requires E2E_ORIGIN to match E2E_BASE_URL')
  return Object.freeze({ baseUrl: base.origin, origin: requestOrigin.origin })
}
