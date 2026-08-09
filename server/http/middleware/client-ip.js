import { isIP } from 'node:net'

function isPrivateIpv4(ip) {
  const octets = ip.split('.').map(Number)
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase()
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
  return normalized === '::' || normalized === '::1' || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || first >= 0xff00
}

function canonicalIpv6(ip) {
  const [address] = ip.toLowerCase().split('%', 1)
  const halves = address.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':').filter(Boolean) : []
  if (left.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) || right.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => part.padStart(4, '0'))
  if (groups.length !== 8) return null
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== '0000') { index += 1; continue }
    const start = index
    while (index < groups.length && groups[index] === '0000') index += 1
    if (index - start > bestLength) { bestStart = start; bestLength = index - start }
  }
  if (bestLength < 2) return groups.map((group) => group.replace(/^0+(?=[0-9a-f])/, '')).join(':')
  const compressed = []
  if (bestStart > 0) compressed.push(groups.slice(0, bestStart).map((group) => group.replace(/^0+(?=[0-9a-f])/, '')).join(':'))
  compressed.push('')
  if (bestStart + bestLength < groups.length) compressed.push(groups.slice(bestStart + bestLength).map((group) => group.replace(/^0+(?=[0-9a-f])/, '')).join(':'))
  return compressed.join(':').replace(/^:([^:])/, '::$1').replace(/([^:]):$/, '$1::')
}

function canonicalIp(value) {
  if (typeof value !== 'string') return null
  const ip = value.trim()
  const version = isIP(ip)
  if (!version) return null
  if (version === 4 && isPrivateIpv4(ip)) return null
  if (version === 6 && isPrivateIpv6(ip)) return null
  if (version === 6 && ip.toLowerCase().startsWith('::ffff:')) return canonicalIp(ip.slice(7))
  if (version === 6) return canonicalIpv6(ip)
  return ip
}

export function createClientIpAdapter({ mode = 'local', allowCallerHeader = false } = {}) {
  if (mode === 'production' && allowCallerHeader) throw new Error('caller forwarding headers are not trusted')
  if (!['production', 'local', 'test'].includes(mode)) throw new Error('invalid client IP adapter mode')
  return {
    getClientIp(req = {}) {
      if (mode === 'production') {
        const forwarded = req.headers?.['x-forwarded-for'] ?? req.headers?.['X-Forwarded-For']
        if (typeof forwarded !== 'string' || forwarded.includes(',')) return null
        return canonicalIp(forwarded)
      }
      const explicit = mode === 'test' ? req.testClientIp : undefined
      return canonicalIp(explicit ?? req.socket?.remoteAddress) ?? (mode === 'local' ? req.socket?.remoteAddress ?? null : null)
    },
  }
}

export { canonicalIp }
