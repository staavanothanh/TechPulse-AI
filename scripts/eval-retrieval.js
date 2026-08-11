import { runRetrievalEvaluation } from '../server/evals/retrieval.js'

const report = runRetrievalEvaluation()
console.log(JSON.stringify(report))
if (!report.passed) process.exitCode = 1
