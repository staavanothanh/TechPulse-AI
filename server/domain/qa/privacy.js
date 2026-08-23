import { containsSensitiveProviderInput } from '../../ai/policy-input.js'

export class PrivacyAdmissionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PrivacyAdmissionError'
    this.code = code
    this.status = code === 'sensitive-input' ? 422 : 503
  }
}

export function detectSensitiveInput(value) {
  return typeof value === 'string' && containsSensitiveProviderInput(value)
}

export function admitQuestion(question, { capability } = {}) {
  if (typeof question !== 'string' || question.trim().length < 3 || Array.from(question).length > 1000) {
    throw new PrivacyAdmissionError('validation_error', 'Question is invalid')
  }
  if (detectSensitiveInput(question)) throw new PrivacyAdmissionError('sensitive-input', 'Question cannot be processed safely')
  if (!['zdr-verified', 'nonconfidential'].includes(capability)) throw new PrivacyAdmissionError('provider-unavailable', 'Current AI provider route is unavailable')
  return Object.freeze({ question: question.trim(), capability })
}
