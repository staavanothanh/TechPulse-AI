import { parentPort } from 'node:worker_threads'
import { parseXmlDocument } from './parse-work.js'

if (!parentPort) throw new Error('RSS parser worker requires a parent port')

parentPort.on('message', ({ xml, limits, delayMs }) => {
  try {
    const nodes = parseXmlDocument(xml, limits, delayMs)
    parentPort.postMessage({ ok: true, nodes })
  } catch {
    parentPort.postMessage({ ok: false })
  }
})
