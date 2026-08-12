import fs from 'node:fs'
import path from 'node:path'

export const OPENAPI_PATH = path.resolve('docs/contracts/openapi.json')

export function loadOpenApi() {
  return JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8'))
}

export function resolveRef(document, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return undefined
  return ref
    .slice(2)
    .split('/')
    .reduce((current, segment) => current?.[segment.replaceAll('~1', '/').replaceAll('~0', '~')], document)
}

export function dereference(document, value) {
  return value?.$ref ? resolveRef(document, value.$ref) : value
}

export function collectOperations(document) {
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])
  const operations = []
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (methods.has(method)) operations.push({ route, method, operation })
    }
  }
  return operations
}

export function operationParameters(document, operationRecord) {
  const pathItem = document.paths[operationRecord.route]
  return [...(pathItem.parameters ?? []), ...(operationRecord.operation.parameters ?? [])].map((value) =>
    dereference(document, value),
  )
}

export function findOperationForRequest(document, method, requestPath) {
  const pathname = requestPath.split('?', 1)[0]
  for (const record of collectOperations(document)) {
    if (record.method.toUpperCase() !== method.toUpperCase()) continue
    const pattern = new RegExp(`^${record.route.replaceAll(/\{[^}]+\}/g, '[^/]+')}$`)
    if (pattern.test(pathname)) return record
  }
  return undefined
}

export function runContractChecks(document) {
  const operations = collectOperations(document)
  const failures = []
  const operationIds = operations.map(({ operation }) => operation.operationId)
  const duplicateIds = operationIds.filter((id, index) => operationIds.indexOf(id) !== index)

  if (document.openapi !== '3.1.0') failures.push('openapi must be 3.1.0')
  if (operations.length !== 55) failures.push(`expected 55 operations, found ${operations.length}`)
  if (operationIds.some((id) => typeof id !== 'string' || id.length === 0)) failures.push('every operation needs operationId')
  if (duplicateIds.length > 0) failures.push(`duplicate operationId: ${[...new Set(duplicateIds)].join(', ')}`)

  const refs = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (typeof value.$ref === 'string') refs.push(value.$ref)
    Object.values(value).forEach(visit)
  }
  visit(document)
  const remoteRefs = refs.filter((ref) => !ref.startsWith('#/'))
  const unresolvedRefs = refs.filter((ref) => ref.startsWith('#/') && !resolveRef(document, ref))
  if (remoteRefs.length > 0) failures.push(`remote refs are forbidden: ${remoteRefs.join(', ')}`)
  if (unresolvedRefs.length > 0) failures.push(`unresolved refs: ${[...new Set(unresolvedRefs)].join(', ')}`)

  for (const record of operations) {
    const persistence = record.operation['x-persistence']
    if (!['none', 'mongo'].includes(persistence)) {
      failures.push(`${record.operation.operationId} must declare x-persistence none|mongo`)
    }
    const hasJsonBody = Boolean(record.operation.requestBody?.content?.['application/json'])
    if (hasJsonBody) {
      for (const status of ['400', '413', '415']) {
        if (!record.operation.responses?.[status]) failures.push(`${record.operation.operationId} missing ${status}`)
      }
    }
    if (persistence === 'mongo' && !record.operation.responses?.['503']) {
      failures.push(`${record.operation.operationId} missing 503 for mongo persistence`)
    }
  }

  return { operations, failures, remoteRefs, unresolvedRefs }
}
