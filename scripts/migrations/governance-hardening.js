import { GOVERNANCE_AUDIT_VALIDATOR } from './governance-audit.js'

export const GOVERNANCE_HARDENING_INDEXES = Object.freeze({
  takedownRequests: Object.freeze([
    {
      name: 'takedown_cleanup_due',
      key: { status: 1, 'completion.historicalChatCitationsRedacted': 1, updatedAt: 1, _id: 1 },
    },
  ]),
})

export function buildGovernanceHardeningMigration({ dryRun = false } = {}) {
  return [
    {
      type: 'collMod',
      collection: 'adminAuditLogs',
      validator: GOVERNANCE_AUDIT_VALIDATOR,
      validationLevel: 'strict',
      validationAction: 'error',
      ...(dryRun ? { dryRun: true } : {}),
    },
    ...GOVERNANCE_HARDENING_INDEXES.takedownRequests.map((index) => ({
      type: 'createIndex',
      collection: 'takedownRequests',
      ...index,
      ...(dryRun ? { dryRun: true } : {}),
    })),
  ]
}

export async function runGovernanceHardeningMigration({ db, dryRun = false } = {}) {
  const plan = buildGovernanceHardeningMigration({ dryRun })
  if (dryRun) return plan
  if (!db || typeof db.collection !== 'function') throw new Error('MongoDB database is required')
  for (const operation of plan) {
    if (operation.type === 'collMod')
      await db.command({
        collMod: operation.collection,
        validator: operation.validator,
        validationLevel: operation.validationLevel,
        validationAction: operation.validationAction,
      })
    else
      await db
        .collection(operation.collection)
        .createIndex(operation.key, { ...(operation.options ?? {}), name: operation.name })
  }
  return plan
}
