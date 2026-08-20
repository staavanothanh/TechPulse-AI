export function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null
  } catch {
    return null
  }
}

export function safeMediaUrl(value) {
  return safeExternalUrl(value)
}

export const safeHttpsUrl = safeExternalUrl
