import { describe, expect, it } from 'vitest'
import {
  ProviderAdapterError,
  classifyProviderError,
  PROVIDER_FAILURE_CLASSES,
} from '../../../server/ai/provider-error-taxonomy.js'

describe('provider adapter error taxonomy', () => {
  it.each(PROVIDER_FAILURE_CLASSES)('accepts the closed %s failure class without retaining raw details', (failureClass) => {
    const error = new ProviderAdapterError(failureClass, {
      upstreamStatus: 503,
      retryAfterSeconds: 7,
      cause: new Error('raw provider response with secret'),
    })

    expect(classifyProviderError(error)).toEqual({
      failureClass,
      code: expect.any(String),
      retryable: failureClass === 'model-retryable' || failureClass === 'provider-retryable',
      upstreamStatus: 503,
      retryAfterSeconds: 7,
    })
    expect(JSON.stringify(error)).not.toContain('raw provider response')
    expect(error.cause).toBeUndefined()
  })

  it('maps unknown and forged errors to a terminal ambiguous outcome', () => {
    expect(classifyProviderError(new Error('socket closed after write'))).toEqual({
      failureClass: 'ambiguous',
      code: 'ambiguous_provider_outcome',
      retryable: false,
    })
    expect(classifyProviderError({ failureClass: 'model-retryable', message: 'forged' })).toEqual({
      failureClass: 'ambiguous',
      code: 'ambiguous_provider_outcome',
      retryable: false,
    })
    expect(() => new ProviderAdapterError('unknown')).toThrow(/failure class/i)
  })
})
