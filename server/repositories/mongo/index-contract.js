const INDEX_METADATA_FIELDS = new Set(['name', 'key', 'v', 'ns'])

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function normalizeOption(value) {
  if (value === undefined || value === null || value === false) return undefined
  if (value && typeof value === 'object' && value.locale === 'simple' && Object.keys(value).length === 1) return undefined
  return value
}

export function exactMongoIndex(actual, expected) {
  if (!actual || stableJson(actual.key) !== stableJson(expected.key)) return false
  const optionNames = new Set([
    ...Object.keys(actual).filter((name) => !INDEX_METADATA_FIELDS.has(name)),
    ...Object.keys(expected.options ?? {}),
  ])
  for (const option of optionNames) {
    if (stableJson(normalizeOption(actual[option])) !== stableJson(normalizeOption(expected.options?.[option]))) return false
  }
  return true
}
