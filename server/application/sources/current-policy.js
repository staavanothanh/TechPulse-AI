import { evaluateContentPolicy } from '../../domain/policy/content-policy.js'
import { evaluateMediaPolicy } from '../../domain/policy/media-policy.js'

function unavailable(purpose) {
  return { allowed: false, code: 'source_policy_unavailable', ...(purpose ? { purpose } : {}), policyVersion: null }
}

export function createCurrentSourcePolicy({ repository } = {}) {
  async function load(sourceId) {
    if (!repository?.findSourceById) return null
    try { return await repository.findSourceById(sourceId) } catch { return null }
  }
  return Object.freeze({
    async content({ sourceId, purpose } = {}) {
      const source = await load(sourceId)
      return source ? evaluateContentPolicy(source, purpose) : unavailable(purpose)
    },
    async media({ sourceId, candidate } = {}) {
      const source = await load(sourceId)
      return source ? evaluateMediaPolicy(source, candidate) : unavailable()
    },
  })
}
