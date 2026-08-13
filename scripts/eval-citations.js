import { runCitationEvaluation } from '../server/evals/citations.js'

const report = await runCitationEvaluation()
console.log(JSON.stringify(report))
if (!report.passed) process.exitCode = 1
