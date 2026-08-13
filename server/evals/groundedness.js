import { detectSensitiveInput } from '../domain/qa/privacy.js'
import { buildGroundedPrompt } from '../domain/qa/evidence.js'
import { STEP10_EVAL_CASES, STEP10_EVAL_VERSION } from '../../test/fixtures/qa/step10-eval-fixture.js'

export function runGroundednessEvaluation({ cases = STEP10_EVAL_CASES } = {}) {
  const details = cases.map((item) => {
    let actual = 'answered'
    try {
      if (detectSensitiveInput(item.question)) actual = 'sensitive-input'
      else {
        const built = buildGroundedPrompt({ question: item.question, evidence: item.evidence })
        if (!built.prompt.includes('<evidence-block') || built.prompt.includes('https://')) actual = 'prompt-boundary-failed'
      }
    } catch (error) {
      actual = error.code === 'insufficient-evidence' ? 'insufficient-evidence' : 'evaluation-error'
    }
    return Object.freeze({ id: item.id, expected: item.expected, actual, passed: actual === item.expected })
  })
  const passedCases = details.filter(({ passed }) => passed).length
  return Object.freeze({ version: STEP10_EVAL_VERSION, total: details.length, passedCases, passRate: passedCases / details.length, passed: passedCases === details.length, details: Object.freeze(details) })
}
