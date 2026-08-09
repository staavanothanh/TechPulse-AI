import { describe, expect, it } from 'vitest'
import { errorHandler, sendError } from '../../server/http/errors.js'

function responseDouble() {
  return {
    headersSent: false,
    statusCode: undefined,
    payload: undefined,
    getHeader: () => 'request-1',
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    },
  }
}

describe('canonical error envelope', () => {
  it('maps parser and size errors without exposing internals', () => {
    const oversized = responseDouble()
    errorHandler({ type: 'entity.too.large' }, { requestId: 'r1' }, oversized, () => {})
    expect(oversized.statusCode).toBe(413)
    expect(oversized.payload.error.code).toBe('payload_too_large')

    const malformed = responseDouble()
    errorHandler({ type: 'entity.parse.failed' }, { requestId: 'r2' }, malformed, () => {})
    expect(malformed.statusCode).toBe(400)
    expect(malformed.payload.error.message).toBe('Malformed JSON body')
  })

  it('maps unknown errors and does not write after headers are sent', () => {
    const unknown = responseDouble()
    errorHandler(new Error('secret detail'), { requestId: 'r3' }, unknown, () => {})
    expect(unknown.statusCode).toBe(500)
    expect(unknown.payload.error.message).toBe('Internal server error')

    const sent = responseDouble()
    sent.headersSent = true
    expect(errorHandler(new Error('ignored'), { requestId: 'r4' }, sent, () => {})).toBeUndefined()
  })

  it('keeps request id in the envelope and applies default status', () => {
    const response = responseDouble()
    sendError(response, { code: 'unknown_code', message: 'safe' })
    expect(response.statusCode).toBe(500)
    expect(response.payload.error.requestId).toBe('request-1')
  })
})
