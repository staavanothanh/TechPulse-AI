import { describe, expect, it } from 'vitest'
import { validateRestorePlan } from '../../scripts/verify-restore-plan.js'

const NOW = new Date('2026-08-17T08:00:00.000Z')

function validPlan(overrides = {}) {
  return {
    backupId: 'step12-rehearsal-20260817',
    createdAt: '2026-08-17T07:00:00.000Z',
    destroyAt: '2026-08-24T07:00:00.000Z',
    owner: 'project-owner',
    appDump: {
      sourceDatabase: 'techpulse_app',
      readOnlyCredential: true,
      encrypted: true,
      storageClass: 'private-external',
      storageRef: 'external-private:step12-rehearsal-20260817/app',
      sha256: 'a'.repeat(64),
    },
    governanceSidecar: {
      sourceDatabase: 'techpulse_governance',
      readOnly: true,
      encrypted: true,
      storageClass: 'private-external',
      storageRef: 'external-private:step12-rehearsal-20260817/governance',
      sha256: 'b'.repeat(64),
      signingAlgorithm: 'HMAC-SHA-256',
      signingKeyId: 'offline-checkpoint-2026-01',
      checkpointId: 'checkpoint-20260817-01',
    },
    restore: {
      targetDatabase: 'techpulse_app_restore_step12_20260817',
      isolated: true,
      serving: false,
      overwriteGovernance: false,
    },
    ...overrides,
  }
}

describe('restore plan preflight', () => {
  it('accepts a bounded isolated plan but keeps restore and serving claims closed', () => {
    const result = validateRestorePlan(validPlan(), { now: NOW })

    expect(result.planValid).toBe(true)
    expect(result.restoreRehearsalVerified).toBe(false)
    expect(result.serveGate).toBe('closed')
    expect(result.pendingExternalGates).toEqual(expect.arrayContaining([
      'atlas_app_dump_created',
      'governance_sidecar_signature_verified',
      'isolated_restore_completed',
      'restored_governance_reconciled',
      'runtime_secrets_rotated_and_stale_credentials_revoked',
      'backup_destruction_recorded',
    ]))
  })

  it.each([
    ['live app target', { restore: { targetDatabase: 'techpulse_app', isolated: true, serving: false, overwriteGovernance: false } }],
    ['governance overwrite', { restore: { targetDatabase: 'techpulse_app_restore_bad', isolated: true, serving: false, overwriteGovernance: true } }],
    ['serving target', { restore: { targetDatabase: 'techpulse_app_restore_bad', isolated: true, serving: true, overwriteGovernance: false } }],
    ['unbounded retention', { destroyAt: '2026-08-24T07:00:00.001Z' }],
    ['unencrypted dump', { appDump: { ...validPlan().appDump, encrypted: false } }],
    ['missing sidecar checkpoint', { governanceSidecar: { ...validPlan().governanceSidecar, checkpointId: '' } }],
  ])('rejects %s', (_name, override) => {
    const result = validateRestorePlan(validPlan(override), { now: NOW })
    expect(result.planValid).toBe(false)
    expect(result.serveGate).toBe('closed')
  })

  it('rejects secret-bearing fields anywhere in the inventory', () => {
    const plan = validPlan({ appDump: { ...validPlan().appDump, password: 'do-not-store' } })
    const result = validateRestorePlan(plan, { now: NOW })

    expect(result.planValid).toBe(false)
    expect(result.errors).toContain('restore plan contains forbidden secret field: appDump.password')
  })

  it.each(['apiKey', 'mongoUri', 'accessToken', 'hmacKey', 'credentials'])(
    'rejects common secret field name %s',
    (field) => {
      const result = validateRestorePlan(validPlan({ metadata: { [field]: 'redacted' } }), { now: NOW })
      expect(result.planValid).toBe(false)
      expect(result.errors).toContain(`restore plan contains forbidden secret field: metadata.${field}`)
    },
  )

  it.each([
    ['Mongo URI', 'mongodb+srv://restore-user:password@cluster.example/techpulse_app'],
    ['HTTP userinfo', 'https://restore-user:password@example.com/archive'],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'],
    ['API token prefix', 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZXN0b3JlIn0.abcdefghijklmnopqrstuvwxyz0123456789'],
    ['opaque high-entropy secret', 'Q7mV2zP9kR4xN8bT6cH3jL5wF1sD0aY2uI9oE7pK'],
  ])('rejects credential-bearing or secret-like value: %s', (_name, value) => {
    const result = validateRestorePlan(validPlan({ metadata: { note: value } }), { now: NOW })
    expect(result.planValid).toBe(false)
    expect(result.errors).toContain('restore plan contains forbidden secret-like value: metadata.note')
  })

  it.each([
    'D:/private/archive/app',
    'https://storage.example/private/app',
    'external-private:another-backup/app',
    'external-private:step12-rehearsal-20260817/../app',
    'external-private:step12-rehearsal-20260817/app/extra',
  ])('rejects non-opaque app storage reference %s', (storageRef) => {
    const plan = validPlan({ appDump: { ...validPlan().appDump, storageRef } })
    const result = validateRestorePlan(plan, { now: NOW })
    expect(result.planValid).toBe(false)
    expect(result.errors).toContain('app dump storage reference must match the current backup inventory')
  })

  it('requires distinct exact app and governance storage references', () => {
    const plan = validPlan({
      governanceSidecar: {
        ...validPlan().governanceSidecar,
        storageRef: 'external-private:step12-rehearsal-20260817/app',
      },
    })
    const result = validateRestorePlan(plan, { now: NOW })
    expect(result.planValid).toBe(false)
    expect(result.errors).toContain('governance sidecar storage reference must match the current backup inventory')
  })
})
