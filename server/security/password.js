import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt)
const FORMAT = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/
const N = 16_384
const R = 8
const P = 1
const KEY_LENGTH = 64

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 1 || password.length > 128) throw new Error('invalid password')
  const salt = randomBytes(16)
  const derived = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: 32 * 1024 * 1024 })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}:${Buffer.from(derived).toString('base64url')}`
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false
  const match = FORMAT.exec(encoded)
  if (!match) return false
  const [, nText, rText, pText, saltText, hashText] = match
  const n = Number(nText)
  const r = Number(rText)
  const p = Number(pText)
  if (![n, r, p].every(Number.isInteger) || n < 1024 || n > 262_144 || r < 1 || r > 32 || p < 1 || p > 8) return false
  try {
    const salt = Buffer.from(saltText, 'base64url')
    const expected = Buffer.from(hashText, 'base64url')
    if (salt.length < 8 || expected.length !== KEY_LENGTH) return false
    const derived = Buffer.from(await scryptAsync(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 }))
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}
