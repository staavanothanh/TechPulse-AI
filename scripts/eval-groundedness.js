import { runGroundednessEvaluation } from '../server/evals/groundedness.js'

const report = runGroundednessEvaluation()
console.log(JSON.stringify(report))
if (!report.passed) process.exitCode = 1
