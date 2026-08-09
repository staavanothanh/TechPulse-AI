export function preferenceDraftForUser(user) {
  return Array.isArray(user?.topicPreferences) ? [...user.topicPreferences] : []
}

export function validateTopicPreferences(value) {
  if (!Array.isArray(value)) return { valid: false, topics: [] }
  const topics = value.map((topic) => typeof topic === 'string' ? topic.trim() : topic).filter(Boolean)
  if (topics.length > 20 || new Set(topics).size !== topics.length || topics.some((topic) => typeof topic !== 'string' || topic.length > 64)) {
    return { valid: false, topics: [] }
  }
  return { valid: true, topics }
}

export function bootstrapSessionFailure(error) {
  if (error?.status === 401) return { status: 'ready', user: null, csrfToken: null, error: null }
  return {
    status: 'error',
    user: null,
    csrfToken: null,
    error: error?.message ?? 'Không thể khôi phục phiên. Hãy thử lại.',
  }
}

export function sessionExpiredNotice(error) {
  return error?.status === 401 ? SESSION_EXPIRED_MESSAGE : null
}
export const SESSION_EXPIRED_MESSAGE = 'Phiên đăng nhập không còn hợp lệ. Vui lòng đăng nhập lại.'
