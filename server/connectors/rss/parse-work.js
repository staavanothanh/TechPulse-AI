import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { sourcePayloadRejected } from './errors.js'
import { MAX_PARSE_WORK_DELAY_MS } from './parse-limits.js'

const XML_PARSER_OPTIONS = Object.freeze({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
  htmlEntities: false,
})

function fieldCharacterCount(value, limits) {
  if (typeof value !== 'string') return
  if (Array.from(value).length > limits.maxFieldChars) throw sourcePayloadRejected()
}

function localName(name) {
  return String(name).split(':').pop().toLowerCase()
}

function orderedToNodes(ordered, state, depth, limits) {
  if (!Array.isArray(ordered)) throw sourcePayloadRejected()
  if (depth > limits.maxDepth) throw sourcePayloadRejected()
  const nodes = []
  for (const entry of ordered) {
    if (!entry || typeof entry !== 'object') throw sourcePayloadRejected()
    const attributes = entry[':@'] && typeof entry[':@'] === 'object' ? { ...entry[':@'] } : {}
    for (const value of Object.values(attributes)) fieldCharacterCount(String(value), limits)
    for (const [name, value] of Object.entries(entry)) {
      if (name === ':@' || name === '#text' || name.startsWith('?')) continue
      if (name.startsWith('!')) throw sourcePayloadRejected()
      state.nodes += 1
      if (state.nodes > limits.maxNodes) throw sourcePayloadRejected()
      const parts = Array.isArray(value) ? value : []
      const directText = parts
        .filter((part) => part && typeof part === 'object' && Object.prototype.hasOwnProperty.call(part, '#text'))
        .map((part) => String(part['#text'] ?? ''))
        .join('')
      fieldCharacterCount(directText, limits)
      const children = orderedToNodes(parts, state, depth + 1, limits)
      const node = { name, localName: localName(name), attributes, text: directText, children }
      if (node.localName === 'item' || node.localName === 'entry') {
        state.items += 1
        if (state.items > limits.maxItems) throw sourcePayloadRejected()
      }
      nodes.push(node)
    }
  }
  return nodes
}

function blockingDelay(delayMs) {
  if (delayMs === 0) return
  const deadline = Date.now() + delayMs
  while (Date.now() < deadline) continue
}

export function parseXmlDocument(xml, limits, delayMs = 0) {
  if (typeof xml !== 'string' || !limits || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_PARSE_WORK_DELAY_MS) {
    throw sourcePayloadRejected()
  }
  blockingDelay(delayMs)
  let validation
  try {
    validation = XMLValidator.validate(xml, { allowBooleanAttributes: false, unpairedTags: [] })
  } catch {
    throw sourcePayloadRejected()
  }
  if (validation !== true) throw sourcePayloadRejected()
  let ordered
  try {
    const parser = new XMLParser({ ...XML_PARSER_OPTIONS, maxNestedTags: limits.maxDepth })
    ordered = parser.parse(xml)
  } catch {
    throw sourcePayloadRejected()
  }
  return orderedToNodes(ordered, { nodes: 0, items: 0 }, 0, limits)
}
