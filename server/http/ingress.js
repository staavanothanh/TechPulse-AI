import { timingSafeEqual } from 'node:crypto'
import { URL } from 'node:url'
import { loadOpenApi, findOperationForRequest, dereference, operationParameters } from '../../scripts/contracts/openapi-utils.js'
import { sendError } from './errors.js'

const OPENAPI = loadOpenApi()
const MAX_TARGET_BYTES = 8 * 1024
const MAX_JSON_BYTES = 64 * 1024
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const COOKIE_AUTH_EXEMPT = new Set(['registerUser', 'login'])

function normalizedOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    const port = url.port || (url.protocol === 'https:' ? '443' : '80')
    return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`
  } catch {
    return undefined
  }
}

export function isExactOriginAllowed(origin, allowedOrigins) {
  const normalized = normalizedOrigin(origin)
  if (!normalized) return false
  return allowedOrigins.some((candidate) => normalizedOrigin(candidate) === normalized)
}

function allowedOrigins(options) {
  const configured = options.allowedOrigins ?? process.env.PUBLIC_APP_ORIGINS ?? 'http://localhost:3000'
  return configured.split(',').map((value) => value.trim()).filter(Boolean)
}

function reject(res, status, code, message) {
  return sendError(res, { status, code, message })
}

function routeHasJsonBody(operation) {
  return Boolean(operation?.requestBody?.content?.['application/json'])
}

function requiresCookieAuth(operation) {
  if (!operation) return false
  if (Array.isArray(operation.security)) {
    return operation.security.some((scheme) => Object.hasOwn(scheme, 'cookieAuth'))
  }
  return true
}

function requiresMachineAuth(operation) {
  return Array.isArray(operation?.security) && operation.security.some((requirement) => Object.hasOwn(requirement, 'cronBearer'))
}

function configuredMachineSecret(options) {
  if (typeof options.machineSecret === 'string') return options.machineSecret
  const envName = options.machineSecretEnv ?? process.env.INTERNAL_MACHINE_SECRET_ENV
  return envName ? process.env[envName] : undefined
}

function validateMachineAuth(req, operation, options, res) {
  if (!requiresMachineAuth(operation)) return undefined
  const expectedSecret = configuredMachineSecret(options)
  if (typeof expectedSecret !== 'string' || expectedSecret.length === 0) {
    return reject(res, 503, 'service_unavailable', 'Machine authentication is not configured')
  }
  const authorization = req.get('Authorization') ?? ''
  if (!authorization.startsWith('Bearer ')) return reject(res, 401, 'unauthorized', 'Machine authentication is required')
  const receivedSecret = Buffer.from(authorization.slice('Bearer '.length))
  const expected = Buffer.from(expectedSecret)
  if (receivedSecret.length !== expected.length || !timingSafeEqual(receivedSecret, expected)) {
    return reject(res, 401, 'unauthorized', 'Machine authentication is invalid')
  }
  return undefined
}

function schemaMaxLength(document, parameter) {
  const schema = dereference(document, parameter.schema)
  return Number.isInteger(schema?.maxLength) ? schema.maxLength : undefined
}

function schemaForParameter(document, parameter) {
  return dereference(document, parameter.schema) ?? {}
}

function validateQuery(req, operationRecord, res) {
  const parsed = new URL(req.originalUrl || req.url, 'http://localhost')
  const parameters = operationRecord ? operationParameters(OPENAPI, operationRecord) : []
  const allowed = new Map(parameters.filter((parameter) => parameter?.in === 'query').map((parameter) => [parameter.name, parameter]))
  for (const [name, value] of parsed.searchParams.entries()) {
    if (name.includes('$') || name.includes('.') || name.includes('[') || name.includes(']') || !allowed.has(name)) {
      return reject(res, 400, 'bad_request', 'Unsupported query parameter')
    }
    const parameter = allowed.get(name)
    if (!parameter.allowEmptyValue && value === '') return reject(res, 400, 'bad_request', 'Empty query parameter')
    const parameterSchema = dereference(OPENAPI, parameter.schema)
    if (parsed.searchParams.getAll(name).length > 1 && parameterSchema?.type !== 'array') {
      return reject(res, 400, 'bad_request', 'Duplicate scalar query parameter')
    }
    const maxLength = schemaMaxLength(OPENAPI, parameter)
    if (maxLength && value.length > maxLength) return reject(res, 400, 'bad_request', 'Query parameter is too long')
  }
}

function validatePathParameters(req, operationRecord, res) {
  if (!operationRecord) return
  const pathname = (req.originalUrl || req.url).split('?', 1)[0]
  const routeParts = operationRecord.route.split('/')
  const pathParts = pathname.split('/')
  const parameters = operationParameters(OPENAPI, operationRecord)
  const pathParameters = new Map(parameters.filter((parameter) => parameter?.in === 'path').map((parameter) => [parameter.name, parameter]))
  for (let index = 0; index < routeParts.length; index += 1) {
    const match = routeParts[index].match(/^\{([^}]+)\}$/)
    if (!match) continue
    const parameter = pathParameters.get(match[1])
    if (!parameter) return reject(res, 400, 'bad_request', 'Path parameter is not documented')
    let value
    try {
      value = decodeURIComponent(pathParts[index] ?? '')
    } catch {
      return reject(res, 400, 'bad_request', 'Malformed path parameter')
    }
    const schema = schemaForParameter(OPENAPI, parameter)
    const maxLength = schemaMaxLength(OPENAPI, parameter)
    const minLength = Number.isInteger(schema.minLength) ? schema.minLength : undefined
    let matchesPattern = true
    if (typeof schema.pattern === 'string') {
      try {
        matchesPattern = new RegExp(schema.pattern).test(value)
      } catch {
        matchesPattern = false
      }
    }
    const matchesEnum = !Array.isArray(schema.enum) || schema.enum.includes(value)
    if (
      value.includes('/') ||
      value.includes('\u0000') ||
      (maxLength !== undefined && value.length > maxLength) ||
      (minLength !== undefined && value.length < minLength) ||
      !matchesPattern ||
      !matchesEnum
    ) {
      return reject(res, 400, 'bad_request', 'Path parameter is invalid')
    }
  }
}

export function validateRequestTarget(target) {
  return typeof target === 'string' && Buffer.byteLength(target, 'utf8') <= MAX_TARGET_BYTES
}

export function createIngressMiddleware(options = {}) {
  return (req, res, next) => {
    if (!validateRequestTarget(req.originalUrl || req.url)) return reject(res, 413, 'payload_too_large', 'Request target is too large')
    const operation = findOperationForRequest(OPENAPI, req.method, req.originalUrl || req.url)
    const isApi = req.path.startsWith('/api/')
    const isMutation = MUTATING_METHODS.has(req.method)
    const hasBody = req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined

    if (isApi && isMutation) {
      if (!isExactOriginAllowed(req.get('Origin'), allowedOrigins(options))) return reject(res, 403, 'forbidden', 'Origin is not allowed')
      if (requiresCookieAuth(operation?.operation) && !COOKIE_AUTH_EXEMPT.has(operation?.operation?.operationId)) {
        if (!req.get('X-CSRF-Token')) return reject(res, 403, 'csrf_invalid', 'CSRF token is required')
      }
    }

    if (hasBody && req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') {
      return reject(res, 415, 'unsupported_media_type', 'Compressed request bodies are not supported')
    }
    if (hasBody && isApi) {
      const contentType = req.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') return reject(res, 415, 'unsupported_media_type', 'application/json is required')
    }
    if (hasBody && operation && routeHasJsonBody(operation.operation)) {
      const declaredLength = Number(req.get('Content-Length'))
      if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) return reject(res, 413, 'payload_too_large', 'Request body is too large')
    }

    const queryResult = validateQuery(req, operation, res)
    if (queryResult) return queryResult
    const pathResult = validatePathParameters(req, operation, res)
    if (pathResult) return pathResult
    const machineAuthResult = validateMachineAuth(req, operation?.operation, options, res)
    if (machineAuthResult) return machineAuthResult
    return next()
  }
}

export const INGRESS_LIMITS = Object.freeze({ maxTargetBytes: MAX_TARGET_BYTES, maxJsonBytes: MAX_JSON_BYTES })
