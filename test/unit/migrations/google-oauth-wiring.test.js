import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RUNTIME_SCHEMA_GENERATIONS } from '../../../server/bootstrap/schema-readiness.js'

describe('Google OAuth migration and release wiring', () => {
  it('registers a separate release-attested schema scope', () => {
    expect(RUNTIME_SCHEMA_GENERATIONS['google-oauth']).toBe('google-oauth-v1')
  })

  it('wires db-migrate and db-verify without editing deployed migrations', () => {
    const migrate = readFileSync(new URL('../../../scripts/db-migrate.js', import.meta.url), 'utf8')
    const verify = readFileSync(new URL('../../../scripts/db-verify.js', import.meta.url), 'utf8')
    expect(migrate).toContain("'google-oauth'")
    expect(migrate).toContain('runGoogleOAuthMigration')
    expect(verify).toContain("'google-oauth'")
    expect(verify).toContain('GOOGLE_OAUTH_COLLECTIONS')
    expect(migrate).toContain('preservedSourcePolicyAuditValidator')
    expect(migrate).toContain('withGoogleOAuthAuditCompatibility(context.db, auditValidator ? { auditValidator } : {})')
    expect(migrate).toContain('runGoogleOAuthMigration({ db: context.db, ...(auditValidator ? { auditValidator } : {}) })')
  })
})
