import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { loadOpenApi, runContractChecks } from './openapi-utils.js'
import { runAuthAccountContractFixtures } from './auth-account-fixtures.js'
import { runAdminSourcesContractFixtures } from './admin-sources-fixtures.js'
import { runStep4ContractFixtures } from './step4-fixtures.js'
import { runStep8ContentContractFixtures } from './step8-content-fixtures.js'
import { runStep9IndexingContractFixtures } from './step9-indexing-fixtures.js'

const document = loadOpenApi()
const result = runContractChecks(document)
if (result.failures.length > 0) {
  console.error(result.failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

const generatedSchemaPath = path.resolve('shared/generated/api-schema.js')
const generatedClientPath = path.resolve('shared/generated/api-client.js')
if (!fs.existsSync(generatedSchemaPath) || !fs.existsSync(generatedClientPath)) {
  console.error('Generated contract artifacts are missing; run npm run contract:generate first')
  process.exit(1)
}

const generatedSchema = await import(`${pathToFileURL(generatedSchemaPath).href}?contract-test=1`)
const generatedClient = await import(`${pathToFileURL(generatedClientPath).href}?contract-test=1`)
if (JSON.stringify(generatedSchema.openApiDocument) !== JSON.stringify(document)) {
  console.error('Generated schema drifted from docs/contracts/openapi.json')
  process.exit(1)
}
if (typeof generatedClient.createApiClient !== 'function' || typeof generatedClient.operations?.find !== 'function') {
  console.error('Generated client shape is invalid')
  process.exit(1)
}

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const schemaDocument = { ...document, $id: 'techpulse-openapi' }
ajv.addSchema(schemaDocument)
const validateHealth = ajv.compile({ $ref: 'techpulse-openapi#/components/schemas/HealthResponse' })
const healthFixture = { data: { status: 'ok', timestamp: '2026-08-09T00:00:00.000Z' } }
if (!validateHealth(healthFixture)) {
  console.error(validateHealth.errors)
  process.exit(1)
}

const selection = process.argv.slice(2)
const shouldRunAuthAccount = selection.length === 0 || selection.some((value) => ['auth', 'account'].includes(value))
const authAccountResult = shouldRunAuthAccount ? await runAuthAccountContractFixtures({ document }) : { cases: 0 }
const shouldRunAdminSources = selection.length === 0 || selection.includes('admin-sources') || selection.includes('source-check')
const adminSourcesResult = shouldRunAdminSources ? await runAdminSourcesContractFixtures({ document }) : { cases: 0 }
const shouldRunStep4 = selection.length === 0 || selection.some((value) => ['ingestion-jobs', 'cron'].includes(value))
const step4Result = shouldRunStep4 ? await runStep4ContractFixtures({ document }) : { cases: 0 }
const shouldRunStep8Content = selection.length === 0 || selection.some((value) => ['articles', 'search', 'saved'].includes(value))
const step8ContentResult = shouldRunStep8Content ? await runStep8ContentContractFixtures({ document }) : { cases: 0 }
const shouldRunStep9Indexing = selection.length === 0 || selection.includes('indexing')
const step9IndexingResult = shouldRunStep9Indexing ? await runStep9IndexingContractFixtures({ document }) : { cases: 0 }

console.log(`Contract artifacts valid: ${result.operations.length} operations, health fixture, auth/account runtime fixtures: ${authAccountResult.cases}, admin-sources runtime fixtures: ${adminSourcesResult.cases}, Step 4 runtime fixtures: ${step4Result.cases}, Step 8 content runtime fixtures: ${step8ContentResult.cases}, Step 9 indexing runtime fixtures: ${step9IndexingResult.cases}`)
