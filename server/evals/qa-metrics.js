function normalized(value) {
  return String(value ?? '').normalize('NFD').replaceAll(/[\u0300-\u036f]/g, '').replaceAll(/đ/gi, 'd').toLocaleLowerCase('vi')
}

function answerValue(result) {
  return result?.answer ?? result ?? {}
}

function answerText(answer) {
  return (answer?.paragraphs ?? []).map(({ text }) => String(text ?? '')).join(' ')
}

export function answerMetrics({ item, result } = {}) {
  const answer = answerValue(result)
  const expectedRefusal = item.expected !== 'answered'
  const actualRefusal = answer.status === 'refused'
  const refusalAccuracy = item.expected === 'answered'
    ? (actualRefusal ? 0 : 1)
    : (actualRefusal && answer.refusalReason === item.expected ? 1 : 0)
  const expectedClaims = Array.isArray(item.adjudication?.claims) ? item.adjudication.claims.filter((claim) => claim.supported !== false).map((claim) => claim.text) : Array.isArray(item.expectedClaims) ? item.expectedClaims : []
  const text = normalized(answerText(answer))
  const coveredClaims = expectedClaims.filter((claim) => text.includes(normalized(claim)))
  const claimCoverage = expectedClaims.length === 0 ? (expectedRefusal ? 1 : actualRefusal ? 0 : 1) : coveredClaims.length / expectedClaims.length
  const supportedClaimTexts = new Set((item.adjudication?.claims ?? []).filter((claim) => claim.supported !== false).map((claim) => normalized(claim.text)))
  const outputParagraphs = Array.isArray(answer.paragraphs) ? answer.paragraphs : []
  const unsupportedParagraphs = outputParagraphs.filter((paragraph) => {
    const output = normalized(paragraph?.text)
    return output.length > 0 && supportedClaimTexts.size > 0 && ![...supportedClaimTexts].some((claim) => output.includes(claim))
  }).length
  const unsupportedClaimRate = outputParagraphs.length > 0 ? unsupportedParagraphs / outputParagraphs.length : 0
  const usedCitationIds = new Set((answer.paragraphs ?? []).flatMap(({ citationIds }) => Array.isArray(citationIds) ? citationIds : []))
  const expectedCitationIds = new Set(Array.isArray(item.adjudication?.citations) ? item.adjudication.citations.filter((citation) => citation.label === 'relevant').map((citation) => citation.id) : item.expectedCitationIds ?? [])
  const validUsed = [...usedCitationIds].filter((id) => expectedCitationIds.has(id)).length
  const citationPrecision = usedCitationIds.size === 0 ? (actualRefusal ? 1 : 0) : validUsed / usedCitationIds.size
  const contextPrecision = citationPrecision
  const contextRecall = expectedCitationIds.size === 0 ? (actualRefusal ? 1 : 0) : validUsed / expectedCitationIds.size
  const faithfulness = actualRefusal ? 1 : citationPrecision * (unsupportedClaimRate === 0 ? 1 : 0)
  const expectedSatisfied = item.expected === 'answered'
    ? answer.status === 'answered'
    : actualRefusal && answer.refusalReason === item.expected
  const passed = expectedSatisfied && refusalAccuracy === 1 && claimCoverage >= 0.9 && unsupportedClaimRate <= 0.05 && faithfulness >= 0.9 && contextPrecision >= 0.9 && contextRecall >= 0.9
  return Object.freeze({ id: item.id, expected: item.expected, actual: actualRefusal ? (answer.refusalReason ?? 'refused') : answer.status, passed, refusalAccuracy, claimCoverage, unsupportedClaimRate, citationPrecision, faithfulness, contextPrecision, contextRecall })
}

export function aggregateAnswerMetrics(details = []) {
  const total = details.length
  const mean = (key) => total === 0 ? 0 : details.reduce((sum, item) => sum + Number(item[key] ?? 0), 0) / total
  return Object.freeze({
    refusalAccuracy: mean('refusalAccuracy'),
    claimCoverage: mean('claimCoverage'),
    unsupportedClaimRate: mean('unsupportedClaimRate'),
    citationPrecision: mean('citationPrecision'),
    faithfulness: mean('faithfulness'),
    contextPrecision: mean('contextPrecision'),
    contextRecall: mean('contextRecall'),
  })
}
