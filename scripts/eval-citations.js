import { runCitationEvaluation } from '../server/evals/citations.js'

const report = runCitationEvaluation()
console.log(JSON.stringify(report))
if (!report.passed) process.exitCode = 1
