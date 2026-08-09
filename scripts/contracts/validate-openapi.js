import SwaggerParser from '@apidevtools/swagger-parser'
import { loadOpenApi, runContractChecks } from './openapi-utils.js'

const document = loadOpenApi()
const result = runContractChecks(document)
if (result.failures.length > 0) {
  console.error(result.failures.map((failure) => `- ${failure}`).join('\n'))
  process.exit(1)
}

try {
  await SwaggerParser.validate(document, { validate: { spec: true } })
} catch (error) {
  console.error(`OpenAPI validation failed: ${error.message}`)
  process.exit(1)
}

console.log(`OpenAPI 3.1 valid: ${result.operations.length} operations, ${result.remoteRefs.length} remote refs`)
