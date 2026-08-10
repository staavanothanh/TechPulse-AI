const SOURCE_RESPONSE_FIELDS = [
  'id',
  'name',
  'sourceKey',
  'publisherName',
  'domain',
  'connectorType',
  'accessMethod',
  'authorityTier',
  'connectorConfig',
  'operationalStatus',
  'licenseStatus',
  'llmInputScope',
  'storageScope',
  'mediaPolicy',
  'attributionRequired',
  'attributionText',
  'termsUrl',
  'licenseUrl',
  'evidenceNote',
  'reviewedAt',
  'reviewedBy',
  'policyVersion',
  'reconciliation',
  'technicalCheck',
  'health',
  'createdAt',
  'updatedAt'
]

export function serializeSource(source) {
  return Object.fromEntries(SOURCE_RESPONSE_FIELDS
    .filter((field) => source[field] !== undefined)
    .map((field) => [field, source[field]]))
}
