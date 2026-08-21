import { describe, expect, it } from 'vitest'
import { classifyTopics } from '../../../server/domain/article/topic-classifier.js'

describe('article topic classifier', () => {
  it('maps connector metadata and article text to the public topic taxonomy', () => {
    expect(
      classifyTopics({
        titleOriginal: 'Cloud data infrastructure for modern teams',
        excerptOriginal: 'A Kubernetes pipeline stores analytics in a database.',
      }),
    ).toEqual(['devops', 'dữ liệu'])
  })

  it('preserves explicit topics and normalizes connector aliases', () => {
    expect(
      classifyTopics({
        values: ['cs.AI', 'Dev Ops', 'Safety'],
        titleOriginal: 'A research note',
      }),
    ).toEqual(['ai', 'devops', 'safety'])
  })
})
