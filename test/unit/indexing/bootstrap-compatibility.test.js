import { describe, expect, it } from 'vitest'
import { assertAuthCoreReady } from '../../../server/bootstrap/auth.js'
import { AUTH_CORE_COLLECTIONS, AUTH_CORE_INDEXES } from '../../../scripts/migrations/auth-core.js'
import { INDEXING_JOB_AUDIT_VALIDATOR } from '../../../scripts/migrations/indexing-jobs.js'

function authContext() {
  const collections = Object.entries(AUTH_CORE_COLLECTIONS).map(([name, definition]) => ({
    name,
    options: { validator: name === 'adminAuditLogs' ? INDEXING_JOB_AUDIT_VALIDATOR : definition.validator, validationLevel: 'strict', validationAction: 'error' },
  }))
  return {
    db: {
      listCollections: () => ({ toArray: async () => collections }),
      collection: (name) => ({ indexes: async () => AUTH_CORE_INDEXES[name].map((index) => ({ name: index.name, key: index.key, ...(index.options ?? {}) })) }),
    },
  }
}

describe('Step 9 bootstrap audit revision compatibility', () => {
  it('keeps auth-core ready after indexing extends the append-only audit validator', async () => {
    await expect(assertAuthCoreReady(authContext())).resolves.toBeUndefined()
  })
})
