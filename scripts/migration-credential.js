/**
 * Schema migrations always run with the separately scoped operator
 * credential.  The runtime credential is intentionally not selected here;
 * it is reserved for application reads and the db-verify capability probe.
 */
export function migrationUriEnvName(_target, environment = process.env) {
  const value = environment?.MONGODB_OPERATOR_URI_ENV
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('MongoDB operator URI env is required for migrations')
  }
  return value.trim()
}
