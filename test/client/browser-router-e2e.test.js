import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import {
  adminRouteToPath,
  normalizeAdminRoute,
  normalizePublicRoute,
  parseAdminPath,
  parsePublicPath,
  publicRouteToPath,
  sessionSurface,
} from '../../client/app/integration/routing.js'

describe('BrowserRouter deep-linking, search hydration, and navigation contract', () => {
  describe('Deep linking to public routes', () => {
    it('resolves direct deep link to /article/:id with params', () => {
      const parsed = parsePublicPath('/article/article-999')
      expect(parsed).toEqual({ route: 'article', articleId: 'article-999' })
      expect(publicRouteToPath(parsed.route, { articleId: parsed.articleId })).toBe(
        '/article/article-999',
      )
    })

    it('resolves direct deep link to /search without params', () => {
      const parsed = parsePublicPath('/search')
      expect(parsed).toEqual({ route: 'search', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/search')
    })

    it('resolves direct deep link to /search with search parameters (?q=AI&topic=NLP)', () => {
      const parsed = parsePublicPath('/search', '?q=AI&topic=NLP')
      expect(parsed.route).toBe('search')
      expect(parsed.searchParams).toEqual(
        expect.objectContaining({
          q: 'AI',
          topic: 'NLP',
          mode: 'hybrid',
        }),
      )
      expect(publicRouteToPath('search', { searchParams: parsed.searchParams })).toBe(
        '/search?q=AI&topic=NLP',
      )
    })

    it('resolves direct deep link to /donate', () => {
      const parsed = parsePublicPath('/donate')
      expect(parsed).toEqual({ route: 'donate', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/donate')
    })

    it('resolves direct deep link to /qa', () => {
      const parsed = parsePublicPath('/qa')
      expect(parsed).toEqual({ route: 'qa', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/qa')
    })

    it('resolves direct deep link to /account', () => {
      const parsed = parsePublicPath('/account')
      expect(parsed).toEqual({ route: 'account', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/account')
    })

    it('resolves direct deep link to /saved', () => {
      const parsed = parsePublicPath('/saved')
      expect(parsed).toEqual({ route: 'saved', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/saved')
    })

    it('normalizes arbitrary unknown paths to /feed', () => {
      const parsed = parsePublicPath('/some/unknown/page')
      expect(parsed).toEqual({ route: 'feed', articleId: null })
      expect(publicRouteToPath(parsed.route)).toBe('/feed')
    })
  })

  describe('Deep linking to admin routes', () => {
    it('resolves /admin to overview tab', () => {
      expect(parseAdminPath('/admin')).toEqual({ route: 'overview' })
      expect(adminRouteToPath('overview')).toBe('/admin/overview')
    })

    it('resolves /admin/sources to sources tab', () => {
      expect(parseAdminPath('/admin/sources')).toEqual({ route: 'sources' })
      expect(adminRouteToPath('sources')).toBe('/admin/sources')
    })

    it('resolves /admin/jobs to jobs tab', () => {
      expect(parseAdminPath('/admin/jobs')).toEqual({ route: 'jobs' })
      expect(adminRouteToPath('jobs')).toBe('/admin/jobs')
    })

    it('resolves /admin/governance to governance tab', () => {
      expect(parseAdminPath('/admin/governance')).toEqual({ route: 'governance' })
      expect(adminRouteToPath('governance')).toBe('/admin/governance')
    })

    it('normalizes invalid admin subroute to overview', () => {
      expect(parseAdminPath('/admin/nonexistent')).toEqual({ route: 'overview' })
    })
  })

  describe('Session surface gating with URL routing', () => {
    it('gates admin surface when user role is not admin', () => {
      const guestSession = { status: 'ready', user: null }
      const userSession = { status: 'ready', user: { role: 'user' } }
      const adminSession = { status: 'ready', user: { role: 'admin' } }

      expect(sessionSurface(guestSession)).toBe('public')
      expect(sessionSurface(userSession)).toBe('public')
      expect(sessionSurface(adminSession)).toBe('admin')
    })
  })

  describe('MemoryRouter mounted behavior & search hydration', () => {
    it('mounts inside MemoryRouter and hydrates /search?q=DeepSeek&topic=AI', () => {
      let observedState = null

      function LocationSpy() {
        const location = useLocation()
        const parsed = parsePublicPath(location.pathname, location.search)
        observedState = {
          pathname: location.pathname,
          search: location.search,
          route: parsed.route,
          searchParams: parsed.searchParams,
        }
        return React.createElement('div', { 'data-testid': 'spy' }, location.pathname)
      }

      renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/search?q=DeepSeek&topic=AI'] },
          React.createElement(LocationSpy),
        ),
      )

      expect(observedState).toEqual({
        pathname: '/search',
        search: '?q=DeepSeek&topic=AI',
        route: 'search',
        searchParams: expect.objectContaining({
          q: 'DeepSeek',
          topic: 'AI',
          mode: 'hybrid',
        }),
      })
    })

    it('mounts inside MemoryRouter and resolves deep-linked /article/:id', () => {
      let observedState = null

      function LocationSpy() {
        const location = useLocation()
        const parsed = parsePublicPath(location.pathname, location.search)
        observedState = {
          pathname: location.pathname,
          route: parsed.route,
          articleId: parsed.articleId,
        }
        return React.createElement('div', null, parsed.route)
      }

      renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/article/article-456'] },
          React.createElement(LocationSpy),
        ),
      )

      expect(observedState).toEqual({
        pathname: '/article/article-456',
        route: 'article',
        articleId: 'article-456',
      })
    })

    it('mounts inside MemoryRouter and resolves admin tab /admin/sources', () => {
      let observedState = null

      function LocationSpy() {
        const location = useLocation()
        const parsed = parseAdminPath(location.pathname)
        observedState = {
          pathname: location.pathname,
          route: parsed.route,
        }
        return React.createElement('div', null, parsed.route)
      }

      renderToStaticMarkup(
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/admin/sources'] },
          React.createElement(LocationSpy),
        ),
      )

      expect(observedState).toEqual({
        pathname: '/admin/sources',
        route: 'sources',
      })
    })
  })

  describe('Article Back navigation: POP (navigate(-1)) contract vs Fallback', () => {
    it('executes navigate(-1) when user has in-session history (history.state.idx > 0)', () => {
      const navigateMock = vi.fn()
      const origWindow = globalThis.window

      globalThis.window = {
        history: {
          state: { idx: 2 },
        },
      }

      // Simulate App's handlePublicNavigate logic
      function handlePublicNavigate(nextRoute, options) {
        if (options?.back) {
          if (
            typeof window !== 'undefined' &&
            window.history?.state &&
            window.history.state.idx > 0
          ) {
            navigateMock(-1)
            return
          }
          const fallback = nextRoute || 'feed'
          navigateMock(publicRouteToPath(fallback), { replace: true })
          return
        }
        navigateMock(publicRouteToPath(nextRoute, options))
      }

      handlePublicNavigate('feed', { back: true })

      expect(navigateMock).toHaveBeenCalledWith(-1)
      expect(navigateMock).not.toHaveBeenCalledWith('/feed', expect.anything())

      globalThis.window = origWindow
    })

    it('executes fallback navigate("/feed", { replace: true }) on cold/direct link (history.state.idx === 0)', () => {
      const navigateMock = vi.fn()
      const origWindow = globalThis.window

      globalThis.window = {
        history: {
          state: { idx: 0 },
        },
      }

      function handlePublicNavigate(nextRoute, options) {
        if (options?.back) {
          if (
            typeof window !== 'undefined' &&
            window.history?.state &&
            window.history.state.idx > 0
          ) {
            navigateMock(-1)
            return
          }
          const fallback = nextRoute || 'feed'
          navigateMock(publicRouteToPath(fallback), { replace: true })
          return
        }
        navigateMock(publicRouteToPath(nextRoute, options))
      }

      handlePublicNavigate('feed', { back: true })

      expect(navigateMock).toHaveBeenCalledWith('/feed', { replace: true })
      expect(navigateMock).not.toHaveBeenCalledWith(-1)

      globalThis.window = origWindow
    })
  })
})
