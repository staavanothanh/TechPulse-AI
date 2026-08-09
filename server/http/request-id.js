import { randomUUID } from 'node:crypto'

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function createRequestId() {
  return randomUUID()
}

export function createRequestIdMiddleware() {
  return (req, res, next) => {
    const candidate = req.get('X-Request-Id')
    const requestId = candidate && REQUEST_ID_PATTERN.test(candidate) ? candidate : createRequestId()
    req.requestId = requestId
    res.set('X-Request-Id', requestId)
    next()
  }
}
