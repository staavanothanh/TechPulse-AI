import {
  classifyLegacyTopics,
  classifyTopicIds,
  resolveTopic,
  expandTopicSelection,
  canonicalTopicIds,
  canonicalPreferenceIds,
  topicLabel,
} from '../../../shared/topic-catalog.js'


export function classifyTopics({ values = [], titleOriginal = '', excerptOriginal = '' } = {}) {
  return classifyLegacyTopics({ values, titleOriginal, excerptOriginal })
}

export function classifyCanonicalTopicIds({ values = [], titleOriginal = '', excerptOriginal = '' } = {}) {
  return classifyTopicIds({ values, titleOriginal, excerptOriginal })
}

export {
  classifyTopicIds,
  resolveTopic,
  expandTopicSelection,
  canonicalTopicIds,
  canonicalPreferenceIds,
  topicLabel,
}
