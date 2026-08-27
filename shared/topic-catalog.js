export const TOPIC_TAXONOMY_VERSION = 1

export class TopicTaxonomyError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'TopicTaxonomyError'
    this.code = options.code ?? 'topic_taxonomy_error'
    this.status = options.status ?? 422
    if (options.details) this.details = options.details
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) {
      deepFreeze(value[key])
    }
  }
  return value
}

export function normalizeTopicValue(value) {
  if (typeof value !== 'string') return ''
  return value
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('vi')
}

const RAW_CATALOG = [
  // 1. AI & Machine Learning
  {
    id: 'ai-ml',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'AI', en: 'AI', fullVi: 'AI & Machine Learning', fullEn: 'AI & Machine Learning' },
    aliases: ['ai', 'ai-ml', 'machine learning', 'deep learning', 'học máy', 'học sâu', 'cs.ai', 'cs.lg', 'cs.cl', 'cs.ne', 'trí tuệ nhân tạo'],
    keywords: [
      /\bai\b/i,
      /artificial intelligence|trí tuệ nhân tạo/i,
      /\b(?:machine|deep) learning\b/i,
      /học máy|học sâu/i,
      /\b(?:large language model|llm|generative ai|gpt|copilot|inference|embedding)\b/i,
      /\bcs\.(?:ai|cl|lg|ne)\b/i,
    ],
    legacyValues: ['ai'],
    status: 'active',
    displayOrder: 1,
  },
  {
    id: 'machine-learning',
    parentId: 'ai-ml',
    kind: 'leaf',
    labels: { vi: 'Học máy', en: 'Machine Learning' },
    aliases: ['machine learning', 'ml', 'cs.lg'],
    keywords: [/\b(?:machine learning|ml|cs\.lg)\b/i],
    legacyValues: ['ai'],
    status: 'active',
    displayOrder: 11,
  },
  {
    id: 'deep-learning',
    parentId: 'ai-ml',
    kind: 'leaf',
    labels: { vi: 'Học sâu & LLM', en: 'Deep Learning & LLM' },
    aliases: ['deep learning', 'llm', 'generative ai', 'transformer'],
    keywords: [/\b(?:deep learning|llm|gpt|transformer|generative ai)\b/i],
    legacyValues: ['ai'],
    status: 'active',
    displayOrder: 12,
  },

  // 2. AI Agent
  {
    id: 'ai-agent',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'AI Agent', en: 'AI Agent', fullVi: 'AI Agent & Hệ thống tự hành', fullEn: 'AI Agents & Autonomous Systems' },
    aliases: ['ai agent', 'ai-agent', 'agent', 'agents', 'agentic', 'autonomous agent', 'hệ thống tự hành', 'multi-agent', 'tác tử ai'],
    keywords: [
      /\b(?:ai agents?|agentic|autonomous agents?|multi-agent|mcp|tool use|function calling)\b/i,
      /hệ thống tự hành|tác tử ai/i,
    ],
    legacyValues: ['ai'],
    status: 'active',
    displayOrder: 2,
  },
  {
    id: 'agentic-systems',
    parentId: 'ai-agent',
    kind: 'leaf',
    labels: { vi: 'Hệ thống Agentic', en: 'Agentic Systems' },
    aliases: ['agentic systems', 'agentic architecture', 'multi-agent'],
    keywords: [/\b(?:agentic|multi-agent|tool use)\b/i],
    legacyValues: [],
    status: 'active',
    displayOrder: 21,
  },

  // 3. Robotics
  {
    id: 'robotics',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'Robotics', en: 'Robotics', fullVi: 'Robotics & Tự động hóa', fullEn: 'Robotics & Automation' },
    aliases: ['robot', 'robots', 'robotics', 'tự động hóa', 'automation', 'drone', 'cs.ro', 'người máy'],
    keywords: [
      /\b(?:robot|robots|robotics|humanoid|actuator|ros|ros2|kinematics|cs\.ro)\b/i,
      /robot|người máy|tự động hóa/i,
    ],
    legacyValues: ['robot', 'robotics'],
    status: 'active',
    displayOrder: 3,
  },
  {
    id: 'robot-control',
    parentId: 'robotics',
    kind: 'leaf',
    labels: { vi: 'Điều khiển Robot', en: 'Robot Control' },
    aliases: ['robot control', 'ros', 'kinematics'],
    keywords: [/\b(?:ros|ros2|kinematics|motion planning)\b/i],
    legacyValues: [],
    status: 'active',
    displayOrder: 31,
  },

  // 4. Software Engineering
  {
    id: 'software-engineering',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'Software Engineering', en: 'Software Engineering', fullVi: 'Kỹ thuật phần mềm & Lập trình', fullEn: 'Software Engineering & Programming' },
    aliases: ['software engineering', 'software-engineering', 'kỹ thuật phần mềm', 'lập trình', 'programming', 'javascript', 'typescript', 'python', 'golang', 'rust', 'react', 'nodejs', 'cs.se'],
    keywords: [
      /\b(?:software engineering|programming|developer|architecture|javascript|typescript|node(?:\.js)?|react|vite|npm|python|golang|rust|cs\.se)\b/i,
      /kỹ thuật phần mềm|lập trình/i,
    ],
    legacyValues: ['javascript'],
    status: 'active',
    displayOrder: 4,
  },
  {
    id: 'web-development',
    parentId: 'software-engineering',
    kind: 'leaf',
    labels: { vi: 'JavaScript', en: 'JavaScript', fullVi: 'Phát triển Web', fullEn: 'Web Development' },
    aliases: ['web development', 'javascript', 'typescript', 'frontend', 'backend', 'js', 'ts'],
    keywords: [/\b(?:javascript|typescript|react|vue|angular|node(?:\.js)?|html|css)\b/i],
    legacyValues: ['javascript'],
    status: 'active',
    displayOrder: 41,
  },
  {
    id: 'system-architecture',
    parentId: 'software-engineering',
    kind: 'leaf',
    labels: { vi: 'Kiến trúc hệ thống', en: 'System Architecture' },
    aliases: ['system architecture', 'microservices', 'design patterns'],
    keywords: [/\b(?:microservices|system design|design patterns|clean architecture)\b/i],
    legacyValues: [],
    status: 'active',
    displayOrder: 42,
  },

  // 5. DevOps & Cloud
  {
    id: 'devops-cloud',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'DevOps', en: 'DevOps', fullVi: 'DevOps & Điện toán đám mây', fullEn: 'DevOps & Cloud' },
    aliases: ['devops', 'dev ops', 'dev-ops', 'cloud', 'điện toán đám mây', 'kubernetes', 'k8s', 'docker', 'ci/cd', 'ci-cd', 'continuous integration', 'infrastructure', 'serverless', 'sre', 'cs.dc'],
    keywords: [
      /\bdev[ -]?ops\b/i,
      /\b(?:cloud|kubernetes|k8s|docker|ci\/?cd|continuous integration|deployment|infrastructure|serverless|sre|pipeline|aws|gcp|azure|cs\.dc)\b/i,
      /điện toán đám mây/i,
    ],
    legacyValues: ['devops'],
    status: 'active',
    displayOrder: 5,
  },
  {
    id: 'cloud-infrastructure',
    parentId: 'devops-cloud',
    kind: 'leaf',
    labels: { vi: 'Hạ tầng Cloud & SRE', en: 'Cloud Infrastructure & SRE' },
    aliases: ['cloud infrastructure', 'aws', 'gcp', 'azure', 'sre'],
    keywords: [/\b(?:aws|gcp|azure|serverless|sre|terraform)\b/i],
    legacyValues: ['devops'],
    status: 'active',
    displayOrder: 51,
  },
  {
    id: 'containers-orchestration',
    parentId: 'devops-cloud',
    kind: 'leaf',
    labels: { vi: 'Container & Kubernetes', en: 'Containers & Kubernetes' },
    aliases: ['kubernetes', 'docker', 'containers', 'k8s'],
    keywords: [/\b(?:kubernetes|k8s|docker|containers|helm)\b/i],
    legacyValues: ['devops'],
    status: 'active',
    displayOrder: 52,
  },

  // 6. Security
  {
    id: 'security',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'Bảo mật', en: 'Security', fullVi: 'An ninh mạng & Bảo mật', fullEn: 'Security & Cyber' },
    aliases: ['security', 'bảo mật', 'an ninh', 'an ninh mạng', 'cybersecurity', 'infosec', 'vulnerability', 'csrf', 'xss', 'cs.cr'],
    keywords: [
      /\b(?:security|secure|vulnerabilit(?:y|ies)|exploit|privacy|authentication|authorization|encryption|malware|supply[ -]?chain|csrf|xss|cybersecurity|infosec|cs\.cr)\b/i,
      /bảo mật|an ninh/i,
    ],
    legacyValues: ['bảo mật', 'security'],
    status: 'active',
    displayOrder: 6,
  },
  {
    id: 'appsec',
    parentId: 'security',
    kind: 'leaf',
    labels: { vi: 'Bảo mật ứng dụng', en: 'Application Security' },
    aliases: ['appsec', 'web security', 'vulnerabilities'],
    keywords: [/\b(?:appsec|vulnerabilit(?:y|ies)|csrf|xss|sql injection|owasp)\b/i],
    legacyValues: ['bảo mật'],
    status: 'active',
    displayOrder: 61,
  },
  {
    id: 'cryptography',
    parentId: 'security',
    kind: 'leaf',
    labels: { vi: 'Mật mã học & Quyền riêng tư', en: 'Cryptography & Privacy' },
    aliases: ['cryptography', 'crypto', 'privacy', 'encryption'],
    keywords: [/\b(?:cryptography|encryption|zero knowledge|zk-proof|privacy)\b/i],
    legacyValues: ['bảo mật'],
    status: 'active',
    displayOrder: 62,
  },

  // 7. Computer Science & Data
  {
    id: 'computer-science',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'Dữ liệu', en: 'Data', fullVi: 'Khoa học máy tính & Dữ liệu', fullEn: 'Computer Science & Data' },
    aliases: ['computer science', 'computer-science', 'khoa học máy tính', 'cs', 'data', 'database', 'dữ liệu', 'cs.db', 'cs.ds'],
    keywords: [
      /\b(?:computer science|cs|database|mongodb|postgres(?:ql)?|sql|analytics|dataset|datasets|vector|storage|distributed|cơ sở dữ liệu)\b/i,
      /khoa học máy tính|dữ liệu|cơ sở dữ liệu/i,
    ],
    legacyValues: ['dữ liệu', 'data', 'database'],
    status: 'active',
    displayOrder: 7,
  },
  {
    id: 'databases',
    parentId: 'computer-science',
    kind: 'leaf',
    labels: { vi: 'Cơ sở dữ liệu', en: 'Databases' },
    aliases: ['database', 'databases', 'sql', 'nosql', 'mongodb', 'postgres'],
    keywords: [/\b(?:database|databases|mongodb|postgres|mysql|sqlite|redis|sql|nosql)\b/i],
    legacyValues: ['database', 'dữ liệu'],
    status: 'active',
    displayOrder: 71,
  },
  {
    id: 'data-engineering',
    parentId: 'computer-science',
    kind: 'leaf',
    labels: { vi: 'Kỹ nghệ dữ liệu', en: 'Data Engineering' },
    aliases: ['data engineering', 'data-engineering', 'data pipeline', 'etl'],
    keywords: [/\b(?:data engineering|pipeline|etl|analytics|data warehouse|spark|kafka)\b/i],
    legacyValues: ['data'],
    status: 'active',
    displayOrder: 72,
  },

  // 8. Emerging Tech & Web3
  {
    id: 'emerging-it',
    parentId: null,
    kind: 'parent',
    labels: { vi: 'Blockchain', en: 'Blockchain', fullVi: 'Công nghệ mới nổi & Web3', fullEn: 'Emerging Tech & Web3' },
    aliases: ['emerging tech', 'emerging-it', 'công nghệ mới', 'blockchain', 'web3', 'ethereum', 'bitcoin', 'smart contract', 'cryptocurrency', 'quantum computing', 'iot'],
    keywords: [
      /\b(?:blockchain|web3|ethereum|bitcoin|smart contract|cryptocurrency|quantum computing|iot|edge computing)\b/i,
      /công nghệ mới/i,
    ],
    legacyValues: ['blockchain'],
    status: 'active',
    displayOrder: 8,
  },
  {
    id: 'blockchain-web3',
    parentId: 'emerging-it',
    kind: 'leaf',
    labels: { vi: 'Blockchain & Web3', en: 'Blockchain & Web3' },
    aliases: ['blockchain', 'web3', 'crypto', 'smart contracts'],
    keywords: [/\b(?:blockchain|web3|ethereum|bitcoin|smart contract|crypto)\b/i],
    legacyValues: ['blockchain'],
    status: 'active',
    displayOrder: 81,
  },
  {
    id: 'quantum-computing',
    parentId: 'emerging-it',
    kind: 'leaf',
    labels: { vi: 'Điện toán lượng tử', en: 'Quantum Computing' },
    aliases: ['quantum computing', 'quantum'],
    keywords: [/\b(?:quantum computing|qubit|quantum)\b/i],
    legacyValues: [],
    status: 'active',
    displayOrder: 82,
  },
]

export const TOPIC_CATALOG = deepFreeze(RAW_CATALOG)

export const TOPIC_BY_ID = deepFreeze(
  Object.fromEntries(TOPIC_CATALOG.map((item) => [item.id, item])),
)

export const TOPIC_PARENT_DOMAINS = deepFreeze(
  TOPIC_CATALOG.filter((item) => item.kind === 'parent').sort(
    (left, right) => left.displayOrder - right.displayOrder,
  ),
)

// Legacy compatibility aliases map
const LEGACY_ALIASES_MAP = Object.freeze({
  'cs.ai': 'ai',
  'cs.cl': 'ai',
  'cs.lg': 'ai',
  'cs.ne': 'ai',
  'dev ops': 'devops',
  'dev-ops': 'devops',
  data: 'dữ liệu',
  database: 'dữ liệu',
  security: 'bảo mật',
  robot: 'robot',
  robotics: 'robot',
})

// Build alias lookup index with parent priority
const ALIAS_TO_TOPIC_ID = new Map()

function registerAlias(rawKey, targetId) {
  const key = normalizeTopicValue(rawKey)
  if (key && !ALIAS_TO_TOPIC_ID.has(key)) {
    ALIAS_TO_TOPIC_ID.set(key, targetId)
  }
}

// 1st pass: register parent IDs, labels, aliases, legacy values first
for (const item of TOPIC_CATALOG) {
  if (item.kind === 'parent') {
    registerAlias(item.id, item.id)
    if (item.labels?.vi) registerAlias(item.labels.vi, item.id)
    if (item.labels?.en) registerAlias(item.labels.en, item.id)
    if (item.labels?.fullVi) registerAlias(item.labels.fullVi, item.id)
    if (item.labels?.fullEn) registerAlias(item.labels.fullEn, item.id)
    for (const alias of item.aliases ?? []) registerAlias(alias, item.id)
    for (const legacy of item.legacyValues ?? []) registerAlias(legacy, item.id)
  }
}

// 2nd pass: register leaf IDs, labels, aliases
for (const item of TOPIC_CATALOG) {
  if (item.kind === 'leaf') {
    registerAlias(item.id, item.id)
    if (item.labels?.vi) registerAlias(item.labels.vi, item.id)
    if (item.labels?.en) registerAlias(item.labels.en, item.id)
    if (item.labels?.fullVi) registerAlias(item.labels.fullVi, item.id)
    if (item.labels?.fullEn) registerAlias(item.labels.fullEn, item.id)
    for (const alias of item.aliases ?? []) registerAlias(alias, item.id)
    for (const legacy of item.legacyValues ?? []) registerAlias(legacy, item.id)
  }
}

// Child ID index: parentId -> array of child IDs
const CHILDREN_BY_PARENT_ID = new Map()
for (const item of TOPIC_CATALOG) {
  if (item.parentId) {
    const list = CHILDREN_BY_PARENT_ID.get(item.parentId) ?? []
    list.push(item.id)
    CHILDREN_BY_PARENT_ID.set(item.parentId, list)
  }
}

export function resolveTopic(value) {
  const normalized = normalizeTopicValue(value)
  if (!normalized) {
    return Object.freeze({
      input: value,
      normalized: '',
      canonicalId: null,
      match: 'unknown',
    })
  }

  // Exact ID match
  if (TOPIC_BY_ID[normalized]) {
    return Object.freeze({
      input: value,
      normalized,
      canonicalId: normalized,
      match: 'id',
    })
  }

  // Alias or legacy match
  const canonicalId = ALIAS_TO_TOPIC_ID.get(normalized)
  if (canonicalId) {
    return Object.freeze({
      input: value,
      normalized,
      canonicalId,
      match: 'alias',
    })
  }

  // Unknown string
  return Object.freeze({
    input: value,
    normalized,
    canonicalId: null,
    match: 'unknown',
  })
}
export function topicsMatch(left, right) {
  const leftResolved = resolveTopic(left)
  const rightResolved = resolveTopic(right)
  if (leftResolved.canonicalId || rightResolved.canonicalId) {
    return Boolean(leftResolved.canonicalId && leftResolved.canonicalId === rightResolved.canonicalId)
  }
  return Boolean(leftResolved.normalized && leftResolved.normalized === rightResolved.normalized)
}

export function canonicalTopicIds(values, { includeAncestors = true, max = 50 } = {}) {
  if (!Array.isArray(values)) {
    throw new TopicTaxonomyError('Values must be an array', { status: 422 })
  }
  if (values.length > max) {
    throw new TopicTaxonomyError(`Topic count exceeds maximum limit of ${max}`, { status: 422 })
  }

  const ids = new Set()
  for (const val of values) {
    const resolved = resolveTopic(val)
    if (resolved.canonicalId) {
      ids.add(resolved.canonicalId)
      if (includeAncestors) {
        const item = TOPIC_BY_ID[resolved.canonicalId]
        if (item?.parentId) ids.add(item.parentId)
      }
    }
  }

  // Sort deterministically by catalog order
  const orderMap = new Map(TOPIC_CATALOG.map((item, index) => [item.id, index]))
  const sorted = [...ids].sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999))
  return Object.freeze(sorted)
}

export function canonicalPreferenceIds(values, { max = 20 } = {}) {
  if (!Array.isArray(values)) {
    throw new TopicTaxonomyError('Topic preferences must be an array', { status: 422 })
  }
  if (values.length > max) {
    throw new TopicTaxonomyError(`Topic preferences count exceeds maximum limit of ${max}`, { status: 422 })
  }

  const ids = new Set()
  for (const val of values) {
    const resolved = resolveTopic(val)
    if (resolved.canonicalId) {
      ids.add(resolved.canonicalId)
    }
  }

  const orderMap = new Map(TOPIC_CATALOG.map((item, index) => [item.id, index]))
  const sorted = [...ids].sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999))
  return Object.freeze(sorted)
}

export function expandTopicSelection(values, { maxExpanded = 50 } = {}) {
  if (!Array.isArray(values)) {
    throw new TopicTaxonomyError('Topic selection must be an array', { status: 422 })
  }

  const canonicalIds = new Set()
  const legacyValues = new Set()
  const parents = new Set()
  const leaves = new Set()

  for (const val of values) {
    const resolved = resolveTopic(val)
    if (!resolved.canonicalId) {
      if (resolved.normalized) legacyValues.add(resolved.normalized)
      continue
    }

    const item = TOPIC_BY_ID[resolved.canonicalId]
    if (!item) continue

    if (item.kind === 'parent') {
      parents.add(item.id)
      canonicalIds.add(item.id)
      for (const legacy of item.legacyValues ?? []) legacyValues.add(legacy)

      const children = CHILDREN_BY_PARENT_ID.get(item.id) ?? []
      for (const childId of children) {
        canonicalIds.add(childId)
        const child = TOPIC_BY_ID[childId]
        for (const legacy of child?.legacyValues ?? []) legacyValues.add(legacy)
      }
    } else {
      leaves.add(item.id)
      canonicalIds.add(item.id)
      for (const legacy of item.legacyValues ?? []) legacyValues.add(legacy)
    }
  }

  if (canonicalIds.size > maxExpanded) {
    throw new TopicTaxonomyError(`Expanded topic count (${canonicalIds.size}) exceeds limit (${maxExpanded})`, { status: 422 })
  }

  const orderMap = new Map(TOPIC_CATALOG.map((item, index) => [item.id, index]))
  const sortedCanonical = [...canonicalIds].sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999))
  const sortedLegacy = [...legacyValues].sort((a, b) => a.localeCompare(b, 'vi'))

  return Object.freeze({
    canonicalIds: Object.freeze(sortedCanonical),
    legacyValues: Object.freeze(sortedLegacy),
    parents: Object.freeze([...parents].sort()),
    leaves: Object.freeze([...leaves].sort()),
    expansionCount: sortedCanonical.length,
  })
}

export function topicLabel(value, locale = 'vi') {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''

  const resolved = resolveTopic(trimmed)
  if (resolved.canonicalId && TOPIC_BY_ID[resolved.canonicalId]) {
    const item = TOPIC_BY_ID[resolved.canonicalId]
    if (item.labels) {
      return item.labels[locale] || item.labels.vi || item.labels.en || trimmed
    }
  }
  return trimmed
}

export function topicOptions({ kind = 'parent', status = 'active', locale = 'vi' } = {}) {
  const filtered = TOPIC_CATALOG.filter(
    (item) => (!kind || item.kind === kind) && (!status || item.status === status),
  ).sort((a, b) => a.displayOrder - b.displayOrder)

  return Object.freeze(
    filtered.map((item) => item.labels[locale] || item.labels.vi || item.id),
  )
}

export function classifyTopicIds({ values = [], titleOriginal = '', excerptOriginal = '' } = {}) {
  const supplied = (Array.isArray(values) ? values : [values])
    .map(normalizeTopicValue)
    .filter(Boolean)

  const topicIds = new Set()

  // Classify from supplied values
  for (const val of supplied) {
    const resolved = resolveTopic(val)
    if (resolved.canonicalId) {
      topicIds.add(resolved.canonicalId)
      const item = TOPIC_BY_ID[resolved.canonicalId]
      if (item?.parentId) topicIds.add(item.parentId)
    }
  }

  // Classify from text keywords
  const searchableText = [titleOriginal, excerptOriginal, ...supplied].filter(Boolean).join(' ')

  for (const item of TOPIC_CATALOG) {
    if (item.keywords && item.keywords.some((pat) => pat.test(searchableText))) {
      topicIds.add(item.id)
      if (item.parentId) topicIds.add(item.parentId)
    }
  }

  const orderMap = new Map(TOPIC_CATALOG.map((item, index) => [item.id, index]))
  return Object.freeze(
    [...topicIds].sort((a, b) => (orderMap.get(a) ?? 999) - (orderMap.get(b) ?? 999)),
  )
}

export function classifyLegacyTopics({ values = [], titleOriginal = '', excerptOriginal = '' } = {}) {
  const supplied = (Array.isArray(values) ? values : [values])
    .map((val) => {
      const norm = normalizeTopicValue(val)
      return LEGACY_ALIASES_MAP[norm] ?? norm
    })
    .filter(Boolean)

  const topics = new Set(supplied)
  const searchableText = [titleOriginal, excerptOriginal, ...supplied].filter(Boolean).join(' ')

  // 6 Legacy rules matching original regexes
  const legacyRules = [
    {
      topic: 'ai',
      patterns: [
        /\bai\b/i,
        /artificial intelligence/i,
        /\b(?:machine|deep) learning\b/i,
        /\b(?:large language model|llm|generative ai|gpt|copilot|inference|embedding)\b/i,
        /\bcs\.(?:ai|cl|lg)\b/i,
      ],
    },
    {
      topic: 'javascript',
      patterns: [/\b(?:javascript|typescript|node(?:\.js)?|react|vite|npm)\b/i],
    },
    {
      topic: 'blockchain',
      patterns: [/\b(?:blockchain|web3|ethereum|bitcoin|smart contract|cryptocurrency)\b/i],
    },
    {
      topic: 'devops',
      patterns: [
        /\bdev[ -]?ops\b/i,
        /\b(?:cloud|kubernetes|k8s|docker|ci\/?cd|continuous integration|deployment|infrastructure|serverless|sre|pipeline)\b/i,
      ],
    },
    {
      topic: 'bảo mật',
      patterns: [
        /\b(?:security|secure|vulnerabilit(?:y|ies)|exploit|privacy|authentication|authorization|encryption|malware|supply[ -]?chain|csrf|xss)\b/i,
        /bảo mật|an ninh/i,
      ],
    },
    {
      topic: 'dữ liệu',
      patterns: [
        /\b(?:data|database|mongodb|postgres(?:ql)?|sql|analytics|dataset|datasets|vector|retrieval|storage|distributed)\b/i,
        /dữ liệu/i,
      ],
    },
  ]

  for (const rule of legacyRules) {
    if (rule.patterns.some((pattern) => pattern.test(searchableText))) {
      topics.add(rule.topic)
    }
  }

  return Object.freeze([...topics].sort((left, right) => left.localeCompare(right, 'vi')))
}
