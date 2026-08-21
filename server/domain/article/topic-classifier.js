const TOPIC_ALIASES = Object.freeze({
  'cs.ai': 'ai',
  'cs.cl': 'ai',
  'cs.lg': 'ai',
  'dev ops': 'devops',
  'dev-ops': 'devops',
  data: 'dữ liệu',
  database: 'dữ liệu',
  security: 'bảo mật',
})

const TOPIC_RULES = Object.freeze([
  Object.freeze({
    topic: 'ai',
    patterns: Object.freeze([
      /\bai\b/i,
      /artificial intelligence/i,
      /\b(?:machine|deep) learning\b/i,
      /\b(?:large language model|llm|generative ai|gpt|copilot|inference|embedding)\b/i,
      /\bcs\.(?:ai|cl|lg)\b/i,
    ]),
  }),
  Object.freeze({
    topic: 'javascript',
    patterns: Object.freeze([/\b(?:javascript|typescript|node(?:\.js)?|react|vite|npm)\b/i]),
  }),
  Object.freeze({
    topic: 'blockchain',
    patterns: Object.freeze([
      /\b(?:blockchain|web3|ethereum|bitcoin|smart contract|cryptocurrency)\b/i,
    ]),
  }),
  Object.freeze({
    topic: 'devops',
    patterns: Object.freeze([
      /\bdev[ -]?ops\b/i,
      /\b(?:cloud|kubernetes|k8s|docker|ci\/?cd|continuous integration|deployment|infrastructure|serverless|sre|pipeline)\b/i,
    ]),
  }),
  Object.freeze({
    topic: 'bảo mật',
    patterns: Object.freeze([
      /\b(?:security|secure|vulnerabilit(?:y|ies)|exploit|privacy|authentication|authorization|encryption|malware|supply[ -]?chain|csrf|xss)\b/i,
      /bảo mật|an ninh/i,
    ]),
  }),
  Object.freeze({
    topic: 'dữ liệu',
    patterns: Object.freeze([
      /\b(?:data|database|mongodb|postgres(?:ql)?|sql|analytics|dataset|datasets|vector|retrieval|storage|distributed)\b/i,
      /dữ liệu/i,
    ]),
  }),
])

function normalizeTopic(value) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi')
  return TOPIC_ALIASES[normalized] ?? normalized
}

export function classifyTopics({ values = [], titleOriginal = '', excerptOriginal = '' } = {}) {
  const supplied = (Array.isArray(values) ? values : [values])
    .map(normalizeTopic)
    .filter(Boolean)
  const topics = new Set(supplied)
  const searchableText = [titleOriginal, excerptOriginal, ...supplied]
    .map((value) => String(value ?? ''))
    .join(' ')

  for (const rule of TOPIC_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(searchableText))) topics.add(rule.topic)
  }

  return Object.freeze([...topics].sort((left, right) => left.localeCompare(right, 'vi')))
}

export { TOPIC_RULES }
