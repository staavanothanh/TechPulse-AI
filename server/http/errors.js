const ERROR_STATUS = new Map([
  ['bad_request', 400],
  ['payload_too_large', 413],
  ['unsupported_media_type', 415],
  ['not_found', 404],
  ['internal_error', 500],
])

export function sendError(res, { status, code, message, details } = {}) {
  const resolvedStatus = status ?? ERROR_STATUS.get(code) ?? 500
  const safeMessage = message || 'Request could not be completed'
  const error = { code: code || 'internal_error', message: safeMessage, requestId: res.getHeader('X-Request-Id') }
  if (details !== undefined) error.details = details
  return res.status(resolvedStatus).json({ error })
}

export function errorHandler(error, req, res, _next) {
  if (res.headersSent) return
  if (error?.type === 'entity.too.large') {
    return sendError(res, { status: 413, code: 'payload_too_large', message: 'Request body is too large' })
  }
  if (error?.type === 'entity.parse.failed' || error?.type === 'strict violation') {
    return sendError(res, { status: 400, code: 'bad_request', message: 'Malformed JSON body' })
  }
  console.error('Unhandled request error', { requestId: req.requestId, code: error?.code })
  return sendError(res, { status: 500, code: 'internal_error', message: 'Internal server error' })
}
