import { describe, expect, it } from 'vitest'
import { winningPlanStages } from '../../../scripts/query-plan.js'

describe('Mongo query-plan verification', () => {
  it('checks winning plans across aggregate branches without counting rejected candidates', () => {
    const explain = {
      stages: [
        {
          $cursor: {
            queryPlanner: {
              winningPlan: { stage: 'GROUP', inputStage: { stage: 'IXSCAN' } },
              rejectedPlans: [{ stage: 'SORT', inputStage: { stage: 'FETCH' } }],
            },
          },
        },
        {
          $unionWith: {
            pipeline: [
              {
                $cursor: {
                  queryPlanner: {
                    winningPlan: { stage: 'COUNT_SCAN' },
                    rejectedPlans: [{ stage: 'COLLSCAN' }],
                  },
                },
              },
            ],
          },
        },
      ],
    }

    expect(winningPlanStages(explain)).toEqual(['GROUP', 'IXSCAN', 'COUNT_SCAN'])
  })
})
