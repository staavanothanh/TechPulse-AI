import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validateProviderConfiguration } from '../../../server/ai/provider-registry.js'

const TEMPLATE_PATH = new URL('../../../.env.example', import.meta.url)
// Fixed clock inside the reviewed evidence window so the assertion is deterministic.
const NOW = new Date('2026-09-01T00:00:00.000Z')
const VENDOR_ECHOED_SUMMARY_MODEL = 'deepseek-flash'
const DEEPSEEK_ROUTE_IDS = ['summary-primary', 'qa-primary', 'qa-support']

async function shippedProviderGraph() {
  const source = await readFile(TEMPLATE_PATH, 'utf8')
  // The value is a multi-line single-quoted literal. JSON contains double quotes
  // only, so the terminating quote is the first single quote before a newline.
  const match = source.match(/PROVIDER_ADMISSION_DOMAINS_JSON='([\s\S]*?)'\r?\n/)
  expect(
    match,
    'PROVIDER_ADMISSION_DOMAINS_JSON literal must be present in .env.example',
  ).not.toBeNull()
  return JSON.parse(match[1])
}

describe('shipped .env.example provider graph', () => {
  it('validates as a complete ADR-0013 graph that a fresh environment can boot', async () => {
    const graph = await shippedProviderGraph()

    expect(() =>
      validateProviderConfiguration(graph, {
        now: NOW,
        credentialEnvNames: new Set(['DEEPSEEK_API_KEY', 'EMBEDDING_API_KEY']),
      }),
    ).not.toThrow()
  })

  it('briefs every DeepSeek route to tolerate the vendor-echoed model identifier', async () => {
    const graph = await shippedProviderGraph()
    const deepseekRoutes = graph.routes.filter((route) =>
      DEEPSEEK_ROUTE_IDS.includes(route.routeId),
    )

    expect(deepseekRoutes.map((route) => route.routeId).sort()).toEqual(
      [...DEEPSEEK_ROUTE_IDS].sort(),
    )
    for (const route of deepseekRoutes) {
      // The reviewed evidence binding stays on the canonical identifier.
      expect(route.model).toBe('deepseek-v4-flash')
      // The alias list is the additive echo tolerance, so a mismatch cannot terminal-fail.
      expect(route.acceptedModelIds).toContain(VENDOR_ECHOED_SUMMARY_MODEL)
    }
  })
})
