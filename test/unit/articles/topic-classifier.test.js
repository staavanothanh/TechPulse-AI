import { describe, expect, it } from 'vitest'
import {
  classifyTopics,
  classifyCanonicalTopicIds,
} from '../../../server/domain/article/topic-classifier.js'

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

  it('classifies canonical topic IDs alongside legacy topics without inventing IDs for unknown values', () => {
    const canonical = classifyCanonicalTopicIds({
      values: ['cs.AI', 'Dev Ops', 'Safety'],
      titleOriginal: 'A research note on robotics and autonomous agents',
      excerptOriginal: 'An AI Agent uses tool calling and ROS2 robot control.',
    })

    expect(canonical).toContain('ai-ml')
    expect(canonical).toContain('devops-cloud')
    expect(canonical).toContain('ai-agent')
    expect(canonical).toContain('robotics')
    expect(canonical).not.toContain('safety')
    expect(Object.isFrozen(canonical)).toBe(true)
  })

  it('handles security/bảo mật, data/database, and javascript aliases properly', () => {
    expect(
      classifyTopics({
        values: ['security', 'database', 'javascript'],
      }),
    ).toEqual(['bảo mật', 'dữ liệu', 'javascript'])

    const canonical = classifyCanonicalTopicIds({
      values: ['security', 'database', 'javascript'],
    })
    expect(canonical).toContain('security')
    expect(canonical).toContain('computer-science')
    expect(canonical).toContain('software-engineering')
  })
})
