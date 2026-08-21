const ENTITY_VALUES = Object.freeze({
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
  nbsp: '\u00a0',
  iexcl: '\u00a1',
  cent: '\u00a2',
  pound: '\u00a3',
  curren: '\u00a4',
  yen: '\u00a5',
  brvbar: '\u00a6',
  sect: '\u00a7',
  copy: '\u00a9',
  ordf: '\u00aa',
  laquo: '\u00ab',
  not: '\u00ac',
  reg: '\u00ae',
  macr: '\u00af',
  deg: '\u00b0',
  plusmn: '\u00b1',
  sup2: '\u00b2',
  sup3: '\u00b3',
  acute: '\u00b4',
  micro: '\u00b5',
  para: '\u00b6',
  middot: '\u00b7',
  cedil: '\u00b8',
  sup1: '\u00b9',
  ordm: '\u00ba',
  raquo: '\u00bb',
  frac14: '\u00bc',
  frac12: '\u00bd',
  frac34: '\u00be',
  iquest: '\u00bf',
  times: '\u00d7',
  divide: '\u00f7',
  ndash: '\u2013',
  mdash: '\u2014',
  lsquo: '\u2018',
  rsquo: '\u2019',
  sbquo: '\u201a',
  ldquo: '\u201c',
  rdquo: '\u201d',
  bdquo: '\u201e',
  dagger: '\u2020',
  bull: '\u2022',
  hellip: '\u2026',
  permil: '\u2030',
  prime: '\u2032',
  lsaquo: '\u2039',
  rsaquo: '\u203a',
  euro: '\u20ac',
  trade: '\u2122',
  minus: '\u2212',
  le: '\u2264',
  ge: '\u2265',
  ne: '\u2260',
  rarr: '\u2192',
  larr: '\u2190',
  uarr: '\u2191',
  darr: '\u2193',
})

export const SAFE_ENTITY_NAMES = new Set(Object.keys(ENTITY_VALUES).map((name) => name.toLowerCase()))

export function decodeSafeEntities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/gi, (match, entity) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) {
      const point = Number.parseInt(key.slice(2), 16)
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    }
    if (key.startsWith('#')) {
      const point = Number.parseInt(key.slice(1), 10)
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match
    }
    return Object.prototype.hasOwnProperty.call(ENTITY_VALUES, key) ? ENTITY_VALUES[key] : match
  })
}
