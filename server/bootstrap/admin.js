import { MongoAdminRepository } from '../repositories/mongo/admin-repository.js'
import { createAdminGovernanceService } from '../application/admin/service.js'
import { MongoTakedownRepository } from '../repositories/mongo/takedown-repository.js'
import { MongoAccountDeletionRepository } from '../repositories/mongo/account-deletion-repository.js'
import { createAccountDeletionService } from '../application/account-deletion/service.js'
import { createTakedownService } from '../application/takedowns/service.js'
import { assertGovernanceReady } from './governance-readiness.js'

export async function createConfiguredAdminGovernanceService({ context, rateLimitAdmission, quotaKeyring, governanceKeyring, governanceDb, verifySchema = assertGovernanceReady } = {}) {
  if (!context) throw new Error('Mongo context is required')
  await verifySchema(context, { governanceDb })
  const repository = new MongoAdminRepository(context)
  const resolvedGovernanceDb = governanceDb ?? context.client?.db?.('techpulse_governance')
  const takedownRepository = new MongoTakedownRepository({ ...context, governanceDb: resolvedGovernanceDb, governanceKeyring })
  if (!quotaKeyring || !governanceKeyring) throw new Error('Quota and governance keyrings are required')
  const accountDeletionRepository = new MongoAccountDeletionRepository({ ...context, quotaKeyring, governanceKeyring, governanceDb: resolvedGovernanceDb })
  const accountDeletionService = createAccountDeletionService({ repository: accountDeletionRepository, rateLimitAdmission, clock: context.now })
  const takedownWorkflowService = createTakedownService({ repository: takedownRepository, rateLimitAdmission, clock: context.now })
  const takedownService = {
    async listTakedownRequests({ auth, query }) { return takedownWorkflowService.list({ auth, query }) },
    async getTakedownRequest({ auth, takedownRequestId }) { return takedownWorkflowService.get({ auth, takedownRequestId }) },
    async createTakedownRequest({ auth, input, request }) { return takedownWorkflowService.create({ auth, input, request }) },
    async updateTakedownRequest({ auth, takedownRequestId, input, request }) { return takedownWorkflowService.update({ auth, takedownRequestId, input, request }) },
    async listAccountDeletionRequests({ auth, query }) { return accountDeletionService.list({ auth, query }).then((result) => ({ requests: result.data, hasNext: result.hasNext, nextCursor: result.nextCursor })) },
    async getAccountDeletionRequest({ auth, deletionRequestId }) { return accountDeletionService.get({ auth, deletionRequestId }) },
    async retryAccountDeletionRequest({ auth, deletionRequestId, input, idempotencyKey, request }) { return accountDeletionService.retry({ auth, deletionRequestId, reasonCode: input.reasonCode, idempotencyKey, request }) },
  }
  const adminGovernanceService = createAdminGovernanceService({ repository, rateLimitAdmission })
  return { adminGovernanceService: Object.freeze({ ...adminGovernanceService, ...takedownService }), accountDeletionService, adminRepository: repository }
}
