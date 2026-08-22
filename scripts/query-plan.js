function appendPlanStages(plan, stages) {
  if (!plan || typeof plan !== 'object') return
  if (typeof plan.stage === 'string') stages.push(plan.stage)
  for (const value of Object.values(plan)) appendPlanStages(value, stages)
}

export function winningPlanStages(explain) {
  const stages = []
  const visit = (value) => {
    if (!value || typeof value !== 'object') return
    if (value.queryPlanner) {
      appendPlanStages(value.queryPlanner.winningPlan, stages)
      for (const [key, child] of Object.entries(value)) {
        if (key !== 'queryPlanner') visit(child)
      }
      return
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(explain)
  return stages
}
