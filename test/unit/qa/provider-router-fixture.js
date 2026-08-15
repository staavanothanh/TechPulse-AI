export function createProviderRouterFixture({ routes = {}, providerAdmission } = {}) {
  const makeRoute = (routeId, domain = 'domain-a', model = `${routeId}-model`) => ({ routeId, providerFailureDomainId: domain, model })
  const primary = makeRoute(routes.primary ?? 'primary')
  const fallback = routes.fallback ? makeRoute(routes.fallback, routes.fallbackDomain ?? primary.providerFailureDomainId) : null
  const support = makeRoute(routes.support ?? 'support', routes.supportDomain ?? primary.providerFailureDomainId, 'support-model')
  const invoke = ({ route, admittedInput, workloadId, callback }) => providerAdmission?.run
    ? providerAdmission.run({ routeId: route.routeId, capability: 'zdr-verified', attemptId: 'fixture-attempt', kind: workloadId === 'qa-generation' ? 'answer-primary' : 'answer-support', invoke: () => callback({ route, admittedInput }) })
    : callback({ route, admittedInput })
  return {
    async execute({ workloadId, admittedInput, invoke: callback, validateOutput }) {
      if (workloadId === 'qa-support') {
        const output = await invoke({ route: support, admittedInput, workloadId, callback })
        return { output: validateOutput({ route: support, output, admittedInput }), metadata: { routeId: support.routeId, providerFailureDomainId: support.providerFailureDomainId, fallback: 'none' } }
      }
      try {
        const output = await invoke({ route: primary, admittedInput, workloadId, callback })
        return { output: validateOutput({ route: primary, output, admittedInput }), metadata: { routeId: primary.routeId, providerFailureDomainId: primary.providerFailureDomainId, fallback: 'none' } }
      } catch (error) {
        if (!fallback || !error?.retryable && !['model-retryable', 'provider-retryable'].includes(error?.failureClass)) throw error
        const output = await invoke({ route: fallback, admittedInput, workloadId, callback })
        return { output: validateOutput({ route: fallback, output, admittedInput }), metadata: { routeId: fallback.routeId, providerFailureDomainId: fallback.providerFailureDomainId, fallback: fallback.providerFailureDomainId === primary.providerFailureDomainId ? 'model' : 'provider' } }
      }
    },
  }
}
