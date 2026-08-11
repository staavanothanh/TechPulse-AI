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

function materializedTextKey(key) {
  const entries = Object.entries(key ?? {})
  if (!entries.some(([, direction]) => direction === 'text')) return key
  const stored = {}
  let textMarkerAdded = false
  for (const [name, direction] of entries) {
    if (direction !== 'text') stored[name] = direction
    else if (!textMarkerAdded) {
      stored._fts = 'text'
      stored._ftsx = 1
      textMarkerAdded = true
    }
  }
  return stored
}

function expectedIndexOption(expected, option) {
  const textFields = Object.entries(expected.key ?? {}).filter(([, direction]) => direction === 'text').map(([name]) => name)
  if (textFields.length === 0) return expected.options?.[option]
  if (option === 'weights') return expected.options?.weights ?? Object.fromEntries(textFields.map((name) => [name, 1]))
  if (option === 'default_language') return expected.options?.default_language ?? 'english'
  if (option === 'language_override') return expected.options?.language_override ?? 'language'
  if (option === 'textIndexVersion') return expected.options?.textIndexVersion ?? 3
  return expected.options?.[option]
}

export function exactMongoIndex(actual, expected) {
  if (!actual || stableJson(actual.key) !== stableJson(materializedTextKey(expected.key))) return false
  const optionNames = new Set([
    ...Object.keys(actual).filter((name) => !INDEX_METADATA_FIELDS.has(name)),
    ...Object.keys(expected.options ?? {}),
  ])
  for (const option of optionNames) {
    if (stableJson(normalizeOption(actual[option])) !== stableJson(normalizeOption(expectedIndexOption(expected, option)))) return false
  }
  return true
}
