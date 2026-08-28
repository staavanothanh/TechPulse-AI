import { describe, expect, it } from 'vitest'
import {
  adminRouteToPath,
  parseAdminPath,
  parsePublicPath,
  publicRouteToPath,
} from '../../client/app/integration/routing.js'

describe('URL routing and bidirectional mapping', () => {
  it('parses public root and feed paths to feed route', () => {
    expect(parsePublicPath('/')).toEqual({ route: 'feed', articleId: null })
    expect(parsePublicPath('')).toEqual({ route: 'feed', articleId: null })
    expect(parsePublicPath('/feed')).toEqual({ route: 'feed', articleId: null })
    expect(parsePublicPath('/feed/')).toEqual({ route: 'feed', articleId: null })
  })

  it('parses standard public paths correctly', () => {
    expect(parsePublicPath('/search')).toEqual({ route: 'search', articleId: null })
    expect(parsePublicPath('/saved')).toEqual({ route: 'saved', articleId: null })
    expect(parsePublicPath('/qa')).toEqual({ route: 'qa', articleId: null })
    expect(parsePublicPath('/account')).toEqual({ route: 'account', articleId: null })
    expect(parsePublicPath('/donate')).toEqual({ route: 'donate', articleId: null })
  })

  it('parses search query parameters from search string', () => {
    const parsed = parsePublicPath('/search', '?q=AI&topic=Machine%20Learning')
    expect(parsed).toEqual({
      route: 'search',
      articleId: null,
      searchParams: {
        q: 'AI',
        topic: 'Machine Learning',
        mode: 'hybrid',
        sourceId: '',
        publishedAfter: '',
        publishedBefore: '',
      },
    })
  })

  it('parses article paths with decoded article ID', () => {
    expect(parsePublicPath('/article/art-123')).toEqual({ route: 'article', articleId: 'art-123' })
    expect(parsePublicPath('/article/tag%2Fspecial')).toEqual({
      route: 'article',
      articleId: 'tag/special',
    })
    expect(parsePublicPath('/article')).toEqual({ route: 'article', articleId: null })
  })

  it('falls back to feed for unknown public paths', () => {
    expect(parsePublicPath('/unknown-path')).toEqual({ route: 'feed', articleId: null })
    expect(parsePublicPath('/some/nested/page')).toEqual({ route: 'feed', articleId: null })
  })

  it('converts public routes to clean canonical paths', () => {
    expect(publicRouteToPath('feed')).toBe('/feed')
    expect(publicRouteToPath('search')).toBe('/search')
    expect(publicRouteToPath('saved')).toBe('/saved')
    expect(publicRouteToPath('qa')).toBe('/qa')
    expect(publicRouteToPath('account')).toBe('/account')
    expect(publicRouteToPath('donate')).toBe('/donate')
    expect(publicRouteToPath('article', { articleId: 'item-1' })).toBe('/article/item-1')
    expect(publicRouteToPath('article', { articleId: 'slug with spaces' })).toBe(
      '/article/slug%20with%20spaces',
    )
    expect(
      publicRouteToPath('search', { searchParams: { q: 'AI', topic: 'Tech' } }),
    ).toBe('/search?q=AI&topic=Tech')
    expect(publicRouteToPath('unknown')).toBe('/feed')
  })

  it('parses admin paths and validates subroutes', () => {
    expect(parseAdminPath('/admin')).toEqual({ route: 'overview' })
    expect(parseAdminPath('/admin/')).toEqual({ route: 'overview' })
    expect(parseAdminPath('/admin/overview')).toEqual({ route: 'overview' })
    expect(parseAdminPath('/admin/jobs')).toEqual({ route: 'jobs' })
    expect(parseAdminPath('/admin/sources')).toEqual({ route: 'sources' })
    expect(parseAdminPath('/admin/articles')).toEqual({ route: 'articles' })
    expect(parseAdminPath('/admin/governance')).toEqual({ route: 'governance' })
    expect(parseAdminPath('/admin/users')).toEqual({ route: 'users' })
    expect(parseAdminPath('/admin/audit')).toEqual({ route: 'audit' })
    expect(parseAdminPath('/admin/account')).toEqual({ route: 'account' })
    expect(parseAdminPath('/admin/deletions')).toEqual({ route: 'deletions' })
    expect(parseAdminPath('/admin/invalid-subroute')).toEqual({ route: 'overview' })
    expect(parseAdminPath('/not-admin')).toEqual({ route: 'overview' })
  })

  it('converts admin routes to clean canonical paths', () => {
    expect(adminRouteToPath('overview')).toBe('/admin/overview')
    expect(adminRouteToPath('sources')).toBe('/admin/sources')
    expect(adminRouteToPath('jobs')).toBe('/admin/jobs')
    expect(adminRouteToPath('invalid')).toBe('/admin/overview')
  })
})
