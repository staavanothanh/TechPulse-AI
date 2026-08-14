import { INDEXING_JOB_AUDIT_VALIDATOR } from './indexing-jobs.js'

const noStateTransition = Object.freeze({ stateTransition: { $exists: false } })

const articleAuditRules = Object.freeze([
  { action: 'article_status_changed', targetType: 'article', reasonCode: 'article_status_changed', changedFields: ['status'] },
  { action: 'article_topics_changed', targetType: 'article', reasonCode: 'article_topics_changed', changedFields: ['topics'], ...noStateTransition },
  { action: 'article_media_visibility_changed', targetType: 'article', reasonCode: 'article_media_visibility_changed', changedFields: ['leadMediaStatus'], ...noStateTransition },
  { action: 'duplicate_merge_confirmed', targetType: 'article', reasonCode: 'duplicate_merge_confirmed', changedFields: ['provenance', 'status'], ...noStateTransition },
])

const takedownAuditRules = Object.freeze([
  { action: 'takedown_received', targetType: 'takedown-request', reasonCode: 'takedown_received', changedFields: ['status'], ...noStateTransition },
  { action: 'takedown_review_started', targetType: 'takedown-request', reasonCode: 'takedown_review_started', changedFields: ['status'], ...noStateTransition },
  { action: 'takedown_approved', targetType: 'takedown-request', reasonCode: 'takedown_approved', changedFields: ['status'], ...noStateTransition },
  { action: 'takedown_rejected', targetType: 'takedown-request', reasonCode: 'takedown_rejected', changedFields: ['status'], ...noStateTransition },
  { action: 'takedown_completed', targetType: 'takedown-request', reasonCode: 'takedown_completed', changedFields: ['status', 'completion'], ...noStateTransition },
])

const accountDeletionAuditRules = Object.freeze([
  { action: 'account_deletion_requested', targetType: 'account-deletion', reasonCode: 'account_deletion_requested', changedFields: ['status'], ...noStateTransition },
  { action: 'account_deletion_retry_requested', targetType: 'account-deletion', reasonCode: 'account_deletion_retry_requested', changedFields: ['status', 'attempt'], ...noStateTransition },
  { action: 'workflow_completed', targetType: 'account-deletion', reasonCode: 'workflow_completed', changedFields: ['status', 'completion'], ...noStateTransition },
  { action: 'workflow_failed', targetType: 'account-deletion', reasonCode: 'workflow_failed', changedFields: ['status', 'completion', 'error'], ...noStateTransition },
])

const baseParts = INDEXING_JOB_AUDIT_VALIDATOR.$and
export const GOVERNANCE_AUDIT_VALIDATOR = Object.freeze({
  $and: [
    { $or: [...baseParts[0].$or, ...articleAuditRules, ...takedownAuditRules, ...accountDeletionAuditRules] },
    baseParts[1],
  ],
})

export const GOVERNANCE_AUDIT_INDEXES = Object.freeze([
  { name: 'audit_event_unique', key: { eventId: 1 }, options: { unique: true } },
  { name: 'audit_ip_purge', key: { ipHmacPurgeAfter: 1, _id: 1 }, options: { partialFilterExpression: { ipHmacPurgeAfter: { $exists: true } } } },
])
