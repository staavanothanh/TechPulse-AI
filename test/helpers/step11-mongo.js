import { ObjectId } from 'mongodb'

function clone(value) {
  if (value instanceof ObjectId) return new ObjectId(value)
  if (value instanceof Date) return new Date(value)
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, clone(nested)]))
  return value
}

function equal(left, right) {
  if (left instanceof ObjectId || right instanceof ObjectId) return String(left) === String(right)
  if (left instanceof Date || right instanceof Date) return new Date(left).getTime() === new Date(right).getTime()
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equal(value, right[index]))
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  }
  return left === right
}

function valuesAt(value, path) {
  if (path === '') return [value]
  const parts = path.split('.')
  if (parts.length === 0) return [value]
  if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item, path))
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, parts[0])) return []
  return valuesAt(value[parts[0]], parts.slice(1).join('.'))
}

function compare(left, right) {
  const lhs = left instanceof Date ? left.getTime() : left instanceof ObjectId ? left.toHexString() : left
  const rhs = right instanceof Date ? right.getTime() : right instanceof ObjectId ? right.toHexString() : right
  if (lhs === rhs) return 0
  return lhs < rhs ? -1 : 1
}

function conditionMatches(values, condition) {
  if (condition && typeof condition === 'object' && !(condition instanceof Date) && !(condition instanceof ObjectId) && !Array.isArray(condition)) {
    for (const [operator, expected] of Object.entries(condition)) {
      if (operator === '$in' && !values.some((value) => expected.some((candidate) => Array.isArray(value) ? value.some((item) => equal(item, candidate)) : equal(value, candidate)))) return false
      if (operator === '$nin' && values.some((value) => expected.some((candidate) => Array.isArray(value) ? value.some((item) => equal(item, candidate)) : equal(value, candidate)))) return false
      if (operator === '$exists' && (values.length > 0) !== Boolean(expected)) return false
      if (operator === '$ne' && values.some((value) => Array.isArray(value) ? value.some((item) => equal(item, expected)) : equal(value, expected))) return false
      if (operator === '$lt' && !values.some((value) => compare(value, expected) < 0)) return false
      if (operator === '$lte' && !values.some((value) => compare(value, expected) <= 0)) return false
      if (operator === '$gt' && !values.some((value) => compare(value, expected) > 0)) return false
      if (operator === '$gte' && !values.some((value) => compare(value, expected) >= 0)) return false
      if (operator === '$elemMatch' && !values.some((value) => Array.isArray(value) && value.some((item) => matches(item, expected)))) return false
      if (operator === '$all' && !values.some((value) => Array.isArray(value) && expected.every((candidate) => value.some((item) => equal(item, candidate))))) return false
    }
    return true
  }
  return values.some((value) => Array.isArray(value) ? equal(value, condition) || value.some((item) => equal(item, condition)) : equal(value, condition))
}

function matches(document, filter = {}) {
  return Object.entries(filter).every(([path, condition]) => {
    if (path === '$or') return condition.some((branch) => matches(document, branch))
    if (path === '$and') return condition.every((branch) => matches(document, branch))
    if (path === '$nor') return condition.every((branch) => !matches(document, branch))
    return conditionMatches(valuesAt(document, path), condition)
  })
}

function setPath(document, path, value) {
  const parts = path.split('.')
  const last = parts.pop()
  let cursor = document
  for (const part of parts) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {}
    cursor = cursor[part]
  }
  cursor[last] = clone(value)
}

function unsetPath(document, path) {
  const parts = path.split('.')
  const last = parts.pop()
  let cursor = document
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object') return
    cursor = cursor[part]
  }
  if (cursor && typeof cursor === 'object') delete cursor[last]
}

function applyUpdate(document, update) {
  if (!Object.keys(update).some((key) => key.startsWith('$'))) return clone(update)
  for (const [path, value] of Object.entries(update.$set ?? {})) setPath(document, path, value)
  for (const path of Object.keys(update.$unset ?? {})) unsetPath(document, path)
  for (const [path, value] of Object.entries(update.$inc ?? {})) setPath(document, path, Number(valuesAt(document, path)[0] ?? 0) + Number(value))
  for (const [path, value] of Object.entries(update.$push ?? {})) {
    const current = valuesAt(document, path)[0]
    const items = value && typeof value === 'object' && Array.isArray(value.$each) ? value.$each : [value]
    setPath(document, path, [...(Array.isArray(current) ? current : []), ...items.map(clone)])
  }
  return document
}

function project(document, projection) {
  if (!projection) return clone(document)
  const included = Object.entries(projection).filter(([, value]) => value === 1).map(([path]) => path)
  if (included.length === 0) return clone(document)
  const result = {}
  for (const path of included) {
    const value = valuesAt(document, path)[0]
    if (value !== undefined) setPath(result, path, value)
  }
  if (projection._id !== 0 && document._id !== undefined) result._id = clone(document._id)
  return result
}

class Cursor {
  constructor(database, collectionName, rows) { this.database = database; this.collectionName = collectionName; this.rows = rows; this.maximum = null }
  hint(value) { this.database.hints.push({ collection: this.collectionName, hint: value }); return this }
  sort(spec = {}) {
    const entries = Object.entries(spec)
    this.rows.sort((left, right) => {
      for (const [path, direction] of entries) {
        const result = compare(valuesAt(left, path)[0], valuesAt(right, path)[0])
        if (result !== 0) return result * Number(direction)
      }
      return 0
    })
    return this
  }
  limit(value) { this.maximum = Number(value); return this }
  project(projection) { this.rows = this.rows.map((row) => project(row, projection)); return this }
  async toArray() { return this.rows.slice(0, this.maximum ?? this.rows.length).map(clone) }
  async next() { return (await this.toArray())[0] ?? null }
}

class MemoryCollection {
  constructor(database, name) { this.database = database; this.name = name }
  get rows() { return this.database.collections.get(this.name) ?? [] }
  set rows(value) { this.database.collections.set(this.name, value) }
  find(filter = {}, options = {}) { return new Cursor(this.database, this.name, this.rows.filter((row) => matches(row, filter)).map((row) => project(row, options.projection))) }
  async findOne(filter = {}, options = {}) { const row = this.rows.find((candidate) => matches(candidate, filter)); return row ? project(row, options.projection) : null }
  async insertOne(document) { this.rows.push(clone(document)); return { insertedId: document._id } }
  async updateOne(filter, update) {
    const index = this.rows.findIndex((row) => matches(row, filter))
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 }
    this.rows[index] = applyUpdate(this.rows[index], update)
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async updateMany(filter, update) {
    let matchedCount = 0
    this.rows = this.rows.map((row) => {
      if (!matches(row, filter)) return row
      matchedCount += 1
      return applyUpdate(row, update)
    })
    return { matchedCount, modifiedCount: matchedCount }
  }
  async findOneAndUpdate(filter, update, _options = {}) {
    const index = this.rows.findIndex((row) => matches(row, filter))
    if (index < 0) return null
    this.rows[index] = applyUpdate(this.rows[index], update)
    return clone(this.rows[index])
  }
  async replaceOne(filter, replacement) {
    const index = this.rows.findIndex((row) => matches(row, filter))
    if (index < 0) return { matchedCount: 0, modifiedCount: 0 }
    this.rows[index] = clone(replacement)
    return { matchedCount: 1, modifiedCount: 1 }
  }
  async deleteMany(filter) {
    const before = this.rows.length
    this.rows = this.rows.filter((row) => !matches(row, filter))
    return { deletedCount: before - this.rows.length }
  }
  async deleteOne(filter) { return this.deleteMany(filter) }
  async countDocuments(filter = {}) { return this.rows.filter((row) => matches(row, filter)).length }
}

class MemoryDatabase {
  constructor(initial = {}) { this.collections = new Map(Object.entries(initial).map(([name, rows]) => [name, rows.map(clone)])); this.handles = new Map(); this.hints = [] }
  collection(name) { if (!this.collections.has(name)) this.collections.set(name, []); if (!this.handles.has(name)) this.handles.set(name, new MemoryCollection(this, name)); return this.handles.get(name) }
}

export function createStep11Mongo({ app = {}, governance = {} } = {}) {
  const db = new MemoryDatabase(app)
  const governanceDb = new MemoryDatabase(governance)
  const databases = [db, governanceDb]
  const client = {
    startSession() {
      return {
        async withTransaction(work) {
          const snapshots = databases.map((database) => new Map([...database.collections.entries()].map(([name, rows]) => [name, rows.map(clone)])))
          try { return await work(this) } catch (error) {
            databases.forEach((database, index) => { database.collections = new Map([...snapshots[index].entries()].map(([name, rows]) => [name, rows.map(clone)])) })
            throw error
          }
        },
        async endSession() {},
      }
    },
  }
  return { db, governanceDb, client }
}

export { clone, matches }
